/**
 * 上游 HTTP/2 通道（零依赖，用 Node 内置的 `node:http2`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么必须有它（2026-09-14 实测，不是猜的）
 * ─────────────────────────────────────────────────────────────────────
 * 同一个 151 字节的请求打给 `api.agnes-ai.cn`，同一分钟内交叉对比：
 *
 *   curl --http2      0.18 0.13 0.35 0.14 0.16 0.14 0.14 0.35     ← 稳
 *   curl --http1.1    0.55 1.57 0.00 1.25 0.63 0.54 0.68 [20.26]  ← 慢且抖
 *   node undici(h1.1) 0.57 1.06 1.12 2.44 2.56 1.25 0.55 [7.58]   ← 同病
 *
 * 再用 `diagnostics_channel` 看 undici 内部阶段：卡的是
 * `connected=76ms → headers=54494ms` —— **建连一直 60~130ms 正常，全是等上游响应头**。
 * 又试过 `connection: close`（排除 keep-alive 死连接）、`accept-encoding`、自定义 UA
 * （都排除）—— 结论：**Agnes 的 HTTP/1.1 路径慢，HTTP/2 快**。
 * 而 Node 的 `fetch`(undici) 只支持 HTTP/1.1，没有 h2。
 *
 * 这条通道对客户那类大请求同样重要：它把"首字节 12~28 秒 + 偶发 60 秒超时重试"
 * 的肥尾直接消掉。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 设计：伪装成 fetch
 * ─────────────────────────────────────────────────────────────────────
 * 返回一个**真正的 `Response` 对象**（`node:stream` 的 Readable 通过 `Readable.toWeb`
 * 变成 web ReadableStream）。这样调用方 `client.ts` 里的
 * `res.body` / `res.status` / `res.headers` / `res.text()` / `firstChunkWithin` /
 * `readBodyWithStall` / `filterUpstreamHeaders` **全都不用改**。
 *
 * 会话按 origin 复用（h2 天然多路复用）：省掉每次请求的 TCP+TLS 握手，
 * 也避免 h1.1 那条慢路径。会话 `unref()`，不拦进程退出。
 */

import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { Readable } from 'node:stream';

/**
 * 正在建立中的会话（key → Promise）。
 *
 * 没有它的话：冷启动/换 IP 后一波并发会**各建一条会话**（审计 P1-5 实测 10 并发 → 10 条
 * TCP/h2 连接，且全部不关闭）。有了它，同一时刻的并发只建一条，其余等它。
 */
const pending = new Map<string, Promise<ClientHttp2Session>>();
/** key → 最后一次使用的时刻，供空闲回收 */
const lastUsed = new Map<string, number>();

/** 空闲多久就关掉会话。h2 的价值是多路复用，但一条长期没人用的连接只是泄漏。 */
const IDLE_CLOSE_MS = 120_000;

/** 供测试：把某个 origin 标记成不可用 */
export function markH2BrokenForTest(origin: string, servername?: string): void {
  broken.set(servername ? `${origin}|${servername}` : origin, Date.now());
}

/** origin → 已建立的会话 */
const sessions = new Map<string, ClientHttp2Session>();
/**
 * 已经判定"这个 origin 用不了 h2"（连不上 / 不支持 ALPN）→ key → 标记时刻。
 *
 * ⚠️ **必须带 TTL**（2026-09-14 审计 P1-4）：原来是个只增不减的 Set，
 * 一次瞬时握手失败就会让这条上游**在本进程余生里永久降级到 h1.1** ——
 * 而 h1.1 正是被实测否定的那条慢路，降级后**连 DNS 污染保护也没了**
 * （fetch 不接受 connectIp，只能走被污染的系统解析器）。等于一次抖动永久退回事故路径。
 * 现在 5 分钟后自动放行，重新给 h2 一次机会。
 */
const broken = new Map<string, number>();
const BROKEN_TTL_MS = 5 * 60_000;

/** 连接阶段失败（可以安全回退到 h1.1）；响应阶段失败不算，避免重复发请求 */
export interface H2ConnectError extends Error {
  h2ConnectFailed: true;
}

function connectError(message: string, cause?: unknown): H2ConnectError {
  const e = new Error(message) as H2ConnectError;
  e.h2ConnectFailed = true;
  if (cause !== undefined) (e as { cause?: unknown }).cause = cause;
  return e;
}

/** h2 是否对这个 origin（可带 servername）可用（调用方据此决定要不要回退）。
 *  `now` 只为可测性暴露（与 dns.ts 的 `resolveTrusted(host, now)` 同一写法）。 */
export function h2Feasible(origin: string, servername?: string, now = Date.now()): boolean {
  const key = servername ? `${origin}|${servername}` : origin;
  const at = broken.get(key);
  if (at === undefined) return true;
  if (now - at < BROKEN_TTL_MS) return false;
  broken.delete(key); // TTL 到了：放行，重新试一次 h2
  return true;
}

/**
 * 建连 origin 的**唯一**构造点。
 *
 * 调用方（client.ts 的预判）与 h2Fetch（真正建连）必须用同一个键，
 * 否则"标记不可用"永远打不中：审计 P1-4 指出 client.ts 用的是 `https://<ip>`（丢端口），
 * 而 http2.ts 用的是 `https://<ip>:<port>` —— 非 443 的上游两边永远对不上。
 */
export function h2ConnectOrigin(url: string, connectIp?: string): { origin: string; servername?: string } {
  const u = new URL(url);
  if (!connectIp) return { origin: u.origin };
  return {
    origin: `${u.protocol}//${connectIp}${u.port ? `:${u.port}` : ''}`,
    servername: u.hostname,
  };
}

function getSession(origin: string, servername?: string): Promise<ClientHttp2Session> {
  const key = servername ? `${origin}|${servername}` : origin;
  const existing = sessions.get(key);
  if (existing && !existing.closed && !existing.destroyed) {
    lastUsed.set(key, Date.now());
    return Promise.resolve(existing);
  }
  // 正在建的：并发请求共享同一条，不再各建一条
  const inflight = pending.get(key);
  if (inflight) return inflight;

  const p = new Promise<ClientHttp2Session>((resolve, reject) => {
    let settled = false;
    let s: ClientHttp2Session;
    try {
      // 按 IP 建连时，servername 必须显式给成**真域名**：SNI 与证书校验都靠它
      s = servername ? connect(origin, { servername }) : connect(origin);
    } catch (err) {
      broken.set(key, Date.now());
      reject(connectError(`HTTP/2 建连失败：${origin}`, err));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      broken.set(key, Date.now());
      s.destroy();
      reject(connectError(`HTTP/2 建连超时：${origin}`));
    }, 5_000);
    timer.unref?.();

    s.once('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        broken.set(key, Date.now());
        s.destroy();
        reject(connectError(`HTTP/2 建连失败：${origin}`, err));
        return;
      }
      if (sessions.get(key) === s) sessions.delete(key);
    });
    s.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 会话失效就从缓存里摘掉，下一次请求会重新建连
      s.on('close', () => {
        if (sessions.get(key) === s) sessions.delete(key);
      });
      s.on('goaway', () => {
        if (sessions.get(key) === s) sessions.delete(key);
        try {
          s.close();
        } catch {
          /* ignore */
        }
      });
      // 不拦进程退出（否则 SIGTERM 优雅退出会被这条连接吊住）
      try {
        s.unref();
      } catch {
        try {
          (s as unknown as { socket?: { unref?: () => void } }).socket?.unref?.();
        } catch {
          /* ignore */
        }
      }
      sessions.set(key, s);
      lastUsed.set(key, Date.now());
      resolve(s);
    });
  });
  pending.set(key, p);
  const done = (): void => {
    pending.delete(key);
  };
  void p.then(done, done);
  return p;
}

/**
 * 空闲回收：没人用的会话在 IDLE_CLOSE_MS 之后关掉。
 * 定时器 unref，不会吊住进程退出。
 */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, s] of [...sessions]) {
    if (now - (lastUsed.get(key) ?? 0) <= IDLE_CLOSE_MS) continue;
    sessions.delete(key);
    lastUsed.delete(key);
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
}, 60_000);
sweeper.unref?.();

export interface H2RequestInit {
  method?: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /**
   * 已经解析好的 IP。给了就**按这个 IP 建连**，而 SNI 与 `:authority` 仍用 URL 里的真域名
   * （证书校验照旧）。用来绕开被污染的系统解析器，见 dns.ts。
   */
  connectIp?: string;
}

/**
 * 用 HTTP/2 发一个请求，返回**标准 Response**。
 *
 * 抛出的错误若带 `h2ConnectFailed`，说明是建连阶段的问题，调用方可以安全回退 h1.1；
 * 其它错误发生在响应阶段，**不要**回退（回退等于把同一个请求再发一遍）。
 */
export async function h2Fetch(url: string, init: H2RequestInit): Promise<Response> {
  const u = new URL(url);
  const { origin: connectOrigin, servername } = h2ConnectOrigin(url, init.connectIp);
  if (!h2Feasible(connectOrigin, servername)) throw connectError(`HTTP/2 已判定不可用：${connectOrigin}`);

  const session = await getSession(connectOrigin, servername);
  lastUsed.set(servername ? `${connectOrigin}|${servername}` : connectOrigin, Date.now());

  const req = session.request({
    [constants.HTTP2_HEADER_METHOD]: init.method ?? 'POST',
    [constants.HTTP2_HEADER_PATH]: `${u.pathname}${u.search}`,
    [constants.HTTP2_HEADER_AUTHORITY]: u.host,
    [constants.HTTP2_HEADER_SCHEME]: 'https',
    ...init.headers,
  });

  const onAbort = (): void => {
    try {
      // **用信号自带的原因**：调用方 abort 时可能带了有诊断价值的错
      // （如 timeoutError() 的 ETIMEDOUT）。老代码另造 Error('aborted')，
      // 把 code 丢掉 → 归因把整体超时错记成 network_error（审计 D-P2-8）。
      const reason = init.signal?.reason;
      req.destroy(reason instanceof Error ? reason : new Error('aborted'));
    } catch {
      /* ignore */
    }
  };
  if (init.signal) {
    if (init.signal.aborted) {
      req.destroy();
      throw new Error('aborted');
    }
    init.signal.addEventListener('abort', onAbort, { once: true });
  }

  req.end(init.body ?? undefined);

    const head = await new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
      req.once('response', (h) => resolve({ status: Number(h[constants.HTTP2_HEADER_STATUS]), headers: h }));
      req.once('error', reject);
      req.once('close', () => reject(new Error('HTTP/2 流在响应头之前就关闭了')));
    });

    const headers = new Headers();
    for (const [k, v] of Object.entries(head.headers)) {
      if (k.startsWith(':')) continue; // 伪头（:status 等）不进普通头
      if (Array.isArray(v)) for (const item of v) headers.append(k, String(item));
      else if (v !== undefined) headers.append(k, String(v));
    }

    // 204/304 这类状态**不允许带 body**，`new Response(body, {status})` 会直接抛
    const bodyless = head.status === 204 || head.status === 304;
    const body = bodyless ? null : (Readable.toWeb(req) as ReadableStream<Uint8Array>);
    return new Response(body, { status: head.status, headers });
    /*
     * ⚠️ **abort 监听不能在这里摘掉**（2026-09-14 审计 D-P0-2）。
     *
     * 老代码拿到响应头就 removeEventListener —— 于是"等响应头"之后的任何 abort
     * （客户端断开 / 整体超时 / 流已经开始才判死）都传不到上游：请求会无限期流下去，
     * 客户端断开也停不掉（客户为拿不到的 token 付费）。
     *
     * 所以监听器保留到请求对象被回收：onAbort 只是 `req.destroy()`，
     * 对已正常结束的流是无害空操作；controller 按请求新建，请求结束即被 GC，不累积。
     */
}

/** 关闭所有会话（优雅退出时调用；平时会话已 unref，不影响进程退出） */
export function closeH2Sessions(): void {
  pending.clear();
  lastUsed.clear();
  for (const s of sessions.values()) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
}
