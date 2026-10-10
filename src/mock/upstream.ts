/**
 * Mock 上游：一个"会按剧本犯错"的 OpenAI 兼容服务。
 *
 * 为什么需要它：降损层的价值全部体现在**错误路径**上，而真实上游的错误不可控、
 * 不可复现。没有可控的错误注入，P3 归因与故障转移就只能靠祈祷。
 *
 * 支持：正常响应、SSE 流式、429/401/403/404/5xx/400、连接中断、TTFB 超时、
 * 内容过滤、上下文超限、余额不足、Retry-After 头、慢响应。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '../core/logger.js';
import { shortId } from '../util/index.js';

export interface MockScenario {
  status: number;
  /** 响应体（对象则 JSON 化；字符串原样） */
  body?: unknown;
  headers?: Record<string, string>;
  /** 延迟毫秒（模拟慢上游） */
  delayMs?: number;
  /** 首字节延迟（模拟 TTFB 超时） */
  ttfbDelayMs?: number;
  /** 每个 SSE chunk 之间的延迟（毫秒），模拟"头之后慢慢流"的上游 */
  chunkDelayMs?: number;
  /** 直接断开连接 */
  drop?: boolean;
  /**
   * 回了响应头就**永不发体**（模拟"上游装死"）。
   *
   * 与 `ttfbDelayMs` 的区别：那个延迟的是**响应头**（验首字节超时）；
   * 本场景响应头立刻到达、之后一个字节都没有 —— 正是 2026-09-13 Agnes 国际线路
   * 的真实故障形态：首字节定时器当场解除，只有"看数据还在不在流动"的看门狗能抓住。
   */
  stallAfterHeaders?: boolean;
  /** 流式场景下在第 N 个 chunk 中断 */
  streamInterruptAfter?: number;
}

export interface MockUpstreamOptions {
  port: number;
  host?: string;
  logger: Logger;
  /** 模型名 → 场景；未命中走 defaultScenario */
  scenarios?: Record<string, MockScenario>;
  defaultScenario?: MockScenario;
  /** 强制所有请求走某场景（用于单测） */
  forceScenario?: MockScenario | undefined;
  /** 只接受这些 key（Bearer 后面的值）；未设置则接受任意 key。用于多 key 池测试 */
  acceptedApiKeys?: string[];
  /** 请求计数（用于断言重试次数） */
  onRequest?: (info: { path: string; model: string; stream: boolean; attempt: number; scenario: string }) => void;
}

interface AttemptCounter {
  [model: string]: number;
}

export class MockUpstream {
  private server: http.Server | undefined;
  private readonly attempts: AttemptCounter = {};
  private requestCount = 0;
  readonly received: { path: string; model: string; stream: boolean; body: unknown; headers: Record<string, string> }[] = [];
  /** 场景覆盖：模型 → 依次使用的场景（用完走配置默认），便于测试"第一次失败第二次成功" */
  scenarioQueue = new Map<string, MockScenario[]>();

  constructor(private readonly opts: MockUpstreamOptions) {}

  /**
   * 运行时切换"强制场景"。
   * 测试用：模拟上游**中途恢复**（传 undefined）或**中途故障**（传 5xx 场景）——
   * 这是验证"熔断冷却后半开试探、成功就切回主用"的必要手段。
   */
  setForcedScenario(scenario: MockScenario | undefined): void {
    this.opts.forceScenario = scenario;
  }

  get url(): string {
    return `http://127.0.0.1:${this.boundPort}/v1`;
  }

  private boundPort = 0;

  async listen(): Promise<{ port: number; url: string }> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.opts.port, this.opts.host ?? '127.0.0.1', () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });
    const addr = this.server.address() as AddressInfo;
    this.boundPort = addr.port;
    this.opts.logger.info('mock.listening', { url: this.url });
    return { port: addr.port, url: this.url };
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  get count(): number {
    return this.requestCount;
  }

  attemptCount(model: string): number {
    return this.attempts[model] ?? 0;
  }

  reset(): void {
    this.requestCount = 0;
    for (const k of Object.keys(this.attempts)) delete this.attempts[k];
    this.received.length = 0;
    this.scenarioQueue.clear();
  }

  /** 排队若干场景：第 N 次请求用第 N 个场景（超出后用最后一个） */
  queueScenarios(model: string, scenarios: MockScenario[]): void {
    this.scenarioQueue.set(model, [...scenarios]);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.requestCount++;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      /* ignore */
    }
    const model = typeof body['model'] === 'string' ? (body['model'] as string) : '';
    const stream = body['stream'] === true;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;

    this.received.push({ path: req.url ?? '/', model, stream, body, headers });
    this.attempts[model] = (this.attempts[model] ?? 0) + 1;

    // key 白名单（多 key 池测试用）
    if (this.opts.acceptedApiKeys && this.opts.acceptedApiKeys.length > 0) {
      const auth = req.headers['authorization'] ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
      if (!this.opts.acceptedApiKeys.includes(token)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' },
          }),
        );
        return;
      }
    }

    // 模型名里带故障指令：mock-rate-limit-429 / mock-timeout / mock-drop / mock-401 …
    const directive = parseDirective(model);
    const queued = this.scenarioQueue.get(model)?.shift();
    const scenario =
      this.opts.forceScenario ??
      queued ??
      directive ??
      this.opts.scenarios?.[model] ??
      this.opts.defaultScenario ??
      { status: 200 };

    this.opts.onRequest?.({ path: req.url ?? '/', model, stream, attempt: this.attempts[model]!, scenario: describe(scenario) });

    if (scenario.drop) {
      req.socket.destroy();
      return;
    }
    if (scenario.ttfbDelayMs) await sleep(scenario.ttfbDelayMs);
    if (scenario.delayMs) await sleep(scenario.delayMs);

    // 装死：头照发，体永远不来。刻意不 end()、也不 destroy() ——
    // 连接一直开着，客户端只能靠"多久没数据"自己判死。
    if (scenario.stallAfterHeaders) {
      res.writeHead(200, { 'content-type': 'application/json', ...(scenario.headers ?? {}) });
      res.flushHeaders();
      return;
    }

    if (scenario.status !== 200) {
      const payload = scenario.body ?? defaultErrorBody(scenario.status, model);
      res.writeHead(scenario.status, {
        'content-type': 'application/json',
        ...(scenario.headers ?? {}),
      });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      return;
    }

    if (scenario.body !== undefined) {
      // 显式给了 body：200 也原样返回（供"成功但带特殊信号"的用例，
      // 比如 finish_reason=content_filter —— 老 mock 只在非 200 时用 body，
      // 200 的 body 被悄悄忽略，这种用例根本造不出来）
      res.writeHead(200, { 'content-type': 'application/json', ...(scenario.headers ?? {}) });
      res.end(typeof scenario.body === 'string' ? scenario.body : JSON.stringify(scenario.body));
      return;
    }

    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-small', object: 'model', created: 0, owned_by: 'mock' }] }));
      return;
    }

    if (req.url?.includes('/embeddings')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.01, 0.02, 0.03] }],
          model,
          usage: { prompt_tokens: 6, total_tokens: 6 },
        }),
      );
      return;
    }

    if (stream) {
      await this.writeStream(res, model, body, scenario);
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json', ...(scenario.headers ?? {}) });
    res.end(JSON.stringify(chatResponse(model, body)));
  }

  private async writeStream(
    res: http.ServerResponse,
    model: string,
    body: Record<string, unknown>,
    scenario: MockScenario,
  ): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...(scenario.headers ?? {}),
    });
    // **必须立刻把响应头推出去**：`streamInterruptAfter` 模拟的是"上游回了 200 头、
    // 然后一个字节都没发就断"（Agnes 国际那条线路的真实故障形态）。不 flush 的话
    // 客户端根本收不到响应头，看到的只是"连接失败"，两种故障模式会混在一起 ——
    // 2026-09-14 写回归测试时踩到：不 flush 时测试对修复前后都通过，等于没牙。
    res.flushHeaders();
    const id = `chatcmpl-mock${shortId(8)}`;
    const created = Math.floor(Date.now() / 1000);
    const wantsTools = Array.isArray(body['tools']) && (body['tools'] as unknown[]).length > 0;
    const chunks: string[] = [];

    chunks.push(
      sseFrame({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      }),
    );
    const text = ['你好', '，这是', ' mock 上游', '的流式', '响应。'];
    for (const piece of text) {
      chunks.push(
        sseFrame({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        }),
      );
    }
    if (wantsTools) {
      chunks.push(
        sseFrame({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: `call_${shortId(8)}`, type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] },
              finish_reason: null,
            },
          ],
        }),
      );
      chunks.push(
        sseFrame({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '"/tmp/demo.txt"}' } }] },
              finish_reason: null,
            },
          ],
        }),
      );
    }
    chunks.push(
      sseFrame({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: wantsTools ? 'tool_calls' : 'stop' }],
      }),
    );
    // 带 usage 的最终帧 —— **只有客户端明确要求才发**。真实 OpenAI 兼容上游就是这样：
    // 不带 `stream_options.include_usage` 就完全不回 usage。
    // mock 必须照着做，否则测试证明不了"是网关自己注入的"，只是白拿了一个假 usage。
    const streamOptions = body['stream_options'];
    const wantsUsage =
      streamOptions !== null &&
      typeof streamOptions === 'object' &&
      !Array.isArray(streamOptions) &&
      (streamOptions as Record<string, unknown>)['include_usage'] === true;
    if (wantsUsage) {
      chunks.push(
        sseFrame({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59, prompt_tokens_details: { cached_tokens: 8 } },
        }),
      );
    }

    const interruptAfter = scenario.streamInterruptAfter;
    for (let i = 0; i < chunks.length; i++) {
      if (interruptAfter !== undefined && i >= interruptAfter) {
        res.socket?.destroy();
        return;
      }
      res.write(chunks[i]);
      // chunkDelayMs：模拟"头之后慢慢流"的上游（整体超时审计 D-P0-2 需要这个形态）
      await sleep(scenario.chunkDelayMs ?? 8);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

function describe(s: MockScenario): string {
  if (s.drop) return 'drop';
  if (s.streamInterruptAfter !== undefined) return `stream_interrupt_after_${s.streamInterruptAfter}`;
  return `status_${s.status}${s.delayMs ? `_delay${s.delayMs}` : ''}`;
}

/** 从模型名解析故障指令，方便手工联调：mock-429 / mock-500 / mock-401 / mock-drop / mock-timeout */
export function parseDirective(model: string): MockScenario | undefined {
  const m = /mock-(429|401|403|noperm|404|500|502|503|400|drop|timeout|stall|filter|context|balance)(?:-(\d+))?/.exec(model);
  if (!m) return undefined;
  const kind = m[1]!;
  switch (kind) {
    case '429':
      return { status: 429, headers: { 'retry-after': m[2] ?? '1' }, body: { error: { message: 'Rate limit reached for requests', type: 'rate_limit_error', code: 'rate_limit_exceeded' } } };
    case '401':
      return { status: 401, body: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } } };
    case '403':
      // 注意与 noperm 的区别：403 也可能是内容安全，两者归因完全不同
      return { status: 403, body: { error: { message: '内容安全策略拦截：sensitive content detected', code: 'content_policy_violation' } } };
    case 'noperm':
      // 真·权限 403：这个 key 没有这个模型的权限（模型级问题，不该判死整个供应商）
      return { status: 403, body: { error: { message: 'You do not have permission to access this model', type: 'invalid_request_error', code: 'permission_denied' } } };
    case '404':
      return { status: 404, body: { error: { message: `The model \`${model}\` does not exist`, type: 'invalid_request_error', code: 'model_not_found' } } };
    case '400':
      return { status: 400, body: { error: { message: 'This model maximum context length is 8192 tokens', type: 'invalid_request_error', code: 'context_length_exceeded' } } };
    case '500':
      return { status: 500, body: { error: { message: 'internal server error', type: 'server_error' } } };
    case '502':
      return { status: 502, body: '<html><body><h1>502 Bad Gateway</h1></body></html>' };
    case '503':
      return { status: 503, body: { error: { message: 'The engine is currently overloaded, please try again later', type: 'server_error', code: 'overloaded' } } };
    case 'drop':
      return { status: 200, drop: true };
    case 'timeout':
      return { status: 200, ttfbDelayMs: m[2] ? Number(m[2]) : 900_000 };
    case 'stall':
      // 头立刻回、体永不来（验停摆超时；timeout 验的是首字节超时，两者不同）
      return { status: 200, stallAfterHeaders: true };
    case 'filter':
      return { status: 400, body: { error: { message: 'Your request was flagged by our content filter', type: 'invalid_request_error', code: 'content_filter' } } };
    case 'context':
      return { status: 400, body: { error: { message: 'maximum context length exceeded, please reduce the length of the messages', code: 'context_length_exceeded' } } };
    case 'balance':
      return { status: 402, body: { error: { message: 'Insufficient Balance', type: 'insufficient_quota', code: 'insufficient_balance' } } };
    default:
      return undefined;
  }
}

function defaultErrorBody(status: number, model: string): unknown {
  return { error: { message: `mock upstream error ${status} for model ${model}`, type: status >= 500 ? 'server_error' : 'invalid_request_error', code: `mock_${status}` } };
}

function chatResponse(model: string, body: Record<string, unknown>): unknown {
  const wantsTools = Array.isArray(body['tools']) && (body['tools'] as unknown[]).length > 0;
  const promptTokens = Math.max(1, Math.ceil(JSON.stringify(body['messages'] ?? []).length / 4));
  const message: Record<string, unknown> = wantsTools
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `call_${shortId(8)}`,
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/demo.txt' }) },
          },
        ],
      }
    : { role: 'assistant', content: '这是 mock 上游的非流式响应。' };
  return {
    id: `chatcmpl-mock${shortId(8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: wantsTools ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: 12, total_tokens: promptTokens + 12, prompt_tokens_details: { cached_tokens: 4 } },
  };
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
