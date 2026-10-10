/**
 * 上游协议适配层。
 *
 * 设计要点：
 * - 网关内部统一按「上游协议」抽象，OpenAI 兼容协议是第一个实现（覆盖 DeepSeek /
 *   通义 / 火山 / 智谱 / Moonshot / SiliconFlow / OpenRouter / vLLM / Ollama 等绝大多数）；
 *   Anthropic 与 Gemini 协议留出实现位，按需接入。
 * - **透传优先**：成功响应体（含 SSE 帧）按字节原样转发，适配层只在旁路读取时解析
 *   副本用于 P8 度量与 P5 轨迹，绝不改写回传内容。
 */

import type { ProviderConfig } from '../core/types.js';
import { normalizeUsage, transcriptFromSse } from '../loss/meter.js';
import type { StreamTranscript, UsageBreakdown } from '../core/types.js';
import { monotonicMs } from '../util/index.js';

export interface UpstreamRequest {
  /** OpenAI 风格路径，如 /chat/completions */
  path: string;
  model: string;
  body: Record<string, unknown>;
  stream: boolean;
  /** 是否为首个 attempt（后续 attempt 由路由决定是否允许失败回退） */
  attempt: number;
  /**
   * 网关**自己**往请求体里注入了 `stream_options.include_usage`（客户原本没要求）。
   * 为 true 时，上游多回来的那一帧"只有 usage"会被 `dropUsageOnlyFrames` 滤掉，
   * 保证客户端看到的字节流与没注入时一致。
   */
  injectedUsage?: boolean;
}

export interface PassthroughResponse {
  status: number;
  headers: Record<string, string>;
  /** 上游响应流（已就近取消） */
  stream: ReadableStream<Uint8Array>;
  /** 首字节延迟 */
  ttfbMs: number;
  providerId: string;
  model: string;
  /** 流结束后可用的旁路解析结果 */
  transcript: () => StreamTranscript;
  /**
   * 旁路那一支（度量/轨迹）**解析完成**的 Promise。
   *
   * ⚠️ 流式记账必须 await 它，不能直接读 `transcript()` —— 两个 tee 分支各跑各的，
   * 客户端那一支读完时旁路可能还在解析，此时 `transcript()` 返回的是**空壳**，
   * 于是 usage 拿不到、连"按字符估算"的兜底也进不去，流式 token 全记 0。
   * 2026-09-14 实测：375 个流式请求全部记账为 0。
   */
  transcriptDone: Promise<StreamTranscript>;
  /**
   * 主动放弃这条响应（对冲输了 / 上层丢弃）。
   *
   * abort 内部 controller → 上游 HTTP/2 流真正销毁（http2.ts 的 abort 监听保留整个
   * 流生命周期）；同时取消度量那一支（tee 源流要两支都取消才销毁），避免继续为
   * 拿不到的结果付费、占着上游并发。幂等，可重复调用。
   */
  abort: () => void;
}

export type UpstreamOutcome =
  | {
      kind: 'passthrough';
      response: PassthroughResponse;
    }
  | {
      kind: 'buffered';
      status: number;
      headers: Record<string, string>;
      /** 原样保留的响应文本（用于错误体透传，或小响应体转发） */
      bodyText: string;
      usage?: UsageBreakdown;
      ttfbMs: number;
      durationMs: number;
      providerId: string;
      model: string;
    }
  | {
      kind: 'error';
      providerId: string;
      model: string;
      /** 网络层错误（若无 HTTP 响应） */
      networkError?: { code?: string; message: string };
      httpStatus?: number;
      headers?: Record<string, string>;
      bodyText?: string;
      durationMs: number;
      /** 客户端取消 */
      clientAborted?: boolean;
      retryAfterHeader?: string;
    };

export interface UpstreamClient {
  readonly providerId: string;
  readonly protocol: ProviderConfig['protocol'];
  /** 发起请求；不抛异常，所有失败都编码进 UpstreamOutcome */
  send(req: UpstreamRequest, signal: AbortSignal): Promise<UpstreamOutcome>;
}

/** 上游返回的响应头里，允许透传给客户端的安全白名单（其余一律丢弃，避免泄露上游身份） */
const PASSTHROUGH_HEADERS = new Set([
  'content-type',
  'cache-control',
  'openai-processing-ms',
  'openai-version',
  'x-request-id',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'retry-after',
]);

/**
 * 造一个**带 code 的超时错误**（2026-09-14 审计 D-P2-8）。
 *
 * 老代码 `controller.abort(new Error('ttfb_timeout'))` 的错没有 `.code`、
 * `.name` 也不是 AbortError/TimeoutError → 归因分类拿不到 ETIMEDOUT，
 * 只能落进"无规则命中"兜底，被记成 **network_error** —— 而正是它该被记成
 * upstream_timeout（可重试、可换路、面板/P8 才看得懂）。今天两条线一起熔断
 * 的日志里 upstream_timeout 一次都没出现过，全是 network_error，就是这个原因。
 */
function timeoutError(label: string): Error {
  const e = new Error(label);
  (e as { code?: string }).code = 'ETIMEDOUT';
  return e;
}

export function filterUpstreamHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers) {
    const lower = k.toLowerCase();
    if (PASSTHROUGH_HEADERS.has(lower)) out[lower] = v;
  }
  return out;
}

export interface BufferedRequestOptions {
  baseUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  timeoutMs: number;
  ttfbTimeoutMs: number;
  /**
   * **停摆超时**（毫秒）：不只看首字节，而是看"数据还在不在流动"。
   *
   * 为什么需要它：`ttfbTimeoutMs` 只覆盖到**响应头**。实测 Agnes 国际线路会
   * 在 0.9 秒内回响应头、然后 body 长时间（>150 秒）不产出 —— 首字节定时器当场解除，
   * 请求被吊到总超时，客户端只能自己断（实测客户 111 秒放弃，拿到 499）。
   * 流式更糟：一拿到响应头就把 200 提交给客户，**之后再也换不了线路**。
   *
   * 所以：流式要等**第一个数据块**到了才提交状态码；非流式则给 body 读取加同样的
   * "多久没动静就算停摆"看门狗。停摆按普通上游失败处理 → 可重试 → 同请求内切备用线路。
   */
  stallTimeoutMs: number;
  userAgent?: string;
}

/** 把 OpenAI 风格路径拼到 baseUrl 上（容忍 baseUrl 带或不带 /v1） */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

/** 按上游声明的格式生成鉴权头（默认 OpenAI 标准的 Bearer） */
export function buildAuthHeader(apiKey: string, auth?: ProviderConfig['auth']): Record<string, string> {
  switch (auth?.format) {
    case 'bearerless':
      return { authorization: apiKey };
    case 'api-key-header':
      return { [auth.headerName ?? 'api-key']: apiKey };
    case 'x-api-key':
      return { 'x-api-key': apiKey };
    case 'bearer':
    case undefined:
    default:
      return { authorization: `Bearer ${apiKey}` };
  }
}

import { h2Fetch, h2Feasible, h2ConnectOrigin, type H2ConnectError } from './http2.js';
import { resolveTrusted } from './dns.js';

/** 上游请求发送：优先 HTTP/2，建连失败才回退 h1.1（见 http2.ts 顶部的实测记录） */
export interface SendOptions extends BufferedRequestOptions {
  providerId: string;
  protocol: ProviderConfig['protocol'];
  /** 鉴权格式（见 ProviderConfig.auth） */
  auth?: ProviderConfig['auth'];
  /** 需要旁路解析 SSE（用于 transcript 与 usage） */
  teeStream?: boolean;
  /**
   * 用 **HTTP/2** 发上游请求。
   *
   * 2026-09-14 实测：`api.agnes-ai.cn` 的 HTTP/1.1 路径慢且抖
   * （同一请求 h2 稳定 0.13~0.35s，h1.1 会跑到 2~20s，undici 更是能挂 54s），
   * 而 Node 的 fetch 只支持 h1.1 —— 所以这类上游必须走 h2。
   */
  http2?: boolean;
  /** 多 key 池（≥1 个）；长度 1 时退化为单 key */
  apiKeys?: string[];
}

/* ------------------------------------------------------------------ *
 * 多 key 轮换池
 * ------------------------------------------------------------------ */

export type KeyStatus = 'ready' | 'transient_cooldown' | 'permanent_dead';

/**
 * key 轮换器（纯内存，无状态依赖）。
 *
 * 分工：
 * - **轮换**（round-robin）分摊限流压力 —— 这是 key 池的主要价值。
 * - **瞬态失败**（429/5xx/超时）对该 key 短冷却，不影响其他 key。
 * - **永久失败**（401/403/余额不足）直接判定该 key 报废，直到人工干预（reset()）。
 * - 全部 key 不可用时返回 undefined，交由路由层做上游级故障转移。
 */
export class KeyRotator {
  private cursor = 0;
  private readonly state: { key: string; cooldownUntil: number; dead: boolean; failures: number }[];

  constructor(
    keys: string[],
    private readonly transientCooldownMs = 20_000,
  ) {
    this.state = keys.map((key) => ({ key, cooldownUntil: 0, dead: false, failures: 0 }));
  }

  get size(): number {
    return this.state.length;
  }

  /** 取下一个可用 key（轮换起点为上次位置的下一格，保证公平） */
  next(now = Date.now()): string | undefined {
    const n = this.state.length;
    if (n === 0) return undefined;
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      const s = this.state[idx]!;
      if (!s.dead && s.cooldownUntil <= now) {
        this.cursor = (idx + 1) % n;
        return s.key;
      }
    }
    return undefined;
  }

  noteSuccess(key: string): void {
    const s = this.state.find((x) => x.key === key);
    if (!s) return;
    s.failures = 0;
    s.cooldownUntil = 0;
  }

  /** 瞬态失败：该 key 短冷却（不报废） */
  noteTransientFailure(key: string, now = Date.now()): void {
    const s = this.state.find((x) => x.key === key);
    if (!s) return;
    s.failures++;
    s.cooldownUntil = now + Math.min(this.transientCooldownMs * s.failures, 10 * 60_000);
  }

  /** 永久失败：该 key 报废 */
  notePermanentFailure(key: string): void {
    const s = this.state.find((x) => x.key === key);
    if (!s) return;
    s.dead = true;
  }

  reset(): void {
    for (const s of this.state) {
      s.dead = false;
      s.cooldownUntil = 0;
      s.failures = 0;
    }
    this.cursor = 0;
  }

  snapshot(): { index: number; masked: string; dead: boolean; cooldownMsLeft: number; failures: number }[] {
    const now = Date.now();
    return this.state.map((s, index) => ({
      index,
      masked: s.key.length > 10 ? `${s.key.slice(0, 6)}...${s.key.slice(-4)}` : '***',
      dead: s.dead,
      cooldownMsLeft: Math.max(0, s.cooldownUntil - now),
      failures: s.failures,
    }));
  }

  /** 可用 key 数量（健康检查用） */
  availableCount(now = Date.now()): number {
    return this.state.filter((s) => !s.dead && s.cooldownUntil <= now).length;
  }
}

/**
 * OpenAI 兼容上游客户端。
 *
 * 关键实现细节：
 * 1. 用 AbortSignal.any 把「客户端断开」与「超时」合并成一个信号。
 * 2. 首字节超时独立于总超时（上游"接了但不吐字"是最常见的恶性故障）。
 * 3. 流式响应返回 tee 后的分支：客户端拿原始分支，度量拿解析分支。
 */
/** `reader.read()` 的结果（lib.dom 的 `ReadableStreamReadResult` 在本项目类型环境里不可直接引用） */
type ChunkRead = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

export class OpenAICompatibleClient implements UpstreamClient {
  private readonly rotator?: KeyRotator;

  constructor(private readonly opts: SendOptions) {
    const keys = normalizeKeys(opts.apiKeys, opts.apiKey);
    if (keys.length > 1) this.rotator = new KeyRotator(keys);
  }

  /** 供管理看板展示 key 池健康度 */
  keySnapshot(): ReturnType<KeyRotator['snapshot']> | undefined {
    return this.rotator?.snapshot();
  }

  get providerId(): string {
    return this.opts.providerId;
  }

  get protocol(): ProviderConfig['protocol'] {
    return this.opts.protocol;
  }

  /**
   * 等到**第一个数据块**（或流结束）才返回；超时返回 null。
   *
   * 用途：流式请求不能在"只拿到响应头"时就提交 200 —— 那等于替上游向客户担保
   * 后面一定有内容，而实测 Agnes 国际线路正好是"头很快、body 不来"，
   * 客户于是拿到一个永远没有内容的 200，且**状态码已发出、本请求再也换不了线路**。
   * 返回的流把已经读走的那一块补回最前面，字节序列与上游完全一致（零改写）。
   */
  /**
   * 发上游请求：优先 HTTP/2，**只有建连阶段失败**才回退 h1.1。
   *
   * 为什么不回退响应阶段的失败：那等于把同一个请求再发一遍 —— 上游可能已经受理并计费了。
   * 建连失败（不支持 h2 / 连不上）则完全安全：那份请求根本没发出去。
   */
  private async performRequest(
    url: string,
    headers: Record<string, string>,
    body: string,
    signal: AbortSignal,
  ): Promise<Response> {
    if (this.opts.http2 && url.startsWith('https://')) {
      // 只对 https 尝试 h2：这样"服务端不支持 h2"会在 TLS ALPN 阶段就失败，
      // 我们才能确定地把这次失败归类为"建连失败、可安全回退"。
      // 明文 http（h2c）的失败要等到发完请求才暴露，那就不敢回退了，所以不冒险。
      let origin = '';
      let host = '';
      try {
        const u = new URL(url);
        origin = u.origin;
        host = u.hostname;
      } catch {
        /* URL 不合法就交给 fetch 去报错 */
      }
      if (origin) {
        // **自己解析，不用系统解析器**：本机 114.114.114.114 对部分上游域名回假地址，
        // 连上却永不回数据（见 dns.ts 顶部的实测记录）。
        const connectIp = await resolveTrusted(host);
        // 键必须与 h2Fetch 内部一致（含端口）—— 老代码这里丢了端口，
        // 导致非 443 上游的"不可用"标记永远打不中（审计 P1-4）
        const { origin: connectOrigin, servername } = h2ConnectOrigin(url, connectIp);
        if (h2Feasible(connectOrigin, servername)) {
          try {
            return await h2Fetch(url, {
              method: 'POST',
              headers,
              body,
              signal,
              ...(connectIp ? { connectIp } : {}),
            });
          } catch (err) {
            if (!(err as H2ConnectError).h2ConnectFailed) throw err;
            // 落回 h1.1；h2Feasible 已把该 origin 标记为不可用，后续请求直接走 fetch，不再每次白试
          }
        }
      }
    }
    return await fetch(url, { method: 'POST', headers, body, signal });
  }

  private async firstChunkWithin(
    src: ReadableStream<Uint8Array>,
    stallMs: number,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const reader = src.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first: ChunkRead | undefined;
    try {
      first = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('upstream_stall')), stallMs);
        }),
      ]);
    } catch {
      if (timer) clearTimeout(timer);
      /*
       * ⚠️ **绝不能 await 这个 cancel()**（2026-09-14 实测踩到）。
       *
       * `reader` 是 `res.body.tee()` 的一支。当"客户端自己带了
       * stream_options.include_usage"时，给客户端的那一支就是**裸 tee 支**，
       * 而 tee 支的 cancel 在**源没有数据**时会永远不 settle ——
       * 而"源没有数据"恰恰就是停摆看门狗被判死的那个前提。
       * 于是这个本来用来救命的清理动作，把请求永久挂住：
       * 不返回、不重试、不换线路、不熔断，客户端断开也解不开。
       *
       * 所以：**发出去就不管**（我们不依赖它完成），只保证不阻塞当前路径。
       */
      void Promise.resolve(reader.cancel()).catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        /* 已经断了就算了 */
      }
      return null;
    }
    if (timer) clearTimeout(timer);
    const head = first;
    /*
     * ⚠️ **`{done:true}` 不是"拿到了首块"，是"上游一个字节都没给就结束了"**
     * （2026-09-14 审计实测）：上游发完 200+SSE 头就 RST 时，`read()` 可能 resolve 成
     * `{done:true}` 而不是 reject。老代码把它当合法首块 → 提交 200 → 客户拿到**空 200**、
     * 不触发故障转移、`noteSuccess` 还把这条坏线路的熔断计数清零。
     *
     * 这正是"首块闸门"当初要挡的失败模式（Agnes 国际"回了头就不发体"），所以必须：
     * 没有数据就得判本次尝试失败 → 走可重试/换线路那条路。
     */
    if (!head || head.done || !head.value) return null;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (head.value) controller.enqueue(head.value);
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (value) controller.enqueue(value);
        } catch (err) {
          controller.error(err);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }

  /**
   * 读完整响应体，但**中途卡住超过 stallMs 就放弃**（返回 null）。
   * 非流式只有 `await res.text()` 的话，上游"先给头再装死"能把请求吊到总超时。
   */
  private async readBodyWithStall(res: Response, stallMs: number): Promise<string | null> {
    if (!res.body) return await res.text();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (;;) {
        let raced: ChunkRead;
        try {
          raced = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('upstream_stall')), stallMs);
            }),
          ]);
        } finally {
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
        }
        if (raced.done) break;
        if (raced.value) chunks.push(raced.value);
      }
    } catch {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      return null;
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async send(req: UpstreamRequest, signal: AbortSignal): Promise<UpstreamOutcome> {
    const started = monotonicMs();
    const url = joinUrl(this.opts.baseUrl, req.path);
    let apiKey = this.rotator?.next() ?? this.opts.apiKey;
    if (this.rotator && apiKey === undefined) {
      // 全部 key 都在冷却/报废：明确报错，让路由层做上游级故障转移
      return {
        kind: 'error',
        providerId: this.opts.providerId,
        model: req.model,
        httpStatus: 503,
        bodyText: JSON.stringify({
          error: {
            message: '该上游的所有 API key 当前均不可用（冷却或已报废）',
            type: 'rate_limit_error',
            code: 'relay_all_keys_unavailable',
          },
        }),
        durationMs: monotonicMs() - started,
      };
    }
    const maxKeyAttempts = this.rotator ? Math.min(this.rotator.size, 3) : 1;

    for (let keyAttempt = 0; keyAttempt < maxKeyAttempts; keyAttempt++) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: req.stream ? 'text/event-stream' : 'application/json',
        ...buildAuthHeader(apiKey!, this.opts.auth),
        'user-agent': this.opts.userAgent ?? 'api-relay/0.1 (+transmission-loss-reduction)',
        ...(this.opts.extraHeaders ?? {}),
      };

      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      /*
       * **每次要用时现读**，不要提前快照（2026-09-14 审计 P1-3）。
       *
       * 老代码在进 try 之前只读一次 `signal.aborted`，于是"等首块/等停摆"这几秒里
       * 客户端才断开的情况，被记成**上游失败** → engine 按厂商失败计账 →
       * 5 次客户端放弃就能把一条**健康**上游熔断（breakerThreshold=5），
       * 全体客户跟着 503 / 改道，而归因还把方向指向厂商。注释里写过"实测踩过"。
       */
      const clientAbortedNow = (): boolean => signal.aborted;
      const ttfbTimer = setTimeout(() => controller.abort(timeoutError('ttfb_timeout')), this.opts.ttfbTimeoutMs);
      /*
       * **整体超时**：从尝试开始起算，覆盖"等响应头 + 等首块"整个阶段。
       * 流式首块之后的部分由 server 转发循环按 deadlineAt 截断（见 engine / server）。
       * 老代码 timeoutMs 只被 Math.min 夹逼、从未真正 arm，面板却把它当"单次请求总上限"。
       * abort 会传导到上游：h2 的 abort 监听现在保留整个流生命周期（见 http2.ts）。
       */
      const totalTimer = setTimeout(() => controller.abort(timeoutError('total_timeout')), this.opts.timeoutMs);

      try {
        const res = await this.performRequest(url, headers, JSON.stringify(req.body), controller.signal);
        clearTimeout(ttfbTimer);
        const ttfbMs = monotonicMs() - started;
        const respHeaders = filterUpstreamHeaders(res.headers);

        if (req.stream && res.ok && res.body) {
          // tee：一支给客户端，一支给度量与轨迹解析（旁路，不影响转发字节）。
          // 我们自己注入了 include_usage 时，上游会多回一帧"只有 usage"的空壳帧 ——
          // 那一帧是给度量用的、客户没要过，从**给客户端的那一支**里滤掉。
          const [rawClientSide, meterSide] = res.body.tee();
          const clientSide = req.injectedUsage ? dropUsageOnlyFrames(rawClientSide) : rawClientSide;
          let transcript: StreamTranscript | undefined;
          // 旁路那一支解析完成的 Promise —— onEnd 必须 await 它才读得到 usage。
          // cancel：停摆判死时把这一支也取消（tee 源流只在两支都取消时才真正销毁）。
          const { promise: transcriptDone, cancel: cancelMeterSide } = tapForMeter(meterSide, (t) => {
            transcript = t;
          });
          // **先等到第一个数据块再提交**。只拿到响应头就 commit 200，
          // 等于替上游担保后面有内容：实测 Agnes 国际"头 0.9s、body 永不来"，
          // 客户拿到一个没有内容的 200 且已经无法换线路。等首块把这种假成功
          // 挡在提交之前，超时就按上游超时处理 → 可重试 → 同请求内切备用线路。
          const guarded = await this.firstChunkWithin(clientSide, this.opts.stallTimeoutMs);
          if (!guarded) {
            // 停摆判死：**两支都取消**才是真销毁上游流（审计 D-P1-3）。
            // 老代码只取消了客户端支，meterSide 支会一直读到上游自己结束 ——
            // 我们继续付钱、上游并发闸门对流式形同虚设。
            cancelMeterSide();
            return {
              kind: 'error',
              providerId: this.opts.providerId,
              model: req.model,
              networkError: {
                code: 'ETIMEDOUT',
                message: `上游 ${this.opts.providerId} 回了响应头，但 ${this.opts.stallTimeoutMs}ms 内没有任何数据产出（停摆），已放弃本次尝试`,
              },
              durationMs: monotonicMs() - started,
              ...(clientAbortedNow() ? { clientAborted: true } : {}),
            };
          }
          this.rotator?.noteSuccess(apiKey!);
          return {
            kind: 'passthrough',
            response: {
              status: res.status,
              headers: respHeaders,
              stream: guarded,
              ttfbMs,
              providerId: this.opts.providerId,
              model: req.model,
              transcript: () => transcript ?? EMPTY_TRANSCRIPT,
              transcriptDone,
              // 对冲输家被丢弃时由 engine 调用：真正销毁上游流 + 度量支。
              abort: () => {
                try {
                  controller.abort();
                } catch {
                  /* ignore */
                }
                try {
                  cancelMeterSide();
                } catch {
                  /* ignore */
                }
                try {
                  void guarded.cancel().catch(() => undefined);
                } catch {
                  /* ignore */
                }
              },
            },
          };
        }

        // 非流式：读完整响应体（成功小、失败小，均可安全缓冲）。
        // 用带停摆看门狗的读法：上游"先给头、再装死"时 `res.text()` 会一直吊着，
        // 实测能吊到 150 秒，超过客户端的耐心（客户先断，拿到 499）。
        const bodyText = await this.readBodyWithStall(res, this.opts.stallTimeoutMs);
        if (bodyText === null) {
          return {
            kind: 'error',
            providerId: this.opts.providerId,
            model: req.model,
            networkError: {
              code: 'ETIMEDOUT',
              message: `上游 ${this.opts.providerId} 的响应体读取中途停摆超过 ${this.opts.stallTimeoutMs}ms，已放弃本次尝试`,
            },
            durationMs: monotonicMs() - started,
            ...(clientAbortedNow() ? { clientAborted: true } : {}),
          };
        }
        const durationMs = monotonicMs() - started;
        if (!res.ok) {
          // 多 key：用另一个 key 再试一次（限流/鉴权/配额都可能只影响单个 key）
          if (this.rotator && shouldRotateKey(res.status) && keyAttempt + 1 < maxKeyAttempts) {
            const permanent = res.status === 401 || res.status === 403 || isQuotaBody(bodyText);
            if (permanent) this.rotator.notePermanentFailure(apiKey!);
            else this.rotator.noteTransientFailure(apiKey!);
            const rotated = this.rotator.next();
            if (rotated !== undefined) {
              apiKey = rotated;
              continue;
            }
          }
          if (this.rotator) {
            if (res.status === 401 || res.status === 403) this.rotator.notePermanentFailure(apiKey!);
            else if (res.status === 429 || res.status >= 500) this.rotator.noteTransientFailure(apiKey!);
          }
          return {
            kind: 'error',
            providerId: this.opts.providerId,
            model: req.model,
            httpStatus: res.status,
            headers: respHeaders,
            bodyText,
            durationMs,
            ...(clientAbortedNow() ? { clientAborted: true } : {}),
          };
        }
        this.rotator?.noteSuccess(apiKey!);
        const usage = extractUsage(bodyText);
        return {
          kind: 'buffered',
          status: res.status,
          headers: respHeaders,
          bodyText,
          ...(usage ? { usage } : {}),
          ttfbMs,
          durationMs,
          providerId: this.opts.providerId,
          model: req.model,
        };
      } catch (err) {
        clearTimeout(ttfbTimer);
        const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
        const clientGone = clientAbortedNow();
        const code = e.code ?? e.cause?.code ?? (e.name === 'AbortError' || e.name === 'TimeoutError' ? 'ETIMEDOUT' : undefined);
        // 客户端走了不算上游的账（否则会熔断健康线路）
        if (this.rotator && !clientGone) this.rotator.noteTransientFailure(apiKey!);
        return {
          kind: 'error',
          providerId: this.opts.providerId,
          model: req.model,
          networkError: { ...(code ? { code } : {}), message: e.cause?.message ?? e.message ?? String(err) },
          durationMs: monotonicMs() - started,
          ...(clientAbortedNow() ? { clientAborted: true } : {}),
        };
      } finally {
        clearTimeout(ttfbTimer);
        clearTimeout(totalTimer);
        signal.removeEventListener('abort', onAbort);
      }
    }

    // 理论上不可达（循环内必定 return），保留兜底
    return {
      kind: 'error',
      providerId: this.opts.providerId,
      model: req.model,
      networkError: { message: 'key 池耗尽且未产生响应' },
      durationMs: monotonicMs() - started,
    };
  }
}

/** 有效 key 集合：apiKeys ∪ [apiKey]，去重去空 */
export function normalizeKeys(apiKeys: string[] | undefined, apiKey: string | undefined): string[] {
  const out: string[] = [];
  for (const k of [...(apiKeys ?? []), ...(apiKey ? [apiKey] : [])]) {
    const t = k?.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function shouldRotateKey(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status === 402 || status >= 500;
}

function isQuotaBody(bodyText: string): boolean {
  return /(insufficient|balance|quota|余额|额度)/i.test(bodyText);
}

/** 从非流式响应体里抽 usage（失败则 undefined，绝不抛） */
export function extractUsage(bodyText: string): UsageBreakdown | undefined {
  try {
    const obj = JSON.parse(bodyText) as Record<string, unknown>;
    return normalizeUsage(obj['usage']);
  } catch {
    return undefined;
  }
}

/** 空 transcript：旁路解析失败时的兜底，保证 await 那一侧永远不会吊死 */
const EMPTY_TRANSCRIPT: StreamTranscript = {
  chunkCount: 0,
  contentChars: 0,
  reasoningChars: 0,
  malformedFrames: 0,
  sawDone: false,
};

/**
 * tee 的一支只用于度量：解析 transcript，同时把原始字节计数回传。
 *
 * 返回的 Promise **一定会 resolve**（解析失败也 resolve 成空壳），
 * 供 `onEnd` 等待 —— 不等就会读到还没填好的 transcript，流式 token 全记 0。
 */
function tapForMeter(
  stream: ReadableStream<Uint8Array>,
  onDone: (t: StreamTranscript & { bytes: number }) => void,
): { promise: Promise<StreamTranscript>; cancel: () => void } {
  const reader = stream.getReader();
  const promise = consumeSse(stream, reader)
    .then((t) => {
      onDone(t);
      return t as StreamTranscript;
    })
    .catch(() => {
      onDone({ ...EMPTY_TRANSCRIPT, bytes: 0 });
      return EMPTY_TRANSCRIPT;
    });
  /*
   * **取消旁路支**（2026-09-14 审计 D-P1-3）。
   *
   * tee 的源流只在**两支都取消**时才真正 cancel —— 停摆判死时老代码只取消了
   * 客户端支（firstChunkWithin 的 catch），meterSide 支会一直读到上游自己结束：
   * 上游继续产出（我们继续付费），上游并发闸门对流式形同虚设。
   * 调用方在判死时必须两支都取消，这里就是那一支的取消柄。
   */
  const cancel = (): void => {
    try {
      void Promise.resolve(reader.cancel()).catch(() => undefined);
    } catch {
      /* ignore */
    }
  };
  return { promise, cancel };
}

/**
 * 消费 SSE 流并解析成 transcript；同时统计原始字节数。
 * 严格按 SSE 语义解析：以「空行」为事件分隔符，因此多行 data: 会被正确拼接，
 * 跨 chunk 边界的分片不会被误判。
 */
export async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  reader?: ReadableStreamDefaultReader<Uint8Array>,
): Promise<StreamTranscript & { bytes: number }> {
  const decoder = new TextDecoder('utf-8');
  const own = reader === undefined;
  const rdr = reader ?? stream.getReader();
  const dataLines: string[] = [];
  let malformed = 0;
  let bytes = 0;
  let buffer = '';
  let pending: string[] = [];

  const dispatch = (): void => {
    if (pending.length === 0) return;
    const joined = pending.join('\n');
    if (joined.trim().length > 0) dataLines.push(joined);
    pending = [];
  };

  const handleLine = (rawLine: string): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      // SSE 事件分隔符：一个事件结束
      dispatch();
      return;
    }
    if (line.startsWith('data:')) {
      const data = line.slice(5).replace(/^ /, '');
      pending.push(data);
      if (data === '[DONE]' || looksLikeCompleteJson(data)) dispatch();
      return;
    }
    if (line.startsWith(':') || line.startsWith('event:') || line.startsWith('id:') || line.startsWith('retry:')) return;
    malformed++;
  };

  try {
    for (;;) {
      const { done, value } = await rdr.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    }
    if (buffer.length > 0) handleLine(buffer);
    dispatch();
  } catch {
    // 流被中断：已解析部分仍然有价值（这就是 stream_interrupted 的证据）
    dispatch();
  } finally {
    try {
      rdr.releaseLock();
    } catch {
      /* ignore */
    }
  }
  const transcript = transcriptFromSse(dataLines, malformed);
  return { ...transcript, bytes };
}

function looksLikeCompleteJson(s: string): boolean {
  const t = s.trim();
  if (t.length < 2 || t[0] !== '{') return false;
  // 快速判定：花括号配平（字符串内的括号会被不计入大致的配平判断，
  // 但对"已完整"的判断足够；不完整时下一段 data: 会补上）
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') {
      esc = true;
      continue;
    }
    if (c === '"') inStr = !inStr;
    else if (!inStr && c === '{') depth++;
    else if (!inStr && c === '}') depth--;
  }
  return depth === 0;
}

/**
 * 把上游回显的 `model` 字段改写成客户端请求的模型名。
 *
 * 为什么这是必须的（研究 02 结论 F）：上游会把别名解析成自己的真实模型名回显，
 * 而严格客户端（Vercel AI SDK 判别联合、Go/Rust 严格解码器）会因 model 不匹配而崩。
 * 只重写这一个字段，其余字段与帧顺序**逐字节不变**。
 */
export function rewriteSseModel(stream: ReadableStream<Uint8Array>, targetModel: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder('utf-8');
  const encoder = new TextEncoder();
  let buffer = '';
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      const flushLine = (line: string): void => {
        let out = line;
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload && payload !== '[DONE]' && payload.startsWith('{')) {
            try {
              const obj = JSON.parse(payload) as Record<string, unknown>;
              if (typeof obj['model'] === 'string' && obj['model'] !== targetModel) {
                obj['model'] = targetModel;
                out = `data: ${JSON.stringify(obj)}`;
              }
            } catch {
              /* 非 JSON 帧原样透传 */
            }
          }
        }
        controller.enqueue(encoder.encode(`${out}\n`));
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).replace(/\r$/, '');
            buffer = buffer.slice(idx + 1);
            flushLine(line);
          }
        }
        if (buffer.length > 0) flushLine(buffer.replace(/\r$/, ''));
      } catch {
        /* 上游中断：已转发的部分保持原样 */
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
        controller.close();
      }
    },
  });
}

/**
 * 丢掉"只有 usage 的那一帧"（**只在我们自己注入了 include_usage 时用**）。
 *
 * 背景：流式请求必须带 `stream_options:{include_usage:true}`，上游才会在结尾回 usage；
 * 不注入的话 P8 计量整段丢成 0（2026-09-14 实测：375 个流式请求全部记账为 0）。
 * 但注入之后，上游会在 `[DONE]` 之前**多出一帧**：
 *   Agnes：`{…,"choices":[{"index":0,"delta":{}}],"usage":{…}}`
 *   mock ：`{…,"choices":[],"usage":{…}}`
 * 这一帧是**我们要的、客户没要过**的 —— 直接透传等于凭空给客户端多一帧，
 * 严格的客户端（按 `choices[0].delta` 解引用）会崩。所以：
 * 注入方在 `UpstreamRequest.injectedUsage` 上打标，这里把这一帧**连同它后面那个空行**
 * 一起去掉，客户端看到的字节流与"根本没开 include_usage"时完全一致。
 *
 * 判据收得很紧，必须**同时**满足：
 *   ① 帧里有非 null 的 `usage` 对象；
 *   ② 所有 choice 的 delta 都没有 `content` / `reasoning_content` / `tool_calls`。
 * 所以带内容的帧永远不会被误删；即使上游每帧都挂 usage，也只删得掉那个空壳帧。
 *
 * 被丢掉的那一支**只影响给客户端的转发**：度量走的是 `tee()` 的另一支，照样拿得到 usage。
 */
export function dropUsageOnlyFrames(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder('utf-8');
  const encoder = new TextEncoder();
  let buffer = '';
  let dropNextBlank = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      const flushLine = (line: string): void => {
        // 被丢掉的帧后面那个空行也要吃掉，否则客户端会平白多收到一个换行
        if (dropNextBlank && line === '') {
          dropNextBlank = false;
          return;
        }
        dropNextBlank = false;
        if (isUsageOnlyFrame(line)) {
          dropNextBlank = true;
          return;
        }
        controller.enqueue(encoder.encode(`${line}\n`));
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            flushLine(buffer.slice(0, idx).replace(/\r$/, ''));
            buffer = buffer.slice(idx + 1);
          }
        }
        if (buffer.length > 0) flushLine(buffer.replace(/\r$/, ''));
      } catch {
        /* 上游中断：已转发的部分保持原样 */
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
        controller.close();
      }
    },
  });
}

/** 判定一帧是不是"只有 usage"的空壳帧（见 dropUsageOnlyFrames 的判据说明） */
function isUsageOnlyFrame(line: string): boolean {
  if (!line.startsWith('data:')) return false;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]' || !payload.startsWith('{')) return false;
  try {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    const usage = obj['usage'];
    if (usage === null || typeof usage !== 'object') return false;
    const choices = obj['choices'];
    if (!Array.isArray(choices)) return true; // 连 choices 都没有，不可能是内容帧
    for (const c of choices) {
      if (!c || typeof c !== 'object') continue;
      const rec = c as Record<string, unknown>;
      const delta = rec['delta'] ?? rec['message'];
      if (!delta || typeof delta !== 'object') continue;
      const d = delta as Record<string, unknown>;
      const hasContent =
        (typeof d['content'] === 'string' && d['content'] !== '') ||
        (typeof d['reasoning_content'] === 'string' && d['reasoning_content'] !== '') ||
        (Array.isArray(d['tool_calls']) && d['tool_calls'].length > 0);
      if (hasContent) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 工厂：按协议创建客户端 */
export function createUpstreamClient(
  provider: ProviderConfig,
  defaults: { userAgent?: string; timeoutMs?: number; ttfbTimeoutMs?: number; stallTimeoutMs?: number },
): UpstreamClient {
  // 优先级：上游自己声明的 > 服务端全局配置 > 内置兜底。
  //
  // ⚠️ 这里曾经只认 `provider.timeoutMs`，**服务端配的超时根本没接进来**：
  //     relay-net.yaml 写着首字节 30 秒，实际生效的是内置兜底 `min(600000, 120000)`
  //     = **120 秒**，`upstreamTimeoutMs: 300000` 也没生效（实际 600 秒）。
  //     实测后果：上游装死时请求被吊 150 秒以上，客户先断（499）。
  const timeoutMs = provider.timeoutMs ?? defaults.timeoutMs ?? 600_000;
  // 配了就用配的；没配才退到内置兜底 —— 上限 120 秒只约束兜底值，
  // 不应该悄悄改写运营者显式写下的数字。
  const ttfbTimeoutMs = Math.min(defaults.ttfbTimeoutMs ?? Math.min(timeoutMs, 120_000), timeoutMs);
  // 停摆超时默认继承首字节超时：运营者说"30 秒没动静就算失败"，
  // 对"响应头"和"响应体"应该是同一个耐心。
  const stallTimeoutMs = Math.min(defaults.stallTimeoutMs ?? ttfbTimeoutMs, timeoutMs);
  const opts: SendOptions = {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.apiKeys ? { apiKeys: provider.apiKeys } : {}),
    timeoutMs,
    ttfbTimeoutMs,
    stallTimeoutMs,
    providerId: provider.id,
    protocol: provider.protocol,
    ...(provider.auth ? { auth: provider.auth } : {}),
    ...(provider.headers ? { extraHeaders: provider.headers } : {}),
    ...(defaults.userAgent ? { userAgent: defaults.userAgent } : {}),
    ...(provider.http2 ? { http2: true } : {}),
  };
  switch (provider.protocol) {
    case 'openai':
      return new OpenAICompatibleClient(opts);
    case 'anthropic':
    case 'gemini':
      // 协议适配位：接口已冻结，实现留待接入时补（当前回退到 OpenAI 兼容行为，
      // 若上游不是 OpenAI 兼容则会返回可归因的错误，而不是静默错误）
      return new OpenAICompatibleClient(opts);
    default: {
      const never: never = provider.protocol;
      throw new Error(`未知上游协议: ${String(never)}`);
    }
  }
}
