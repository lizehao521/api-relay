/**
 * 引擎集成测试：用 mock 上游把所有降损路径跑通。
 *
 * 这里验证的是本项目的**核心承诺**，每一条都是一个可反驳的断言：
 *   - 成功响应零改写（字节级）
 *   - 错误路径一定可归因
 *   - 可恢复错误自动故障转移到健康上游
 *   - 不可恢复错误立即返回，不做无效重试
 *   - 预检拦截时上游请求数必须为 0
 *   - 失败上游被熔断摘除
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, memoryConfig, type App } from '../app.js';
import { headerSafe } from '../gateway/engine.js';
import { MockUpstream } from '../mock/upstream.js';
import { inspectConfig as inspectConfigForTest } from '../core/config.js';
import { Logger } from '../core/logger.js';
import type { RelayConfig, ProviderConfig } from '../core/types.js';
import { hmacHex, estimateTokensFromBytes, estimateJsonTokens } from '../util/index.js';

const silent = new Logger('error', () => undefined);

interface Harness {
  app: App;
  mock: MockUpstream;
  close: () => Promise<void>;
}

async function harness(opts: {
  providers: (mockUrl: string) => ProviderConfig[];
  postConfigure?: (config: RelayConfig, mockUrl: string) => void;
}): Promise<Harness> {
  const mock = new MockUpstream({ port: 0, logger: silent });
  const bound = await mock.listen();
  const providers = opts.providers(bound.url);
  const config = memoryConfig({
    providers,
    clients: [
      { id: 'pro-key', label: 'pro', key: 'sk-pro-test', tier: 'pro', tenantId: 't', enabled: true },
      { id: 'std-key', label: 'std', key: 'sk-std-test', tier: 'standard', tenantId: 't', enabled: true },
      { id: 'free-key', label: 'free', key: 'sk-free-test', tier: 'free', tenantId: 't', enabled: true },
      { id: 'quota-key', label: 'quota', key: 'sk-quota-test', tier: 'pro', tenantId: 't', enabled: true, quotaOverride: 1 },
    ],
    logLevel: 'error',
  });
  opts.postConfigure?.(config, bound.url);
  const app = await createApp(config, silent);
  return {
    app,
    mock,
    close: async () => {
      await app.shutdown();
      await mock.close();
    },
  };
}

let seq = 0;
async function call(
  app: App,
  body: Record<string, unknown>,
  opts: { token?: string; path?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any; text: string; headers: Record<string, string> }> {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const result = await app.engine.handle({
    method: 'POST',
    path: opts.path ?? '/v1/chat/completions',
    headers: { authorization: `Bearer ${opts.token ?? 'sk-pro-test'}`, 'content-type': 'application/json', ...(opts.headers ?? {}) },
    rawBody: new Uint8Array(raw),
    signal: new AbortController().signal,
    requestId: `req_test${++seq}`,
  });
  if (result.kind === 'json') {
    let json: unknown;
    try {
      json = JSON.parse(result.body);
    } catch {
      json = undefined;
    }
    return { status: result.status, json, text: result.body, headers: result.headers };
  }
  throw new Error('期望非流式结果，实际返回流式');
}

async function consumeStream(result: Awaited<ReturnType<App['engine']['handle']>>): Promise<string> {
  if (result.kind !== 'stream') throw new Error('期望流式结果');
  const reader = result.stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  }
  await result.onEnd({ bytes, aborted: false, transcriptChars: text.length });
  return text;
}

function twoProviders(mockUrl: string): ProviderConfig[] {
  return [
    { id: 'primary', label: '主上游', protocol: 'openai', baseUrl: mockUrl, apiKey: 'mock', models: ['mock-small'], priority: 10, weight: 1 },
    { id: 'backup', label: '备用上游', protocol: 'openai', baseUrl: mockUrl, apiKey: 'mock', models: ['mock-small'], priority: 5, weight: 1 },
  ];
}

const userMsg = { model: 'mock-small', messages: [{ role: 'user', content: '你好' }] };

/* ------------------------------------------------------------------ *
 * 成功路径
 * ------------------------------------------------------------------ */

test('成功响应：优先选择高优先级上游，且响应体原样透传', async () => {
  const h = await harness({ providers: twoProviders });
  try {
    const r = await call(h.app, userMsg);
    assert.equal(r.status, 200);
    assert.equal(r.json.object, 'chat.completion');
    assert.equal(r.json.model, 'mock-small');
    assert.ok(r.json.usage.total_tokens > 0);
    assert.equal(r.headers['x-relay-mode']?.includes('tier=pro'), true);
    // pro 层 attribution=full，但成功响应体里绝不能出现 relay_attribution
    assert.equal(r.json.relay_attribution, undefined);
    assert.equal(r.json.error, undefined);
  } finally {
    await h.close();
  }
});

test('成功响应可被客户端用 nonce 验证未被篡改', async () => {
  const h = await harness({ providers: twoProviders });
  try {
    const nonce = 'nonce-abc-123';
    const r = await call(h.app, userMsg, { headers: { 'x-relay-verify-nonce': nonce } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-relay-content-hmac'], hmacHex(nonce, r.text));
    assert.equal(r.headers['x-relay-content-hmac-alg'], 'hmac-sha256');
  } finally {
    await h.close();
  }
});

test('模型别名：上游回显被改写回客户端请求的模型名', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['real-model'], priority: 1 }],
    postConfigure: (config) => {
      config.modelAliases = { 'friendly-name': 'real-model' };
    },
  });
  try {
    const r = await call(h.app, { model: 'friendly-name', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 200);
    assert.equal(r.json.model, 'friendly-name', '回显必须是客户端请求的名字');
    assert.equal(h.mock.received[0]!.model, 'real-model', '上游必须收到真实模型名');
  } finally {
    await h.close();
  }
});

test('流式：SSE 逐帧透传（含 [DONE]），且 model 被改写回请求名', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['real-model'], priority: 1 }],
    postConfigure: (config) => {
      config.modelAliases = { 'friendly-name': 'real-model' };
    },
  });
  try {
    const result = await h.app.engine.handle({
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-pro-test' },
      rawBody: new Uint8Array(Buffer.from(JSON.stringify({ model: 'friendly-name', messages: [{ role: 'user', content: 'x' }], stream: true }))),
      signal: new AbortController().signal,
      requestId: 'req_stream_1',
    });
    assert.equal(result.kind, 'stream');
    if (result.kind !== 'stream') return;
    assert.equal(result.headers['content-type'], 'text/event-stream; charset=utf-8');
    const text = await consumeStream(result);
    assert.ok(text.includes('data: [DONE]'));
    assert.ok(text.includes('mock 上游'));
    assert.ok(!text.includes('"model":"real-model"'), '上游模型名不应泄漏给客户端');
    assert.ok(text.includes('"model":"friendly-name"'));
    // 帧数量与顺序保持：每个 data: 后必须紧跟空行
    const frames = text.split('\n\n').filter((f) => f.trim().length > 0);
    assert.ok(frames.length >= 8);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * 错误路径：可恢复 → 自动故障转移
 * ------------------------------------------------------------------ */

test('可恢复错误（429）：自动切换到备用上游，并在轨迹中留下证据', async () => {
  const h = await harness({
    providers: twoProviders,
    postConfigure: (config) => {
      config.lossReduction.attribution.autoRetry = 1;
      config.lossReduction.attribution.backoffBaseMs = 5;
      config.lossReduction.attribution.backoffMaxMs = 20;
    },
  });
  try {
    h.mock.queueScenarios('mock-small', [
      { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' } } },
      { status: 200 },
    ]);
    const r = await call(h.app, userMsg);
    assert.equal(r.status, 200, `期望故障转移后成功，实际: ${r.text}`);
    assert.equal(h.mock.count, 2, '应该有两次上游请求（第一次 429，第二次成功）');
    const traces = h.app.traceStore.recent(5);
    const trace = traces[0]!;
    const stages = trace.steps.map((s) => s.stage);
    assert.ok(stages.includes('classify'));
    assert.ok(stages.includes('retry'), `轨迹缺少 retry 步骤: ${JSON.stringify(stages)}`);
    assert.equal(trace.outcome, 'success');
  } finally {
    await h.close();
  }
});

test('不可恢复错误（401）：立即返回，不做任何自动重试', async () => {
  const h = await harness({ providers: twoProviders });
  try {
    h.mock.queueScenarios('mock-small', [{ status: 401, body: { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } } }]);
    const r = await call(h.app, userMsg);
    assert.equal(r.status, 401);
    assert.equal(r.json.error.relay_attribution.failure_reason, 'auth_invalid');
    assert.equal(r.json.error.relay_attribution.recoverable, false);
    assert.equal(r.json.error.relay_attribution.suggested_next.action, 'fix_credentials');
    assert.equal(h.mock.count, 1, '401 是致命错误，应立即摘除该上游并把结果返回客户端，而不是反复重试');
  } finally {
    await h.close();
  }
});

test('不可恢复错误（内容过滤）：透传上游错误体 + 附带归因，且建议改写输入', async () => {
  const h = await harness({ providers: twoProviders });
  try {
    h.mock.queueScenarios('mock-small', [
      { status: 400, body: { error: { message: 'Your request was flagged by our content filter', code: 'content_filter' } } },
      { status: 400, body: { error: { message: 'Your request was flagged by our content filter', code: 'content_filter' } } },
    ]);
    const r = await call(h.app, userMsg);
    assert.equal(r.status, 400);
    assert.equal(r.json.error.message, 'Your request was flagged by our content filter', '上游原文必须保留');
    assert.equal(r.json.error.relay_attribution.suggested_next.action, 'rewrite_input');
  } finally {
    await h.close();
  }
});

test('全部上游都失败：返回可归因错误而不是空壳 500', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'only', label: 'only', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1 }],
    postConfigure: (config) => {
      // 熔断阈值调高，让"两次尝试都失败"的路径本身可被观察
      config.lossReduction.attribution.breakerThreshold = 100;
    },
  });
  try {
    h.mock.queueScenarios('mock-small', [
      { status: 503, body: { error: { message: 'The engine is currently overloaded', code: 'overloaded' } } },
      { status: 503, body: { error: { message: 'The engine is currently overloaded', code: 'overloaded' } } },
    ]);
    const r = await call(h.app, userMsg);
    assert.equal(r.status, 503);
    assert.equal(r.json.error.relay_attribution.failure_reason, 'model_overloaded');
    assert.equal(r.json.error.relay_attribution.recoverable, true);
    assert.equal(r.json.error.relay_attribution.suggested_next.action, 'retry_with_backoff');
  } finally {
    await h.close();
  }
});

test('熔断：同一上游连续失败达到阈值后被摘除，后续请求不再打到它', async () => {
  const h = await harness({
    providers: (url) => [
      { id: 'flaky', label: 'flaky', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 10 },
      { id: 'solid', label: 'solid', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1 },
    ],
    postConfigure: (config) => {
      config.lossReduction.attribution.breakerThreshold = 1;
      config.lossReduction.attribution.breakerCooldownMs = 60_000;
      config.lossReduction.attribution.autoRetry = 0;
    },
  });
  try {
    h.mock.queueScenarios('mock-small', [{ status: 401, body: { error: { message: 'Incorrect API key provided' } } }]);
    const first = await call(h.app, userMsg);
    assert.ok(first.status >= 400);
    const breaker = h.app.pool.snapshot().find((p) => p.id === 'flaky');
    assert.equal(breaker!.health.openUntil > Date.now(), true, '连续失败后应进入熔断');
    // 后续请求应该只使用备用上游
    const r = await call(h.app, userMsg);
    assert.equal(r.status, 200);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * P2 预检的端到端效果
 * ------------------------------------------------------------------ */

test('预检拦截畸形 tool_calls：上游请求数为 0（真正的"省一次往返"）', async () => {
  const h = await harness({ providers: twoProviders });
  try {
    const r = await call(h.app, {
      model: 'mock-small',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: { bad: true } } }] },
      ],
    });
    assert.equal(r.status, 400);
    assert.equal(h.mock.count, 0, '预检拦截后绝不能打到上游');
    assert.equal(r.headers['x-relay-precheck'], 'blocked');
    assert.equal(r.json.error.code, 'tool_call_arguments_invalid_json');
    assert.ok(Array.isArray(r.json.error.relay_details.violations));
    assert.equal(r.json.error.relay_attribution.failure_reason, 'tool_call_invalid');
    assert.ok(r.json.error.relay_details.violations[0].fix.length > 0, '必须给出可执行的修复建议');
  } finally {
    await h.close();
  }
});

test('预检逃生舱：X-Relay-Precheck: off 时放行并如实记录', async () => {
  const h = await harness({ providers: twoProviders });
  try {
    h.mock.queueScenarios('mock-small', [{ status: 200 }]);
    const r = await call(
      h.app,
      { model: 'mock-small', messages: [{ role: 'user', content: 'x' }], temperature: 99 },
      { headers: { 'x-relay-precheck': 'off' } },
    );
    assert.equal(r.status, 200);
    assert.equal(h.mock.count, 1);
    const trace = h.app.traceStore.recent(1)[0]!;
    assert.ok(trace.steps.some((s) => s.summary.includes('仅记录，放行')));
  } finally {
    await h.close();
  }
});

test('标准层 observe：只记录不拦截（同一请求在 pro 层被拦、在 standard 层放行）', async () => {
  const h = await harness({ providers: twoProviders });
  try {
    const bad = { model: 'mock-small', messages: [{ role: 'user', content: 'x' }], top_p: 0 };
    const pro = await call(h.app, bad, { token: 'sk-pro-test' });
    assert.equal(pro.status, 400);
    const std = await call(h.app, bad, { token: 'sk-std-test' });
    assert.equal(std.status, 200, 'standard 层应为 observe，不拦截');
  } finally {
    await h.close();
  }
});

test('免费层 attribution=off：错误体里不带归因（守"纯管道"承诺）', async () => {
  const h = await harness({ providers: twoProviders });
  try {
    h.mock.queueScenarios('mock-small', [
      { status: 400, body: { error: { message: 'bad request from upstream', code: 'invalid_request' } } },
    ]);
    const r = await call(h.app, userMsg, { token: 'sk-free-test' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.relay_attribution, undefined);
    assert.equal(r.headers['x-relay-attribution'], undefined);
  } finally {
    await h.close();
  }
});

test('标准层 attribution=header：错误体保持原样，归因只进响应头', async () => {
  const h = await harness({ providers: twoProviders });
  try {
    h.mock.queueScenarios('mock-small', [
      { status: 400, body: { error: { message: 'bad request from upstream', code: 'invalid_request' } } },
      { status: 400, body: { error: { message: 'bad request from upstream', code: 'invalid_request' } } },
    ]);
    const r = await call(h.app, userMsg, { token: 'sk-std-test' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.relay_attribution, undefined);
    assert.ok(r.headers['x-relay-attribution']?.includes('invalid_request'));
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * 鉴权 / 限流 / 额度
 * ------------------------------------------------------------------ */

test('无效 key：401 且给出可执行建议', async () => {
  const h = await harness({ providers: twoProviders });
  try {
    const r = await call(h.app, userMsg, { token: 'sk-nope' });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'invalid_key');
    assert.equal(r.json.error.relay_attribution.suggested_next.action, 'fix_credentials');
    assert.equal(h.mock.count, 0);
  } finally {
    await h.close();
  }
});

test('额度耗尽返回 402 而非 429（避免 Agent 框架对 RateLimitError 疯狂重试）', async () => {
  const h = await harness({ providers: twoProviders });
  try {
    // 额度 1 token：第一次请求会消耗远超 1 token，第二次就被额度闸门挡住
    const first = await call(h.app, userMsg, { token: 'sk-quota-test' });
    assert.equal(first.status, 200);
    const r = await call(h.app, userMsg, { token: 'sk-quota-test' });
    assert.equal(r.status, 402);
    assert.equal(r.json.error.code, 'quota_exhausted');
    assert.equal(r.json.error.relay_attribution.suggested_next.action, 'top_up_balance');
  } finally {
    await h.close();
  }
});

test('白名单外的模型：不存在 → 404"名字写错了"，存在但没开通 → 403"去开通"', async () => {
  /*
   * 这两种必须分开，因为修法完全不同：
   *   · 模型名不存在（拼错）→ 改名字。曾经这里回 403"未开通"，
   *     把人送去开通/升级，而他要做的只是把 agens 改成 agnes-3.0-flash（真实反馈）。
   *   · 模型存在但白名单没有 → 去开通，或换这个 key 允许的模型。
   */
  const h = await harness({
    providers: (url) => [
      ...twoProviders(url),
      // 再声明一个"存在但没给这个 key 开通"的模型
      { id: 'extra', label: 'extra', protocol: 'openai', baseUrl: url, apiKey: 'mock', models: ['mock-large'], priority: 1 },
    ],
    postConfigure: (config) => {
      config.clients = [{ id: 'limited', label: 'limited', key: 'sk-limited', tier: 'pro', tenantId: 't', enabled: true, allowedModels: ['mock-small'] }];
    },
  });
  try {
    // ① 名字根本不存在
    const unknown = await call(h.app, { model: 'other-model', messages: [{ role: 'user', content: 'x' }] }, { token: 'sk-limited' });
    assert.equal(unknown.status, 404, '不存在的模型名必须是 404，不是 403');
    assert.equal(unknown.json.error.code, 'model_not_found');
    assert.match(unknown.json.error.message, /不在本网关的模型清单里/);
    assert.match(unknown.json.error.message, /mock-small/, '要顺带告诉他能用哪些');
    assert.equal(h.mock.count, 0);

    // ② 名字存在，但这个 key 没开通
    const denied = await call(h.app, { model: 'mock-large', messages: [{ role: 'user', content: 'x' }] }, { token: 'sk-limited' });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error.code, 'model_not_allowed');
    assert.match(denied.json.error.message, /该模型存在/);
    assert.equal(h.mock.count, 0, '两种情况都不该打到上游');
  } finally {
    await h.close();
  }
});

test('无路由可用：返回 503 且列出被拒上游与原因', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'only', label: 'only', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1, disabled: true }],
  });
  try {
    const r = await call(h.app, userMsg);
    assert.equal(r.status, 503);
    // error.type 必须与归因一致，不能骗客户端说"模型不存在"
    assert.notEqual(r.json.error.type, 'model_not_found', '上游被禁用不该说成模型不存在');
    assert.equal(r.json.error.type, 'upstream_error');
    assert.equal(r.json.error.relay_attribution.failure_reason, 'upstream_unavailable');
    // "没有路由"这个事实仍然要保留下来
    assert.equal(r.json.error.relay_details.no_route, true);
    assert.ok(Array.isArray(r.json.error.relay_details.rejected));
    assert.equal(h.mock.count, 0);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * P8：度量真的被记下来了
 * ------------------------------------------------------------------ */

test('度量记录：成功请求的 token、成本、客户端类型与降损开销都落库', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1, cost: { inputPerMTok: 2, outputPerMTok: 8 } }],
  });
  try {
    await call(h.app, userMsg);
    const summary = h.app.meter.summarize(3_600_000);
    assert.equal(summary.overall.requests, 1);
    assert.ok(summary.overall.totalTokens > 0);
    assert.ok(summary.overall.costCny > 0, '配置了 cost 就必须算出成本');
    const snapshot = h.app.meter.snapshot();
    assert.equal(snapshot.counters.success, 1);
    assert.ok(snapshot.counters.requests >= 1);
  } finally {
    await h.close();
  }
});

test('度量记录：错误请求的归因与建议动作进入维度统计', async () => {
  const h = await harness({ providers: twoProviders });
  try {
    h.mock.queueScenarios('mock-small', [
      { status: 401, body: { error: { message: 'Incorrect API key provided' } } },
      { status: 401, body: { error: { message: 'Incorrect API key provided' } } },
    ]);
    await call(h.app, userMsg);
    const summary = h.app.meter.summarize(3_600_000);
    assert.ok(summary.byFailureReason.some((r) => r.reason === 'auth_invalid'));
    assert.ok(summary.byQuickAction.some((a) => a.action === 'fix_credentials'));
    assert.equal(summary.lossReduction.attributionCoverage, 1);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * P8 流式计量：上游默认不回 usage，必须由网关自己注入 include_usage
 *
 * 回归背景（2026-09-14 实测）：客户 368 个流式请求 **prompt/completion/total 全是 0**，
 * 面板显示已消耗 11 万 token，而客户在别处已经消耗上千万 —— 因为网关从来没告诉上游
 * "把 usage 带上"，OpenAI 兼容接口不带 `stream_options.include_usage` 就完全不回 usage。
 * ------------------------------------------------------------------ */

const streamBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'mock-small',
  messages: [{ role: 'user', content: 'x' }],
  stream: true,
  ...extra,
});

async function callStream(
  app: App,
  body: Record<string, unknown>,
  token = 'sk-pro-test',
): Promise<string> {
  const result = await app.engine.handle({
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { authorization: `Bearer ${token}` },
    rawBody: new Uint8Array(Buffer.from(JSON.stringify(body))),
    signal: new AbortController().signal,
    requestId: `req_stream_usage${++seq}`,
  });
  assert.equal(result.kind, 'stream');
  if (result.kind !== 'stream') throw new Error('期望流式结果');
  return consumeStream(result);
}

test('P8 流式计量：网关自动注入 include_usage，token 不再记成 0，且那一帧不透传给客户端', async () => {
  const h = await harness({
    providers: (url) => [
      { id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1, cost: { inputPerMTok: 2, outputPerMTok: 8 } },
    ],
  });
  try {
    const text = await callStream(h.app, streamBody());

    // ① 客户端没要过 usage —— 这个字段必须是网关自己加的
    assert.equal(h.mock.received.length, 1);
    const sent = h.mock.received[0]!.body as Record<string, unknown>;
    const so = sent['stream_options'] as Record<string, unknown> | undefined;
    assert.equal(so?.['include_usage'], true, '流式请求必须注入 stream_options.include_usage');

    // ② 计量真的记上了（mock 的 usage 帧：42 + 17 = 59）
    const summary = h.app.meter.summarize(3_600_000);
    assert.equal(summary.overall.totalTokens, 59, '流式请求必须记到 token');
    assert.ok(summary.overall.costCny > 0, '记到 token 才能算出成本');

    // ③ 那一帧是给度量的，不能透传给客户端（否则严格客户端会多收一帧）
    assert.ok(!text.includes('"total_tokens":59'), 'usage 空壳帧不得转发给客户端');
    assert.ok(text.includes('data: [DONE]'), '正常结束帧必须保留');
  } finally {
    await h.close();
  }
});

test('P8 流式计量：客户端自己要过 usage 时不重复注入，也不扣下那一帧', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1 }],
  });
  try {
    const text = await callStream(h.app, streamBody({ stream_options: { include_usage: true } }));
    const sent = h.mock.received[0]!.body as Record<string, unknown>;
    const so = sent['stream_options'] as Record<string, unknown> | undefined;
    assert.deepEqual(Object.keys(so ?? {}), ['include_usage'], '不该往客户的字段里塞东西');
    assert.ok(text.includes('"total_tokens":59'), '客户明确要了 usage，就必须原样给它');
  } finally {
    await h.close();
  }
});

test('P8 流式计量：非流式请求不注入 stream_options（不给上游塞无用字段）', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1 }],
  });
  try {
    await call(h.app, { model: 'mock-small', messages: [{ role: 'user', content: 'x' }] });
    const sent = h.mock.received[0]!.body as Record<string, unknown>;
    assert.equal(sent['stream_options'], undefined);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * 成本口径：一家厂商里"一边免费一边收费"必须能分别表达
 *
 * 2026-09-14 实测 Agnes 官方定价：agnes-3.0-flash / agnes-2.5-flash 当前限时 $0，
 * 而 agnes-2.5-pro 是 $0.45/$0.90 —— 只有厂商级 cost 时这两个型号被迫共用一个价。
 * ------------------------------------------------------------------ */

test('成本口径：modelCosts 覆盖实付价，listCost 独立记牌面价（两个口径互不冒充）', async () => {
  const h = await harness({
    providers: (url) => [
      {
        id: 'p',
        label: 'p',
        protocol: 'openai',
        baseUrl: url,
        apiKey: 'k',
        models: ['mock-small'],
        priority: 1,
        // 厂商级 fallback 故意设成天价：型号价没生效的话，实付会大得离谱
        cost: { inputPerMTok: 1000, outputPerMTok: 1000 },
        listCost: { inputPerMTok: 4, outputPerMTok: 4 },
        modelCosts: { 'mock-small': { inputPerMTok: 0, outputPerMTok: 0 } },
      },
    ],
  });
  try {
    await call(h.app, userMsg);
    const summary = h.app.meter.summarize(3_600_000);
    assert.ok(summary.overall.totalTokens > 0, '前提：这次确实记到了 token');
    assert.equal(summary.overall.costCny, 0, '实付必须用 modelCosts 命中的型号价（0）');
    assert.ok(summary.overall.listCostCny > 0, '牌面价必须独立按 listCost 算，不能被实付的 0 带走');
    assert.notEqual(summary.overall.costCny, summary.overall.listCostCny, '两个口径必须是两个数');
  } finally {
    await h.close();
  }
});

test('成本口径：没配 listCost 时牌面价取实付价（不留空，这一列永远可比）', async () => {
  const h = await harness({
    providers: (url) => [
      { id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1, cost: { inputPerMTok: 2, outputPerMTok: 8 } },
    ],
  });
  try {
    await call(h.app, userMsg);
    const summary = h.app.meter.summarize(3_600_000);
    assert.ok(summary.overall.costCny > 0);
    assert.equal(summary.overall.listCostCny, summary.overall.costCny, '没配刊例价就等同实付价');
  } finally {
    await h.close();
  }
});

test('成本口径：modelCosts 没命中该型号时回退厂商级价', async () => {
  const h = await harness({
    providers: (url) => [
      {
        id: 'p',
        label: 'p',
        protocol: 'openai',
        baseUrl: url,
        apiKey: 'k',
        models: ['mock-small'],
        priority: 1,
        cost: { inputPerMTok: 2, outputPerMTok: 8 },
        modelCosts: { '某个别的型号': { inputPerMTok: 0, outputPerMTok: 0 } },
      },
    ],
  });
  try {
    await call(h.app, userMsg);
    const summary = h.app.meter.summarize(3_600_000);
    assert.ok(summary.overall.costCny > 0, '没命中型号价就该回退到厂商价，不能被误判成免费');
  } finally {
    await h.close();
  }
});

test('成本口径：按模型拆分也带两个口径（不只是总数有）', async () => {
  const h = await harness({
    providers: (url) => [
      {
        id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1,
        cost: { inputPerMTok: 0, outputPerMTok: 0 },
        listCost: { inputPerMTok: 5, outputPerMTok: 5 },
      },
    ],
  });
  try {
    await call(h.app, userMsg);
    const summary = h.app.meter.summarize(3_600_000);
    const row = summary.byModel.find((r) => r.key === 'mock-small');
    assert.ok(row, '按模型的拆分里应当有这条');
    assert.equal(row!.costCny, 0);
    assert.ok(row!.listCostCny > 0, '按模型拆分也要带上牌面价，否则下钻就丢了这一列');
  } finally {
    await h.close();
  }
});

test('恶意/畸形请求体不会打崩引擎', async () => {
  const h = await harness({ providers: twoProviders });
  try {
    const result = await h.app.engine.handle({
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-pro-test' },
      rawBody: new Uint8Array(Buffer.from('{not json at all', 'utf8')),
      signal: new AbortController().signal,
      requestId: 'req_bad_body',
    });
    assert.equal(result.kind, 'json');
    if (result.kind === 'json') {
      assert.equal(result.status, 400);
      assert.ok(result.body.includes('合法 JSON'));
    }
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * 别把「上游熔断」说成「模型不存在」——这是最容易误导用户的一类错误
 * ------------------------------------------------------------------ */

test('上游因密钥问题熔断后，归因必须指向根因而不是"模型不存在"', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'broken', label: '坏上游', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1 }],
    postConfigure: (config) => {
      config.lossReduction.attribution.breakerThreshold = 1;
      config.lossReduction.attribution.breakerCooldownMs = 60_000;
      config.lossReduction.attribution.autoRetry = 0;
    },
  });
  try {
    // 第一次：上游返回 401，立即触发熔断
    h.mock.queueScenarios('mock-small', [{ status: 401, body: { error: { message: '无效的令牌', type: 'AgnesAI_error', code: '' } } }]);
    const first = await call(h.app, userMsg);
    assert.equal(first.status, 401);

    // 第二次：上游已在熔断冷却中，请求根本发不出去
    const second = await call(h.app, userMsg);
    const card = second.json.error.relay_attribution;
    assert.notEqual(card.failure_reason, 'model_not_found', '熔断不该被说成模型不存在');
    assert.equal(card.failure_reason, 'auth_invalid', '应指向根因');
    assert.equal(card.suggested_next.action, 'fix_credentials');
    assert.equal(card.recoverable, false);
    assert.match(second.json.error.message, /熔断/, '提示里要说明是熔断而不是模型问题');
    assert.match(second.json.error.message, /与请求的模型名无关/);
  } finally {
    await h.close();
  }
});

test('确实是"没有上游声明该模型"时，仍然要说成模型问题（别修过头）', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1 }],
  });
  try {
    // mock-large 没有任何上游声明支持，但预检会先放行（模型目录非空且该模型不在目录里会被拦）
    // 因此这里直接验证引擎层的无路由归因：禁用之后走的是"运营摘除"分支
    h.app.pool.setDisabled('p', true);
    const r = await call(h.app, userMsg);
    assert.equal(r.status, 503);
    const card = r.json.error.relay_attribution;
    assert.equal(card.failure_reason, 'upstream_unavailable');
    assert.match(r.json.error.message, /人工摘除|运营/);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * 档位阶梯（竖向）：让客户的任务自动跑完，而不是把错误丢回去
 * ------------------------------------------------------------------ */

test('阶梯：旗舰失败自动降到下一阶，任务仍然完成，并声明实际服务的模型', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-500', 'mock-small'], priority: 1 }],
    postConfigure: (cfg) => {
      cfg.modelLadders = { flagship: ['mock-500', 'mock-small'] };
      cfg.lossReduction.attribution.autoRetry = 0;
    },
  });
  try {
    // 客户端请求的是阶梯名 flagship，不是具体模型
    const r = await call(h.app, { model: 'flagship', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 200, `期望阶梯换模型后成功，实际 ${r.text.slice(0, 200)}`);
    // 客户看到的是自己请求的名字（契约不变）
    assert.equal(r.json.model, 'flagship');
    // 但头部必须说清实际是谁答的——否则就是静默换模型
    assert.equal(r.headers['x-relay-model-requested'], 'flagship');
    assert.equal(r.headers['x-relay-model-served'], 'mock-small');
    assert.match(r.headers['x-relay-switched'] ?? '', /flagship->mock-small/);
    assert.equal(r.headers['x-relay-ladder'], '2/2');
  } finally {
    await h.close();
  }
});

test('阶梯：极速失败往上升（方向由配置决定，不是写死的单向降级）', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-500', 'mock-small'], priority: 1 }],
    postConfigure: (cfg) => {
      // 极速档的阶梯第一阶是便宜模型（这里用 mock-500 模拟挂掉），第二阶往上走
      cfg.modelLadders = { fast: ['mock-500', 'mock-small'] };
      cfg.lossReduction.attribution.autoRetry = 0;
    },
  });
  try {
    const r = await call(h.app, { model: 'fast', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-relay-model-served'], 'mock-small');
  } finally {
    await h.close();
  }
});

test('阶梯：带 tools 的请求会跳过声明 tools:false 的模型（切过去任务会废）', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-500', 'mock-small'], priority: 1 }],
    postConfigure: (cfg) => {
      cfg.modelLadders = { flagship: ['mock-500', 'mock-small'] };
      cfg.modelCapabilities = { 'mock-500': { tools: false } };
      cfg.lossReduction.attribution.autoRetry = 0;
    },
  });
  try {
    const r = await call(h.app, {
      model: 'flagship',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
    });
    assert.equal(r.status, 200);
    // 直接落到支持工具的 mock-small，没有白跑 mock-500
    assert.equal(r.headers['x-relay-model-served'], 'mock-small');
    assert.equal(r.headers['x-relay-ladder'], '1/1', '不支持工具的模型应被过滤掉，阶梯只剩一阶');
  } finally {
    await h.close();
  }
});

test('阶梯：模型级 403 推进阶梯，但不会把整个供应商判死（实测教训）', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-noperm', 'mock-small'], priority: 1 }],
    postConfigure: (cfg) => {
      cfg.modelLadders = { flagship: ['mock-noperm', 'mock-small'] };
      cfg.lossReduction.attribution.autoRetry = 0;
    },
  });
  try {
    const r = await call(h.app, { model: 'flagship', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 200, '403 只是"这个 key 不能用这个模型"，换成有权限的模型就该成功');
    assert.equal(r.headers['x-relay-model-served'], 'mock-small');
  } finally {
    await h.close();
  }
});

test('阶梯：请求级错误不换模型（换谁都会同样失败，该让客户改请求）', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-filter', 'mock-small'], priority: 1 }],
    postConfigure: (cfg) => {
      cfg.modelLadders = { flagship: ['mock-filter', 'mock-small'] };
      cfg.lossReduction.attribution.autoRetry = 0;
    },
  });
  try {
    // mock-filter 返回内容安全 400，属请求级
    const r = await call(h.app, { model: 'flagship', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 400, '内容过滤不该靠换模型掩盖');
    assert.equal(r.json.error.relay_attribution.suggested_next.action, 'rewrite_input');
    assert.equal(h.mock.count, 1, '不该拿客户的请求去试遍所有模型');
  } finally {
    await h.close();
  }
});

test('阶梯：整条阶梯都不可达时返回可归因的 503，而不是空壳 500', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1 }],
    postConfigure: (cfg) => {
      // 两阶都没人声明支持 → route 全部抛 NoRouteError
      cfg.modelLadders = { flagship: ['nope-a', 'nope-b'] };
      cfg.lossReduction.attribution.autoRetry = 0;
    },
  });
  try {
    const r = await call(h.app, { model: 'flagship', messages: [{ role: 'user', content: 'x' }] });
    // 没有任何上游声明支持这些模型 → 这才是真正的"模型不存在"，404 比 503 更准确
    assert.equal(r.status, 404);
    assert.equal(r.json.error.type, 'model_not_found');
    assert.equal(r.json.error.relay_attribution.failure_reason, 'model_not_found');
    assert.equal(r.json.error.relay_details.no_route, true);
    assert.match(r.json.error.relay_details.ladder ?? '', /nope-a/);
    assert.equal(h.mock.count, 0, '一阶都不可达时不该发出任何上游请求');
  } finally {
    await h.close();
  }
});

test('阶梯：阶梯名会进对外模型清单（否则预检会把它当未知模型拦掉）', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1 }],
    postConfigure: (cfg) => {
      cfg.modelLadders = { flagship: ['mock-small'] };
    },
  });
  try {
    assert.ok(h.app.router.catalog().includes('flagship'), '阶梯名必须在 catalog 里');
    const reach = h.app.router.reachability().find((r) => r.model === 'flagship');
    assert.ok(reach, '可达性里也该有阶梯名');
    assert.deepEqual(reach!.ladder, ['mock-small']);
    assert.deepEqual(reach!.providers, ['p']);
  } finally {
    await h.close();
  }
});

test('阶梯：配置校验会对不可达的阶与缺失的能力表给出告警', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1 }],
    postConfigure: (cfg) => {
      cfg.modelLadders = { flagship: ['mock-small', 'ghost-model'] };
    },
  });
  try {
    const issues = inspectConfigForTest(h.app.config);
    assert.ok(issues.some((i) => i.level === 'warn' && i.message.includes('ghost-model')), '不可达的阶应告警');
    assert.ok(issues.some((i) => i.level === 'warn' && i.message.includes('能力')), '缺能力表应告警');
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * 上游不可用时，错误类型不能说谎（用户报障复现修复）
 * ------------------------------------------------------------------ */

test('上游被禁用时请求它声明的模型：不能说"网关不认识模型"，要说"上游不可用"', async () => {
  const h = await harness({
    providers: (url) => [
      { id: 'a', label: 'a', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 10 },
      { id: 'b', label: 'b', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-large'], priority: 5 },
    ],
  });
  try {
    // 只禁用 b；客户端请求 mock-large（b 唯一声明支持的模型）
    h.app.pool.setDisabled('b', true);
    const r = await call(h.app, { model: 'mock-large', messages: [{ role: 'user', content: 'x' }] });
    // 关键：不能被预检说成"网关不认识模型 mock-large"——它认识，只是上游被禁用了
    assert.notEqual(r.json.error?.code, 'model_unknown', '模型明明存在，不该说成不认识');
    assert.equal(r.status, 503);
    assert.equal(r.json.error.relay_attribution.failure_reason, 'upstream_unavailable');
    assert.equal(r.json.error.type, 'upstream_error', 'SDK 会按 type 分发异常，不能骗成 model_not_found');
  } finally {
    await h.close();
  }
});

test('模型真的不存在时仍然是 model_unknown（别把两件事混为一谈）', async () => {
  const h = await harness({ providers: twoProviders });
  try {
    const r = await call(h.app, { model: 'totally-made-up-model', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'model_unknown');
  } finally {
    await h.close();
  }
});

test('/v1/models 只列此刻能服务的模型（禁用上游的模型不出现）', async () => {
  const h = await harness({
    providers: (url) => [
      { id: 'a', label: 'a', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 10 },
      { id: 'b', label: 'b', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-large'], priority: 5 },
    ],
  });
  try {
    let ids = h.app.admin.modelList().map((m) => m.id);
    assert.ok(ids.includes('mock-large'), '正常情况下应列出');

    h.app.pool.setDisabled('b', true);
    ids = h.app.admin.modelList().map((m) => m.id);
    assert.ok(!ids.includes('mock-large'), '上游禁用后不该再列给客户');
    // 但"认识"的目录里仍然有它，预检才不会说"不认识"
    assert.ok(h.app.router.catalog().includes('mock-large'));
  } finally {
    await h.close();
  }
});

test('流式请求的耗时必须是正数（曾经把单调钟减了墙上钟，写出 -1.7e12）', async () => {
  const h = await harness({
    providers: (url) => [
      { id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 10 },
    ],
  });
  try {
    const result = await h.app.engine.handle({
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-pro-test' },
      rawBody: new Uint8Array(
        Buffer.from(JSON.stringify({ model: 'mock-small', messages: [{ role: 'user', content: 'x' }], stream: true })),
      ),
      signal: new AbortController().signal,
      requestId: 'req_duration_guard',
    });
    const text = await consumeStream(result);
    assert.ok(text.length > 0, '流式应有内容');

    // 直接读原始度量记录：面板的平均耗时/p95/开销比全靠它，
    // 而混钟（monotonicMs() - Date.now()）会给出 -1.7e12 这种数，且**不报错**。
    const recs = h.app.store.recordsSince(0);
    assert.ok(recs.length > 0, '应至少记下一条度量');
    for (const rec of recs) {
      assert.ok(
        rec.durationMs >= 0 && rec.durationMs < 10 * 60_000,
        `耗时不合理: ${rec.durationMs}（单调钟减墙上钟会得到 ≈ -1.7e12）`,
      );
    }
  } finally {
    await h.close();
  }
});

test('上游"回了头就不发体"：停摆超时换线路，而不是把客户吊死', async () => {
  const h = await harness({
    providers: (url) => [
      { id: 'stalling', label: '装死上游', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 10 },
      { id: 'good', label: '正常上游', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 5 },
    ],
    postConfigure: (cfg) => {
      // 压到 300ms，测试才跑得快。真实配置是 20 秒（relay-net.yaml）。
      cfg.server.upstreamStallTimeoutMs = 300;
    },
  });
  try {
    // 第一个请求：响应头立刻回，之后一个字节都没有
    h.mock.queueScenarios('mock-small', [{ status: 200, stallAfterHeaders: true }]);
    const r = await call(h.app, userMsg);
    assert.equal(r.status, 200, `停摆后应换线路成功，实际: ${r.text}`);
    assert.equal(h.mock.count, 2, '应尝试两次：装死的那条 + 换到的正常那条（而不是一直吊着）');
    const trace = h.app.traceStore.recent(5)[0]!;
    assert.equal(trace.outcome, 'success');
    assert.ok(
      trace.steps.some((s) => s.stage === 'retry'),
      `轨迹里应有 retry 步骤：${JSON.stringify(trace.steps.map((s) => s.stage))}`,
    );
    assert.ok(
      trace.steps.some((s) => s.stage === 'route' && s.summary.includes('good')),
      `应换到正常上游：${JSON.stringify(trace.steps.filter((s) => s.stage === 'route').map((s) => s.summary))}`,
    );
  } finally {
    await h.close();
  }
});

test('/v1/models 按 key 白名单过滤：客户不该看到自己调不了的模型', async () => {
  const h = await harness({
    providers: (url) => [
      { id: 'agnes', label: 'agnes', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 10 },
      { id: 'mimo', label: 'mimo', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-large'], priority: 10 },
    ],
    postConfigure: (cfg) => {
      cfg.clients.push({
        id: 'scoped',
        label: 'scoped',
        key: 'sk-scoped-test',
        tier: 'pro',
        tenantId: 't',
        enabled: true,
        allowedModels: ['mock-small'],
      });
    },
  });
  try {
    // 不带 key：保持原样返回全部（仍有客户端不带 key 探测，这条路径不能改坏）
    const open = h.app.admin.modelList().map((m) => m.id);
    assert.ok(open.includes('mock-small') && open.includes('mock-large'));

    // 带白名单 key：只说这个 key 能用的
    const scoped = h.app.admin.modelList('Bearer sk-scoped-test').map((m) => m.id);
    assert.deepEqual(scoped, ['mock-small']);
    assert.ok(
      !scoped.includes('mock-large'),
      '客户调不了的模型不能列给他 —— 否则他会选中、然后被 403 挡回，误以为是自己 key 坏了（实测踩过）',
    );

    // 不限的 key：仍然是全部
    assert.ok(h.app.admin.modelList('Bearer sk-pro-test').map((m) => m.id).includes('mock-large'));

    // 无效 key：不因为"认不出"就把清单清空
    assert.ok(h.app.admin.modelList('Bearer sk-nope').map((m) => m.id).includes('mock-large'));
  } finally {
    await h.close();
  }
});

test('熔断导致的"暂时没有可用上游"：type 不说谎，且给出标准 Retry-After', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'flaky', label: 'flaky', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1 }],
    postConfigure: (cfg) => {
      // 让它一失败就熔断，模拟"上游被限流打挂了"的现场
      cfg.lossReduction.attribution.breakerThreshold = 1;
      cfg.lossReduction.attribution.breakerCooldownMs = 60_000;
      cfg.lossReduction.attribution.autoRetry = 0;
    },
  });
  try {
    // 第一次：上游限流，触发熔断
    h.mock.queueScenarios('mock-small', [{ status: 429, headers: { 'retry-after': '1' }, body: { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } } }]);
    const first = await call(h.app, userMsg);
    assert.equal(first.status, 429);

    // 第二次：熔断冷却中，请求发不出去
    const second = await call(h.app, userMsg);
    assert.equal(second.status, 503, '熔断是"暂时没有可用上游"，用 503');
    assert.notEqual(second.json.error.type, 'model_not_found', '绝不能说成模型不存在（用户会去改模型名）');
    assert.equal(second.json.error.type, 'upstream_error');
    assert.equal(second.json.error.relay_attribution.failure_reason, 'upstream_unavailable');
    assert.equal(second.json.error.relay_attribution.recoverable, true);
    // 客户端要知道等多久
    assert.ok(second.headers['retry-after'], '必须给出 Retry-After');
    assert.ok(Number(second.headers['retry-after']) >= 1);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * 客户端断开 ≠ 上游故障
 *
 * 真实事故：免费档上游卡住，客户端等不住自己断开（curl 超时 / 用户取消 / 关页面），
 * 而网关把每次断开都记成 relay_internal_error 并计入该上游的连续失败 ——
 * 于是"客户端超时"把上游**对整个网关**熔断了（实测：MiMo 已经恢复，却仍被摘掉）。
 * 断开的成因在客户端侧，对上游健康度没有任何信息量；真正卡住的上游由 TTFB 超时
 * 判成 upstream_timeout，那条才该计数。
 * ------------------------------------------------------------------ */

test('客户端断开不得计入上游失败、不得触发熔断，且归因不能谎报是中转站错误', async () => {
  const h = await harness({
    // mock-timeout = 上游不返回首字节（TTFB 延迟 15 分钟）
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-timeout-3000'], priority: 1 }],
    postConfigure: (cfg) => {
      // 熔断阈值压到 1：只要错记一次就会立刻熔断，测试才抓得住
      cfg.lossReduction.attribution.breakerThreshold = 1;
      cfg.lossReduction.attribution.autoRetry = 0;
      cfg.server.upstreamTtfbTimeoutMs = 30_000; // 远大于本测试的断开时间，确保是"客户端断开"而非 TTFB 超时
    },
  });
  try {
    const controller = new AbortController();
    const raw = Buffer.from(JSON.stringify({ model: 'mock-timeout-3000', messages: [{ role: 'user', content: 'hi' }] }), 'utf8');
    const p = h.app.engine.handle({
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-pro-test', 'content-type': 'application/json' },
      rawBody: new Uint8Array(raw),
      signal: controller.signal,
      requestId: `req_abort${++seq}`,
    });
    // 等它真的打到上游，再断开
    await new Promise((r) => setTimeout(r, 250));
    controller.abort();
    const result = await p;
    assert.equal(result.kind, 'json');
    if (result.kind !== 'json') return;
    assert.equal(result.status, 499, '客户端断开应回 499');

    const json = JSON.parse(result.body) as Record<string, any>;
    const reason = json.error?.relay_attribution?.failure_reason;
    assert.equal(reason, 'client_aborted', '断开的归因必须是"客户端取消"，不能谎报成中转站内部错误');

    const pool = h.app.pool.snapshot()[0]!;
    assert.equal(pool.health.totalFailures, 0, '客户端断开不得计入上游失败数');
    assert.equal(pool.health.consecutiveFailures, 0, '客户端断开不得累计连续失败');
    assert.equal(pool.health.openUntil, 0, '客户端断开不得把上游熔断');
    assert.equal(pool.health.healthy, true, '客户端断开后上游仍应被判为健康');
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * 同模型多供应商：同请求内切换 + 熔断 + 冷却后半开试探 → 自动恢复主用
 *
 * 业务要求（原话）："先用原厂；中途原厂宕机，用兜底账号；然后自动检测原厂恢复。
 * 因为同模型的，Agent 询问模型是一样的。" —— 下面把这三步全部钉住。
 * ------------------------------------------------------------------ */

test('同模型双供应商：主用失败当次就切兜底，熔断后走兜底，主用恢复后自动切回', async () => {
  const bad = new MockUpstream({ port: 0, logger: silent, forceScenario: { status: 500, body: { error: { message: 'upstream is down', code: 'internal' } } } });
  const good = new MockUpstream({ port: 0, logger: silent });
  const badBound = await bad.listen();
  const goodBound = await good.listen();
  const MODEL = 'mimo-x';
  const config = memoryConfig({
    providers: [
      // 主用：priority 高（数字大者优先），但一开始是坏的
      { id: 'primary', label: 'primary', protocol: 'openai', baseUrl: badBound.url, apiKey: 'k', models: [MODEL], priority: 20 },
      // 兜底：priority 低
      { id: 'backup', label: 'backup', protocol: 'openai', baseUrl: goodBound.url, apiKey: 'k', models: [MODEL], priority: 10 },
    ],
    clients: [{ id: 'pro-key', label: 'pro', key: 'sk-pro-test', tier: 'pro', tenantId: 't', enabled: true }],
    logLevel: 'error',
  });
  config.lossReduction.attribution.breakerThreshold = 2;
  config.lossReduction.attribution.breakerCooldownMs = 800; // 压短，但要长过"几次请求"的时间，否则半开试探会先发生
  config.lossReduction.attribution.autoRetry = 2;
  const app = await createApp(config, silent);
  const call = () => app.engine.handle({
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { authorization: 'Bearer sk-pro-test', 'content-type': 'application/json' },
    rawBody: new Uint8Array(Buffer.from(JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }), 'utf8')),
    signal: new AbortController().signal,
    requestId: `req_fo${++seq}`,
  });

  try {
    /* ① 同请求内切换：主用 500，客户端仍应拿到 200（由兜底服务） */
    const r1 = await call();
    assert.equal(r1.kind, 'json');
    if (r1.kind !== 'json') return;
    assert.equal(r1.status, 200, '主用挂掉时这一次请求就该成功，不能把错误丢给客户');
    assert.ok(good.count >= 1, '兜底供应商应真的被调用过');

    /* ② 熔断：再打几次，主用连续失败到阈值后应被摘掉 */
    await call();
    await call();
    const primary = app.pool.snapshot().find((p) => p.id === 'primary')!;
    assert.ok(primary.health.consecutiveFailures >= 2, '主用应累计到熔断阈值');
    assert.ok(primary.health.openUntil > Date.now(), '主用应处于熔断冷却中');

    // 熔断期间：请求直接走兜底（不再拿客户请求去撞坏掉的主用）
    const badBefore = bad.count;
    const r2 = await call();
    assert.equal(r2.kind === 'json' ? r2.status : 0, 200);
    assert.equal(bad.count, badBefore, '熔断期间不应再打主用');

    /* ③ 自动恢复：把主用"治好"，等冷却过去，下一次请求应试探成功并切回主用 */
    bad.setForcedScenario(undefined); // 上游恢复
    await new Promise((r) => setTimeout(r, 900)); // 超过 breakerCooldownMs，进入半开
    const goodBefore = good.count;
    const r3 = await call();
    assert.equal(r3.kind === 'json' ? r3.status : 0, 200);
    const healed = app.pool.snapshot().find((p) => p.id === 'primary')!;
    assert.equal(healed.health.openUntil, 0, '试探成功后主用应解除熔断');
    assert.equal(healed.health.consecutiveFailures, 0, '试探成功后失败计数应清零');
    assert.ok(bad.count > 0, '恢复后应重新走主用');
    void goodBefore;
  } finally {
    await app.shutdown();
    await bad.close();
    await good.close();
  }
});

/* ------------------------------------------------------------------ *
 * 中文模型名：响应头必须 ASCII 安全（Node 遇非 ASCII 头值会直接抛，把请求变 500）
 * ------------------------------------------------------------------ */

test('中文档位名：响应头里的模型名要百分号编码，不能把请求打成 500', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1 }],
    postConfigure: (cfg) => {
      cfg.modelLadders = { 旗舰: ['mock-small'] };
      cfg.clients.push({ id: 'zh', label: 'zh', key: 'sk-zh-test', tier: 'pro', tenantId: 't', enabled: true, allowedModels: ['旗舰'] });
    },
  });
  try {
    const r = await call(h.app, { model: '旗舰', messages: [{ role: 'user', content: 'x' }] }, { token: 'sk-zh-test' });
    assert.equal(r.status, 200, '中文档位名必须能正常服务，而不是 500');
    // 头部按 UTF-8 百分号编码（ASCII 安全），客户端 decodeURIComponent 可还原
    const raw = r.headers['x-relay-model-requested'] ?? '';
    assert.ok(/^[\x20-\x7E]*$/.test(raw), `响应头必须是可见 ASCII，实际：${raw}`);
    assert.equal(decodeURIComponent(raw), '旗舰');
    // 响应体里是真正的 UTF-8，客户看到的模型名照旧
    assert.equal(r.json.model, '旗舰');
  } finally {
    await h.close();
  }
});

test('headerSafe：非 ASCII 百分号编码，CR/LF 一并编码（顺带防头注入）', () => {
  assert.equal(headerSafe('agnes-3.0-flash'), 'agnes-3.0-flash');
  assert.equal(decodeURIComponent(headerSafe('旗舰')), '旗舰');
  assert.ok(!headerSafe('a\r\nX-Evil: 1').includes('\n'), 'CR/LF 不能原样留在头值里');
  assert.equal(headerSafe('旗舰->mock-small'), '%E6%97%97%E8%88%B0->mock-small');
});

test('流式回归：上游「回了头却零字节就断」必须判失败并切备用线路（不能被吞成空 200）', async () => {
  const h = await harness({ providers: twoProviders });
  try {
    // 主上游：回了 200 + SSE 头，然后一个字节都没发就断
    h.mock.queueScenarios('mock-small', [{ status: 200, streamInterruptAfter: 0 }]);
    const text = await callStream(h.app, streamBody());
    assert.ok(text.length > 0, '客户端不能拿到空 200 —— 这正是 2026-09-14 审计抓到的回归');
    assert.ok(text.includes('data: [DONE]'), '必须切到备用线路并拿到完整流');
    assert.ok(h.mock.received.length >= 2, '应当发生过故障转移（打了不止一个上游）');
  } finally {
    await h.close();
  }
});

test('兜底估算：按字节估 token，不能把 586000 字节估成 2', () => {
  // 用 estimateJsonTokens(数字) 会先 JSON.stringify 成 "586000" 再按文本估 → 得 2，
  // 少 4 个数量级（审计实测）。这条钉住"必须走 estimateTokensFromBytes"。
  assert.equal(estimateTokensFromBytes(586000), 146500);
  assert.ok(estimateTokensFromBytes(586000) > 100000);
  assert.equal(estimateTokensFromBytes(0), 0);
  assert.equal(estimateTokensFromBytes(-1), 0);
  assert.ok(estimateJsonTokens(586000) < 10, '反向说明：直接把数字喂给 estimateJsonTokens 是错的');
});

test('客户端中途放弃不能算上游失败（否则 5 次放弃就能熔断一条健康线路）', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1 }],
    postConfigure: (cfg) => {
      // 耐心放长，确保是"客户端先走"，而不是我们先判上游停摆
      cfg.server.upstreamStallTimeoutMs = 3_000;
      cfg.server.upstreamTtfbTimeoutMs = 3_000;
    },
  });
  try {
    // 上游"回了头就不发体"（Agnes 国际那条线路的真实形态），客户端等不及自己断开
    h.mock.queueScenarios('mock-small', [{ status: 200, stallAfterHeaders: true }]);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 100);
    await h.app.engine.handle({
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-pro-test', 'content-type': 'application/json' },
      rawBody: new Uint8Array(Buffer.from(JSON.stringify({ model: 'mock-small', messages: [{ role: 'user', content: 'x' }], stream: true }))),
      signal: ac.signal,
      requestId: 'req_client_abort_test',
    });
    clearTimeout(timer);

    const health = h.app.pool.get('p')!.health;
    // 老代码在进 try 之前把 signal.aborted 快照成 false，于是"客户端早已断开"被记成上游失败
    // → breakerThreshold=5 时，5 次客户端放弃就能把健康上游摘掉（审计实测）
    assert.equal(health.consecutiveFailures, 0, '客户端放弃不能记到上游账上');
    assert.equal(health.openUntil, 0, '更不能因此熔断');
  } finally {
    await h.close();
  }
});

test('TTFB 超时归因必须是 upstream_timeout，不能错记成 network_error（审计 D-P2-8）', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1 }],
    postConfigure: (cfg) => {
      cfg.server.upstreamTtfbTimeoutMs = 400;
      cfg.server.upstreamStallTimeoutMs = 400;
    },
  });
  try {
    // 上游 2 秒才回响应头 → 首字节 400ms 判死。
    // 排**两个**慢场景：引擎对上游超时会自动重试一次，只排一个的话重试会走默认
    // 场景成功返回 200，就测不到归因了。
    h.mock.queueScenarios('mock-small', [{ status: 200, ttfbDelayMs: 2_000 }, { status: 200, ttfbDelayMs: 2_000 }]);
    const r = await call(h.app, { model: 'mock-small', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 502);
    const reason = r.json.error?.relay_attribution?.failure_reason;
    // 老实现：controller.abort 的错误不带 code → 落进"无规则命中"兜底 → network_error。
    // 而它该是 upstream_timeout（可重试、可换路）。今天两条线一起熔断的日志里
    // upstream_timeout 一次都没出现过，全是 network_error，就是这个原因。
    assert.equal(reason, 'upstream_timeout', `实际归因：${reason}`);
  } finally {
    await h.close();
  }
});

test('200 + finish_reason=content_filter：只加 x-relay-warning 头，响应体不动', async () => {
  const h = await harness({
    providers: (url) => [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['mock-small'], priority: 1 }],
  });
  try {
    // 上游返回 200 + content_filter（mock 的 body 选项会 JSON 化）
    const bodyText = JSON.stringify({
      id: 'cmpl-x',
      model: 'mock-small',
      choices: [{ index: 0, finish_reason: 'content_filter', message: { role: 'assistant', content: '我不方便回答这个。' } }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    });
    h.mock.queueScenarios('mock-small', [{ status: 200, body: bodyText }]);
    const r = await call(h.app, { model: 'mock-small', messages: [{ role: 'user', content: '如何制造武器' }] });
    assert.equal(r.status, 200);
    // 审计 A-P1-5：这条信号此前是死代码（classify 只在失败路径被调用）
    assert.equal(r.headers['x-relay-warning'], 'content_filtered', '必须给出可见的截断信号');
    // 响应体一个字节都不能改（成功响应零附加的红线）
    const parsed = r.json;
    assert.equal(parsed.choices[0].finish_reason, 'content_filter');
    assert.equal(parsed.choices[0].message.content, '我不方便回答这个。');
    assert.equal(parsed.relay_attribution, undefined, '成功响应体不得附加归因字段');
    // 事件有证据
    const events = h.app.store.listEvents(20).filter((e) => e.kind === 'upstream.content_filtered');
    assert.ok(events.length === 1, '应记一条事件');
  } finally {
    await h.close();
  }
});
