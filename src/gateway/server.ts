/**
 * HTTP 传输层（node:http，零依赖）。
 *
 * 职责仅限于传输：解析请求、注入 requestId、把 EngineResult 写成 HTTP 响应、
 * 处理客户端断开与优雅退出。所有业务语义都在 Engine 内。
 *
 * 流式响应额外做两件事：
 *   1. 逐字节原样转发上游 SSE，不做任何重新分帧（保护 SSE 语义）。
 *   2. 统计转发字节数，在流结束时调用 onEnd 写入度量与轨迹。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Engine } from './engine.js';
import type { EngineResult, EngineStream } from './protocol.js';
import type { RelayConfig } from '../core/types.js';
import { Logger } from '../core/logger.js';
import { shortId } from '../util/index.js';
import type { AdminApi } from '../admin/api.js';

export interface ServerDeps {
  config: RelayConfig;
  engine: Engine;
  admin: AdminApi;
  logger: Logger;
  /** 知识库（垂直 Agent 能力；未启用时 undefined） */
  kb?: import('../kb/store.js').KbStore | undefined;
  /** key 注册表（用于 KB allowedKeys 校验） */
  keys?: import('./keys.js').KeyRegistry | undefined;
}

const RELAY_VERSION = '0.1.0';

export class RelayServer {
  private readonly server: http.Server;
  private readonly inflight = new Set<AbortController>();
  private startedAt = Date.now();
  private requestCount = 0;

  constructor(private readonly deps: ServerDeps) {
    this.server = http.createServer((req, res) => {
      void this.onRequest(req, res).catch((err) => {
        this.deps.logger.error('http.unhandled', { error: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: '中转站内部错误',
                type: 'relay_internal_error',
                param: null,
                code: 'relay_internal_error',
                relay_attribution: {
                  failure_reason: 'relay_internal_error',
                  suggested_next: { action: 'retry_same' },
                  recoverable: true,
                  upstream: 'relay',
                  confidence: 0.5,
                },
              },
            }),
          );
        } else {
          res.destroy();
        }
      });
    });
    this.server.keepAliveTimeout = 65_000;
    this.server.headersTimeout = 70_000;
  }

  async listen(): Promise<{ host: string; port: number; url: string }> {
    const { host, port } = this.deps.config.server;
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    const addr = this.server.address() as AddressInfo;
    const actualHost = addr.address === '::' || addr.address === '0.0.0.0' ? '127.0.0.1' : addr.address;
    return { host: addr.address, port: addr.port, url: `http://${actualHost}:${addr.port}` };
  }

  async close(graceMs = 5_000): Promise<void> {
    for (const c of this.inflight) c.abort();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.server.closeAllConnections?.();
        resolve();
      }, graceMs);
      this.server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  get uptimeMs(): number {
    return Date.now() - this.startedAt;
  }

  get stats(): { requestCount: number; inflight: number; uptimeMs: number } {
    return { requestCount: this.requestCount, inflight: this.inflight.size, uptimeMs: this.uptimeMs };
  }

  /* ------------------------------------------------------------------ */

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = `req_${shortId(16)}`;
    this.requestCount++;
    const startedAt = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const headers = normalizeHeaders(req.headers);

    this.setCommonHeaders(res, requestId);

    /* ---------- 无鉴权的探活与管理入口 ---------- */
    if (req.method === 'GET' && (path === '/healthz' || path === '/health')) {
      const payload = {
        status: 'ok',
        version: RELAY_VERSION,
        uptimeMs: this.uptimeMs,
        requestCount: this.requestCount,
        inflight: this.inflight.size,
        ...this.deps.admin.health(),
      };
      return this.writeJson(res, 200, JSON.stringify(payload));
    }

    if (path === '/') {
      return this.writeJson(
        res,
        200,
        JSON.stringify({
          name: 'api-relay',
          version: RELAY_VERSION,
          description: 'OpenAI 兼容的模型 API 聚合中转站，内嵌传话层工程降损（P2 预检 / P3 失败归因 / P8 损耗度量）',
          endpoints: {
            chat: 'POST /v1/chat/completions',
            embeddings: 'POST /v1/embeddings',
            completions: 'POST /v1/completions',
            models: 'GET /v1/models',
            health: 'GET /healthz',
            admin: 'GET /admin/api/overview（需 X-Admin-Token）',
            explain: 'GET /v1/attribution/catalog（错误归因目录，便于客户端预先处理）',
          },
          loss_reduction: {
            precheck: 'P2 调用前意图预检（fail-open）',
            attribution: 'P3 失败归因卡片（不改写成功响应）',
            meter: 'P8 损耗量化基线',
            trace: 'P5 请求级轨迹（GET /admin/api/traces）',
          },
        }),
      );
    }

    if (path.startsWith('/admin')) {
      const handled = await this.deps.admin.handle(req, res, url, headers, requestId);
      if (handled) return;
      return this.writeJson(res, 404, JSON.stringify({ error: { message: `未知管理接口 ${path}`, type: 'not_found_error', code: 'not_found' } }));
    }

    /* ---------- 本机只读端点（供本机面板/插件读取，默认不对外） ----------
     * 存在理由：本机面板与 DSH 插件需要读用量，而插件的 HTTP 客户端（web.fetch）
     * 不能带自定义 header，所以没法用带令牌的管理接口。
     *
     * **安全边界（重要）**：这两个端点会暴露用量计数、请求轨迹（含上游错误文案）、
     * key 列表与上游信息。所以默认**只允许来自 127.0.0.1/::1 的请求**——
     * 一旦把网关绑到 0.0.0.0 对外提供服务，局域网/公网访问者仍然读不到这些数据。
     *
     * 确实需要远程读（例如面板跑在另一台机器）时，显式打开：
     *   server.publicQuotaRemote: true
     * 并自行用反代做 IP 白名单——这两个端点没有别的权限校验。
     */
    if (req.method === 'GET' && (path === '/v1/quota' || path === '/v1/panel')) {
      if (this.deps.config.server.publicQuota === false) {
        return this.writeJson(res, 404, JSON.stringify({ error: { message: '该端点已关闭', type: 'not_found_error', code: 'disabled' } }));
      }
      const remote = req.socket.remoteAddress ?? '';
      const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      if (!isLocal && this.deps.config.server.publicQuotaRemote !== true) {
        return this.writeJson(res, 403, JSON.stringify({
          error: {
            message: '该端点仅允许本机访问（它暴露用量与轨迹，不对局域网/公网开放）。远程读取请用反代做 IP 白名单并设 server.publicQuotaRemote: true',
            type: 'permission_error',
            code: 'local_only',
          },
        }));
      }
      return this.writeJson(res, 200, JSON.stringify(path === '/v1/quota' ? this.deps.admin.publicQuota() : this.deps.admin.publicPanel(url)));
    }

    /* ---------- 静态的错误归因目录（客户端可预先拉取） ---------- */
    if (req.method === 'GET' && path === '/v1/attribution/catalog') {
      return this.writeJson(res, 200, JSON.stringify(this.deps.admin.attributionCatalog()));
    }

    if (req.method === 'GET' && path === '/v1/models') {
      // 带上有效 key 时按该 key 的白名单过滤：清单必须只说这个 key 能用的东西，
      // 否则客户会选中调不了的模型、被 403 挡回，误以为"key 坏了"（实测踩过）。
      const models = this.deps.admin.modelList(req.headers.authorization);
      return this.writeJson(res, 200, JSON.stringify({ object: 'list', data: models }));
    }

    /* ---------- 知识库垂直 Agent 端点 /v1/kb/{id}/ask ---------- */
    // 形如 /v1/kb/{kbId}/ask：带 key 鉴权，检索该 KB 后把命中块注入 system 消息，
    // 再以改写的请求体转发到 /v1/chat/completions（走原有引擎全链路：鉴权/预检/路由/归因/计量）。
    const kbAskMatch = /^\/v1\/kb\/([^/]+)\/ask$/.exec(path);
    if (kbAskMatch && req.method === 'POST') {
      const kb = this.deps.kb;
      if (!kb || !kb.ok) {
        return this.writeJson(res, 503, JSON.stringify({
          error: { message: '知识库未启用或不可用', type: 'kb_unavailable', param: null, code: 'kb_unavailable' },
        }));
      }
      const body = await this.readBody(req, res);
      if (body === undefined) return;
      const kbId = decodeURIComponent(kbAskMatch[1]!);
      if (!kb.getKb(kbId)) {
        return this.writeJson(res, 404, JSON.stringify({
          error: { message: `知识库不存在: ${kbId}`, type: 'not_found_error', param: null, code: 'kb_not_found' },
        }));
      }
      // 解析请求体
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
      } catch {
        return this.writeJson(res, 400, JSON.stringify({
          error: { message: '请求体不是合法 JSON', type: 'invalid_request_error', param: null, code: 'invalid_json' },
        }));
      }
      const question = String(payload['question'] ?? payload['query'] ?? '').trim();
      const topK = Math.min(20, Math.max(1, Number(payload['topK'] ?? 5)));
      if (!question) {
        return this.writeJson(res, 400, JSON.stringify({
          error: { message: 'question 必填（知识库问答）', type: 'invalid_request_error', param: 'question', code: 'question_required' },
        }));
      }
      // ① 鉴权 + allowedKeys 校验：取调用者的 keyId，检查该 KB 是否允许这把 key 访问
      const authHeader = headers['authorization'] ?? '';
      const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
      let keyId: string | undefined;
      if (bearer && this.deps.keys) {
        const r = this.deps.keys.resolveSecret(bearer);
        if (r.found && r.status === 'ok' && r.key) keyId = r.key.id;
      }
      const kbRec = kb.getKb(kbId);
      if (kbRec && kbRec.allowedKeys !== '*') {
        const allowed = kbRec.allowedKeys.split(',').map((s) => s.trim()).filter(Boolean);
        if (!keyId || !allowed.includes(keyId)) {
          return this.writeJson(res, 403, JSON.stringify({
            error: { message: `知识库 ${kbId} 不允许 key ${keyId ?? '(未识别)'} 访问`, type: 'permission_error', param: null, code: 'kb_forbidden' },
          }));
        }
      }
      const hits = kb.search(kbId, question, topK);
      const context = hits.length > 0
        ? hits.map((h, i) => `[${i + 1}] (${h.docTitle}) ${h.text}`).join('\n\n')
        : '';
      // 构造注入后的 messages：把检索命中塞进 system，保留原 messages
      const origMessages = Array.isArray(payload['messages']) ? (payload['messages'] as unknown[]) : [];
      const systemNote = context
        ? '【以下是该知识库的检索结果，回答时优先引用，标注 [序号]】\n' + context
        : '【该知识库未检索到相关内容，请基于你的知识回答，并说明知识库无命中】';
      const newMessages: unknown[] = [];
      // 若原 messages 已有 system 则追加到其后，否则插在最前
      let systemSeen = false;
      for (const m of origMessages) {
        if (typeof m === 'object' && m !== null && (m as { role?: string }).role === 'system') systemSeen = true;
        newMessages.push(m);
      }
      const sysMsg = { role: 'system', content: systemNote };
      if (systemSeen) {
        // 找到第一个 system 之后插入
        const idx = newMessages.findIndex((m) => (typeof m === 'object' && m !== null && (m as { role?: string }).role === 'system'));
        newMessages.splice(idx + 1, 0, sysMsg);
      } else {
        newMessages.unshift(sysMsg);
      }
      // 始终在末尾追加 question 作为 user 消息（客户端可能只传 question 不传 messages）
      newMessages.push({ role: 'user', content: question });
      const rewritten = { ...payload, messages: newMessages, _kb: { id: kbId, hits: hits.length, context } };
      const newRaw = new Uint8Array(Buffer.from(JSON.stringify(rewritten)));
      // 走引擎（把 path 改回 chat/completions，让鉴权/路由/计量照旧；但保留原始 path 在头里）
      const controller = new AbortController();
      this.inflight.add(controller);
      const onClose = (): void => { if (!res.writableEnded) controller.abort(); };
      res.on('close', onClose);
      // 与正常路径一致：起 heartbeat + 不在 writeResult 前提前 abort controller
      const heartbeat = this.startStreamHeartbeat(res, '/v1/chat/completions', newRaw);
      try {
        const result = await this.deps.engine.handle({
          method: 'POST',
          path: '/v1/chat/completions',
          headers: { ...headers, 'x-kb-id': kbId, 'x-kb-hits': String(hits.length) },
          rawBody: newRaw,
          signal: controller.signal,
          requestId,
        });
        heartbeat.stop();
        await this.writeResult(res, result, requestId, heartbeat.committed);
      } finally {
        heartbeat.dispose();
        this.inflight.delete(controller);
        res.removeListener('close', onClose);
      }
      this.deps.logger.debug('http.kb_ask', { requestId, kbId, hits: hits.length });
      return;
    }

    /* ---------- 业务端点 ---------- */
    const supported = ['/v1/chat/completions', '/v1/embeddings', '/v1/completions', '/v1/responses', '/v1/messages'];
    if (!supported.includes(path)) {
      return this.writeJson(
        res,
        404,
        JSON.stringify({
          error: {
            message: `未知端点 ${path}。支持的端点: ${supported.join(', ')}`,
            type: 'invalid_request_error',
            param: null,
            code: 'unknown_endpoint',
          },
        }),
      );
    }

    if (req.method !== 'POST') {
      return this.writeJson(
        res,
        405,
        JSON.stringify({
          error: {
            message: `${path} 只接受 POST，收到 ${req.method}`,
            type: 'invalid_request_error',
            param: null,
            code: 'method_not_allowed',
          },
        }),
      );
    }

    const body = await this.readBody(req, res);
    if (body === undefined) return; // 已响应（超限/错误）

    const controller = new AbortController();
    this.inflight.add(controller);
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);

    const heartbeat = this.startStreamHeartbeat(res, path, body);
    try {
      const result = await this.deps.engine.handle({
        method: req.method,
        path,
        headers,
        rawBody: body,
        signal: controller.signal,
        requestId,
      });
      heartbeat.stop();
      await this.writeResult(res, result, requestId, heartbeat.committed);
      this.deps.logger.debug('http.done', {
        requestId,
        path,
        status: result.status,
        durationMs: Date.now() - startedAt,
        kind: result.kind,
      });
    } finally {
      heartbeat.dispose();
      this.inflight.delete(controller);
      res.removeListener('close', onClose);
    }
  }

  /* ------------------------------------------------------------------ */

  private setCommonHeaders(res: ServerResponse, requestId: string): void {
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-relay-version', RELAY_VERSION);
  }

  private async readBody(req: IncomingMessage, res: ServerResponse): Promise<Uint8Array | undefined> {
    const limit = this.deps.config.server.maxBodyBytes;
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        const buf = chunk as Buffer;
        total += buf.byteLength;
        if (total > limit) {
          req.destroy();
          this.writeJson(
            res,
            413,
            JSON.stringify({
              error: {
                message: `请求体超过网关上限 ${limit} 字节`,
                type: 'request_too_large',
                param: null,
                code: 'request_too_large',
                relay_attribution: {
                  failure_reason: 'invalid_request',
                  suggested_next: { action: 'reduce_context' },
                  recoverable: true,
                  upstream: 'relay',
                  confidence: 1,
                },
              },
            }),
          );
          return undefined;
        }
        chunks.push(buf);
      }
    } catch {
      if (!res.headersSent) this.writeJson(res, 400, JSON.stringify({ error: { message: '读取请求体失败', type: 'invalid_request_error', code: 'body_read_failed' } }));
      return undefined;
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  private async writeResult(res: ServerResponse, result: EngineResult, requestId: string, earlyCommitted = false): Promise<void> {
    if (result.kind === 'json') {
      if (earlyCommitted) {
        /*
         * 已经以 SSE 200 提前提交，HTTP 状态码改不了了。此时才失败的请求
         * （通常是上游在宽限之后才报错）只能用一个 SSE 错误帧告知客户端，
         * 然后收尾。这是提前提交的已知代价，记一条 warn 便于对账。
         */
        this.deps.logger.warn('http.stream_early_commit_error', { requestId, status: result.status });
        if (!res.writableEnded && !res.destroyed) {
          res.write('data: ' + result.body + '\n\n');
          res.end();
        }
        return;
      }
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.writeHead(result.status);
      res.end(result.body);
      return;
    }
    await this.writeStream(res, result, requestId, earlyCommitted);
  }

  private async writeStream(res: ServerResponse, result: EngineStream, requestId: string, earlyCommitted = false): Promise<void> {
    if (!earlyCommitted) {
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
      res.writeHead(result.status);
    }

    const reader = result.stream.getReader();
    let bytes = 0;
    let aborted = false;
    let clientGone = false;
    try {
      for (;;) {
        /*
         * 客户端已经断开就**立刻停手**（2026-09-14 审计实测的 P0）。
         *
         * 老代码只有下面那个 `await drain`，而客户端断开时 `res.write()` 返回 false
         * 且 **'drain' 永远不会触发** → 这个 await 永久挂起 → 请求既不进计量也不进轨迹、
         * `finally` 永不执行 → inflight 单调上涨、上游流一直读到尾（我们白付钱）。
         * 所以：① 每轮先看 res 还在不在；② 等 drain 时同时监听 close/error，断开即返回。
         */
        if (res.destroyed || res.writableEnded) {
          clientGone = true;
          aborted = true;
          break;
        }
        // **整体超时硬截止**（审计 D-P0-2）：首块之后本来没有任何看门狗，
        // 上游"头之后慢慢流"就能无限期挂住。到点就截断并记 aborted，
        // 否则面板上的"单次请求总上限"只是假话。
        if (result.deadlineAt !== undefined && Date.now() > result.deadlineAt) {
          aborted = true;
          this.deps.logger.warn('http.stream_deadline', {
            requestId,
            deadlineMs: this.deps.config.server.upstreamTimeoutMs,
          });
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytes += value.byteLength;
          if (!res.write(Buffer.from(value))) {
            await new Promise<void>((resolve) => {
              const done = (): void => {
                res.off('drain', done);
                res.off('close', done);
                res.off('error', done);
                resolve();
              };
              res.once('drain', done);
              res.once('close', done);
              res.once('error', done);
            });
          }
        }
      }
      // 截止截断：客户端还在，**优雅收尾**（EOF 但没有 [DONE] = 截断信号，SSE 客户端能识别）。
      // 客户端已走：没人听，直接 destroy。
      if (clientGone) {
        if (!res.destroyed) res.destroy();
      } else {
        res.end();
      }
    } catch (err) {
      aborted = true;
      this.deps.logger.warn('http.stream_error', { requestId, error: err instanceof Error ? err.message : String(err) });
      if (!res.writableEnded) res.destroy();
    } finally {
      try {
        // 客户端走了就别再拉着上游流跑了（否则我们继续为拿不到的 token 付费）。
        // ⚠️ **不能 await**：这支可能是 tee 的一支，而 tee 支的 cancel 在"源没数据"时
        // 永不 settle（同 client.ts 里那处，审计实测过）。发起即可，不等它。
        if (aborted) void Promise.resolve(reader.cancel()).catch(() => undefined);
      } catch {
        /* ignore */
      }
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
      try {
        // await：流式记账要等旁路 transcript 解析完（见 EngineStream.onEnd 的说明）
        await result.onEnd({ bytes, aborted, transcriptChars: 0 });
      } catch (err) {
        this.deps.logger.warn('http.stream_onend_failed', { requestId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /**
   * 流式请求的"提前提交 + 心跳"。
   *
   * 只在配置开启（streamCommitGraceMs > 0）且客户端确实要流式时生效：
   * 等待超过宽限仍未拿到上游内容，就先提交 200 + SSE 头，再周期性写
   * `: keepalive` 注释行，避免客户端/中间代理由"长时间零字节"判死。
   * 引擎返回后调用 stop()，在 finally 里再 dispose()（幂等）。
   */
  private startStreamHeartbeat(
    res: ServerResponse,
    path: string,
    body: Uint8Array,
  ): { committed: boolean; stop: () => void; dispose: () => void } {
    const grace = this.deps.config.server.streamCommitGraceMs ?? 0;
    const disabled = { committed: false, stop: (): void => undefined, dispose: (): void => undefined };
    if (grace <= 0 || !this.isStreamRequest(path, body)) return disabled;

    const intervalMs = Math.max(1_000, this.deps.config.server.streamHeartbeatMs ?? 5_000);
    let committed = false;
    let hbTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      if (res.headersSent || res.destroyed || res.writableEnded) return;
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
      res.writeHead(200);
      res.write(': relay-waiting\n\n');
      committed = true;
      hbTimer = setInterval(() => {
        if (res.destroyed || res.writableEnded) return;
        res.write(': keepalive\n\n');
      }, intervalMs);
      hbTimer.unref();
    }, grace);
    graceTimer.unref();

    const clear = (): void => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      if (hbTimer) {
        clearInterval(hbTimer);
        hbTimer = undefined;
      }
    };
    return {
      get committed(): boolean {
        return committed;
      },
      stop: clear,
      dispose: clear,
    };
  }

  /** 只有请求体里 stream:true 的才是 SSE；非流式没有"提前提交"的空间。 */
  private isStreamRequest(path: string, body: Uint8Array): boolean {
    if (!path.startsWith('/v1/')) return false;
    try {
      const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as { stream?: unknown };
      return parsed !== null && typeof parsed === 'object' && parsed.stream === true;
    } catch {
      return false;
    }
  }

  private writeJson(res: ServerResponse, status: number, body: string): void {
    if (res.headersSent) return;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.writeHead(status);
    res.end(body);
  }
}

function normalizeHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
  }
  return out;
}

