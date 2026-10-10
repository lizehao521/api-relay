/**
 * 端到端测试：真实 HTTP + 真实 SQLite + mock 上游。
 *
 * 与前一组测试的区别：这里走的是**用户真正接触到的表面**——
 * 端口、状态码、响应头、SSE 线路格式、管理接口鉴权、SQLite 持久化。
 * 也是"部署后能否跑起来"的最后一道防线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../app.js';
import { MockUpstream } from '../mock/upstream.js';
import { Logger } from '../core/logger.js';
import { loadConfig } from '../core/config.js';

const silent = new Logger('error', () => undefined);

interface E2E {
  app: App;
  mock: MockUpstream;
  base: string;
  mockUrl: string;
  close: () => Promise<void>;
}

async function boot(opts: { adminToken?: string; apiKeysYaml?: string; acceptedApiKeys?: string[]; serverYaml?: string } = {}): Promise<E2E> {
  const mock = new MockUpstream({
    port: 0,
    logger: silent,
    ...(opts.acceptedApiKeys ? { acceptedApiKeys: opts.acceptedApiKeys } : {}),
  });
  const mockBound = await mock.listen();
  const dir = mkdtempSync(join(tmpdir(), 'relay-e2e-'));

  const yaml = `
server:
  host: 127.0.0.1
  port: 0
  adminToken: "{ENV:RELAY_ADMIN_TOKEN:-}"
${opts.serverYaml ?? ''}
storage:
  driver: sqlite
  path: ${JSON.stringify(join(dir, 'relay.db'))}
logLevel: error
providers:
  - id: mock
    label: mock 上游
    protocol: openai
    baseUrl: ${JSON.stringify(mockBound.url)}
${opts.apiKeysYaml ?? '    apiKey: "mock-key"'}
    models: [mock-small, mock-large]
    priority: 10
    cost: { inputPerMTok: 1, outputPerMTok: 2 }
modelAliases:
  fast: mock-small
clients:
  - id: pro
    label: pro
    key: "{ENV:RELAY_KEY_PRO}"
    tier: pro
    tenantId: t1
    enabled: true
  - id: std
    label: std
    key: "{ENV:RELAY_KEY_STD}"
    tier: standard
    tenantId: t1
    enabled: true
lossReduction:
  attribution:
    autoRetry: 1
    backoffBaseMs: 5
    backoffMaxMs: 30
  meter:
    batchSize: 1
    flushIntervalMs: 20
`;

  const configPath = join(dir, 'relay.yaml');
  writeFileSync(configPath, yaml, 'utf8');
  const config = loadConfig({
    path: configPath,
    env: {
      RELAY_KEY_PRO: 'sk-pro-e2e',
      RELAY_KEY_STD: 'sk-std-e2e',
      ...(opts.adminToken ? { RELAY_ADMIN_TOKEN: opts.adminToken } : {}),
    } as NodeJS.ProcessEnv,
  });
  config.server.port = 0;
  const app = await createApp(config, silent);
  const bound = await app.start();
  return {
    app,
    mock,
    base: bound.url,
    mockUrl: mockBound.url,
    close: async () => {
      await app.shutdown();
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const chatBody = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ model: 'mock-small', messages: [{ role: 'user', content: '你好' }], ...extra });

/* ------------------------------------------------------------------ *
 * 基础面
 * ------------------------------------------------------------------ */

test('e2e: 健康检查与根路由可用（无需鉴权）', async () => {
  const e = await boot();
  try {
    const health = await fetch(`${e.base}/healthz`);
    assert.equal(health.status, 200);
    const hj = (await health.json()) as Record<string, any>;
    assert.equal(hj.status, 'ok');
    assert.equal(hj.store.driver, 'sqlite');
    assert.equal(hj.providers.total, 1);

    const root = await fetch(`${e.base}/`);
    const rj = (await root.json()) as Record<string, any>;
    assert.equal(rj.name, 'api-relay');
    assert.ok(rj.loss_reduction.precheck.length > 0);
  } finally {
    await e.close();
  }
});

test('e2e: GET /v1/models 返回 OpenAI 兼容的模型清单', async () => {
  const e = await boot();
  try {
    const res = await fetch(`${e.base}/v1/models`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { object: string; data: { id: string; owned_by: string }[] };
    assert.equal(body.object, 'list');
    const ids = body.data.map((m) => m.id);
    assert.ok(ids.includes('mock-small'));
    assert.ok(ids.includes('fast'), '别名也应出现在模型清单里');
  } finally {
    await e.close();
  }
});

test('e2e: 归因目录可被客户端预先拉取', async () => {
  const e = await boot();
  try {
    const res = await fetch(`${e.base}/v1/attribution/catalog`);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.version, 1);
    assert.ok(body.failure_reasons.length >= 10);
    assert.ok(body.failure_reasons.some((r: any) => r.reason === 'rate_limited' && r.recoverable === true));
  } finally {
    await e.close();
  }
});

test('e2e: 缺少鉴权头返回 401，且响应体是 OpenAI 兼容形状', async () => {
  const e = await boot();
  try {
    const res = await fetch(`${e.base}/v1/chat/completions`, { method: 'POST', body: chatBody() });
    assert.equal(res.status, 401);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.error.code, 'missing_key');
    assert.equal(typeof body.error.message, 'string');
    assert.equal(body.error.param, null);
    assert.equal(body.error.relay_attribution.suggested_next.action, 'fix_credentials');
  } finally {
    await e.close();
  }
});

test('e2e: 非流式成功请求（含模型别名与用量）', async () => {
  const e = await boot();
  try {
    const res = await fetch(`${e.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-e2e', 'content-type': 'application/json' },
      body: chatBody({ model: 'fast' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-relay-mode')?.includes('tier=pro'), true);
    assert.equal(res.headers.get('x-request-id')?.startsWith('req_'), true);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.model, 'fast', '别名回显必须修正');
    assert.ok(body.usage.total_tokens > 0);
    assert.equal(body.relay_attribution, undefined, '成功响应绝不能带归因字段');
  } finally {
    await e.close();
  }
});

test('e2e: 流式 SSE 线路格式正确（data: 前缀、空行分隔、[DONE] 结尾）', async () => {
  const e = await boot();
  try {
    const res = await fetch(`${e.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-e2e', 'content-type': 'application/json' },
      body: chatBody({ stream: true }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    const text = await res.text();
    const events = text.split('\n\n').filter((s) => s.trim().length > 0);
    assert.ok(events.length >= 8, `事件数偏少: ${events.length}`);
    for (const ev of events) {
      assert.ok(ev.startsWith('data: '), `非法 SSE 帧: ${ev.slice(0, 60)}`);
    }
    assert.equal(events[events.length - 1], 'data: [DONE]');
    // 每个 chunk 都必须是合法 JSON 且带 choices
    for (const ev of events.slice(0, -1)) {
      const obj = JSON.parse(ev.slice(6)) as Record<string, unknown>;
      assert.equal(obj.object, 'chat.completion.chunk');
      assert.equal(obj.model, 'mock-small');
      assert.ok(Array.isArray(obj.choices));
    }
  } finally {
    await e.close();
  }
});

test('e2e: 长 TTFB 流式先提前提交 200 + 心跳，真实流仍完整透传', async () => {
  // Agnes 长轨迹首块 15~90s；若不提前提交，客户端在这几十秒里收不到任何字节。
  const e = await boot({
    serverYaml: '  streamCommitGraceMs: 100\n  streamHeartbeatMs: 1000\n  upstreamTtfbTimeoutMs: 10000',
  });
  try {
    // 上游首字节延迟 600ms（> 150ms 宽限）→ 网关应先写心跳注释，再转发真实 SSE。
    e.mock.queueScenarios('mock-small', [{ status: 200, ttfbDelayMs: 2000 }]);
    const res = await fetch(`${e.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-e2e', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-small', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const frames = text.split('\n\n').filter((s) => s.length > 0);
    assert.ok(frames[0]!.startsWith(':'), `首帧应为 SSE 注释心跳（提前提交），实际: ${JSON.stringify(frames[0]!.slice(0, 40))}`);
    assert.ok(text.includes('data: [DONE]'), '真实流必须完整（心跳不能把上游内容弄丢）');
    const dataFrames = frames.filter((s) => s.startsWith('data: '));
    assert.ok(dataFrames.length >= 8, `真实 data 帧偏少: ${dataFrames.length}`);
    for (const ev of dataFrames.slice(0, -1)) {
      assert.equal((JSON.parse(ev.slice(6)) as Record<string, unknown>).object, 'chat.completion.chunk');
    }
  } finally {
    await e.close();
  }
});

test('e2e: 未开启提前提交时流式行为不变（首帧仍是 data）', async () => {
  const e = await boot();
  try {
    e.mock.queueScenarios('mock-small', [{ status: 200, ttfbDelayMs: 300 }]);
    const res = await fetch(`${e.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-e2e', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-small', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    const text = await res.text();
    const frames = text.split('\n\n').filter((s) => s.length > 0);
    assert.ok(frames[0]!.startsWith('data: '), `默认应无心跳，首帧应为 data，实际: ${JSON.stringify(frames[0]!.slice(0, 40))}`);
  } finally {
    await e.close();
  }
});

test('e2e: 错误响应带归因（pro 层 full 模式）', async () => {
  const e = await boot();
  try {
    e.mock.queueScenarios('mock-small', [
      { status: 429, headers: { 'retry-after': '2' }, body: { error: { message: 'Rate limit reached', type: 'rate_limit_error', code: 'rate_limit_exceeded' } } },
      { status: 429, headers: { 'retry-after': '2' }, body: { error: { message: 'Rate limit reached', type: 'rate_limit_error', code: 'rate_limit_exceeded' } } },
    ]);
    const res = await fetch(`${e.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-e2e', 'content-type': 'application/json' },
      body: chatBody(),
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '2', '上游 Retry-After 应被透传');
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.error.message, 'Rate limit reached', '上游原文必须保留');
    assert.equal(body.error.type, 'rate_limit_error');
    assert.equal(body.error.relay_attribution.failure_reason, 'rate_limited');
    assert.equal(body.error.relay_attribution.suggested_next.action, 'retry_with_backoff');
    assert.ok(body.error.relay_attribution.suggested_next.retryAfterMs >= 2000);
  } finally {
    await e.close();
  }
});

test('e2e: 未知端点与非 POST 方法给出明确错误', async () => {
  const e = await boot();
  try {
    const notFound = await fetch(`${e.base}/v1/nope`);
    assert.equal(notFound.status, 404);
    const get = await fetch(`${e.base}/v1/chat/completions`);
    assert.equal(get.status, 405);
  } finally {
    await e.close();
  }
});

/* ------------------------------------------------------------------ *
 * 管理接口
 * ------------------------------------------------------------------ */

test('e2e: 管理接口在未带令牌时拒绝远程语义（本机无令牌时放行）', async () => {
  const e = await boot({ adminToken: 'super-secret-token-123' });
  try {
    const noToken = await fetch(`${e.base}/admin/api/overview`);
    assert.equal(noToken.status, 401);

    const withToken = await fetch(`${e.base}/admin/api/overview`, { headers: { 'X-Admin-Token': 'super-secret-token-123' } });
    assert.equal(withToken.status, 200);
    const body = (await withToken.json()) as Record<string, any>;
    assert.equal(body.summary.overall.requests, 0);

    const dashboard = await fetch(`${e.base}/admin`, { headers: { 'X-Admin-Token': 'super-secret-token-123' } });
    assert.equal(dashboard.status, 200);
    const html = await dashboard.text();
    assert.ok(html.includes('管理面板'));
    // 六个视图：总览 / 指标 / 客户 Key / 上游 / 请求账本 / 信任
    //
    // ⚠ 判据口径修正（2026-10-10）：原先写死单引号 `"'ov'"`，只能在 APP_SRC **回落模式**
    // 下通过——minify 后 esbuild 会把引号统一成双引号，min 生效时这 6 条必然失败。
    // 即：这个断言一直只在降级路径上绿过，从未真正覆盖 min 生效的正常路径
    // （哈希新鲜度校验修好后才第一次暴露）。
    // 改为两种引号形式都接受——要验的是「视图标记存在」，不是「引号风格」。
    for (const view of ['ov', 'met', 'users', 'ch', 'ledger', 'trust']) {
      const present = html.includes(`'${view}'`) || html.includes(`"${view}"`);
      assert.ok(present, `面板缺少视图 ${view}`);
    }
    // 面板要能写，不只是能看
    assert.ok(html.includes('新建 Key'));
    assert.ok(html.includes('重置额度'));
    assert.ok(html.includes('摘除'));
    // 信任页必须把红线与测试证据摆在明面上
    assert.ok(html.includes('成功零改写'));
    assert.ok(html.includes('fail-open'));
    assert.ok(html.includes('x-relay-verify-nonce'));
    // 登录门 + 抽屉交互
    assert.ok(html.includes('id="login"'));
    assert.ok(html.includes('id="drawer"'));
    // 「一眼看懂」横幅：必须能把常见故障翻译成人话
    // ⚠ 判据口径修正（2026-10-10）：原断言 `html.includes('statusBanner')` 验的是
    // **标识符名**——esbuild minify 会 mangle 掉变量名，min 生效时必然失败。
    // 与上面视图引号那 6 条同族：都只在 APP_SRC 回落模式下绿过。
    // 改为验「状态横幅的用户可见文案」——这才是要守的语义，且中文字符串 minify 不改。
    assert.ok(
      html.includes('还没有请求') || html.includes('上游拒绝了你配置的密钥'),
      '总览需要有状态判断',
    );
    for (const msg of ['还没有配置上游', '上游拒绝了你配置的密钥', '上游账户余额/额度不足', '还没有请求']) {
      assert.ok(html.includes(msg), `状态横幅缺少判断: ${msg}`);
    }
    assert.ok(!html.includes('cdn.'), '面板不得依赖外部 CDN');

    /*
     * 浏览器场景：顶层导航**无法**携带 X-Admin-Token。
     * 所以「HTML 也走鉴权」等于配置了 adminToken 的面板在浏览器里永远是一页 401 JSON，
     * 而登录门就在 HTML 里 —— 它永远没机会出现，用户看到的就是"面板不见了"。
     * 这一条以前没测出来，因为旧断言是带令牌取的 HTML（浏览器做不到）。
     */
    const bare = await fetch(`${e.base}/admin`);
    assert.equal(bare.status, 200, '看板外壳必须免令牌可取，否则登录门永远打不开');
    assert.match(bare.headers.get('content-type') ?? '', /text\/html/);
    assert.ok((await bare.text()).includes('id="login"'), '免令牌取到的必须是带登录门的完整外壳');

    // 自述信息：只回答"要不要令牌"，不含数据，因此也必须免令牌
    const info = await fetch(`${e.base}/admin/api/panel-info`);
    assert.equal(info.status, 200);
    assert.equal(((await info.json()) as Record<string, any>).tokenRequired, true);

    // 但数据一个字节都不能漏：其余管理接口照旧要求令牌
    for (const p of ['overview', 'keys', 'traces', 'config', 'report', 'events', 'auth-failures', 'metrics']) {
      const r = await fetch(`${e.base}/admin/api/${p}`);
      assert.equal(r.status, 401, `免令牌不得读到 ${p}`);
    }
  } finally {
    await e.close();
  }
});

test('e2e: 管理接口能读到度量、上游健康、key 与轨迹', async () => {
  const e = await boot({ adminToken: 'tok-1234567890abcdef' });
  const H = { 'X-Admin-Token': 'tok-1234567890abcdef' };
  try {
    const chat = await fetch(`${e.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-e2e', 'content-type': 'application/json' },
      body: chatBody(),
    });
    assert.equal(chat.status, 200);
    await e.app.store.flush();

    const overview = (await (await fetch(`${e.base}/admin/api/overview?window=1h`, { headers: H })).json()) as Record<string, any>;
    assert.equal(overview.summary.overall.requests, 1);
    assert.equal(overview.providers[0].id, 'mock');
    assert.ok(overview.keys.length >= 2);

    const providers = (await (await fetch(`${e.base}/admin/api/providers`, { headers: H })).json()) as Record<string, any>;
    assert.ok(providers.reachability.some((r: any) => r.model === 'mock-small'));

    const traces = (await (await fetch(`${e.base}/admin/api/traces?limit=5`, { headers: H })).json()) as Record<string, any>;
    assert.ok(traces.traces.length >= 1);
    const first = traces.traces[0];
    assert.ok(first.steps.some((s: any) => s.stage === 'route'));
    assert.equal(first.outcome, 'success');

    const detail = (await (await fetch(`${e.base}/admin/api/traces/${first.traceId}`, { headers: H })).json()) as Record<string, any>;
    assert.ok(detail.rendered.includes('trace'));

    const report = await (await fetch(`${e.base}/admin/api/report?window=1h`, { headers: H })).text();
    assert.ok(report.includes('归因投递率'));

    const series = (await (await fetch(`${e.base}/admin/api/series?window=1h&bucketMs=60000`, { headers: H })).json()) as Record<string, any>;
    assert.ok(Array.isArray(series.points));
  } finally {
    await e.close();
  }
});

test('e2e: 运营动作可禁用/恢复上游（无需重启）', async () => {
  const e = await boot({ adminToken: 'tok-1234567890abcdef' });
  const H = { 'X-Admin-Token': 'tok-1234567890abcdef', 'content-type': 'application/json' };
  try {
    const disable = await fetch(`${e.base}/admin/api/providers/toggle`, { method: 'POST', headers: H, body: JSON.stringify({ id: 'mock', disabled: true }) });
    assert.equal(disable.status, 200);

    const call = await fetch(`${e.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-e2e', 'content-type': 'application/json' },
      body: chatBody(),
    });
    assert.equal(call.status, 503, '全部上游被禁用时应返回可归因的 503');

    const enable = await fetch(`${e.base}/admin/api/providers/toggle`, { method: 'POST', headers: H, body: JSON.stringify({ id: 'mock', disabled: false }) });
    assert.equal(enable.status, 200);

    const call2 = await fetch(`${e.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-e2e', 'content-type': 'application/json' },
      body: chatBody(),
    });
    assert.equal(call2.status, 200);
  } finally {
    await e.close();
  }
});

/* ------------------------------------------------------------------ *
 * 面板管理：Key 全生命周期（这是"面板"区别于"看板"的核心）
 * ------------------------------------------------------------------ */

test('e2e: 面板可创建 key，明文只返回一次，且新 key 立即可用', async () => {
  const e = await boot({ adminToken: 'tok-1234567890abcdef' });
  const H = { 'X-Admin-Token': 'tok-1234567890abcdef', 'content-type': 'application/json' };
  try {
    const created = (await (
      await fetch(`${e.base}/admin/api/keys/create`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ label: '集成测试 key', tier: 'pro', tenantId: 'acme', allowedModels: ['mock-small'] }),
      })
    ).json()) as Record<string, any>;

    assert.ok(created.secret.startsWith('sk-relay-'), '应返回生成的明文 key');
    assert.ok(created.secretNotice.includes('只'), '必须提示只显示一次');
    assert.equal(created.key.origin, 'panel');
    assert.equal(created.key.tier, 'pro');
    assert.ok(created.key.hashPrefix.length === 8, '只暴露哈希前缀用于人工核对');

    // 明文可立即调用
    const call = await fetch(`${e.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.secret}`, 'content-type': 'application/json' },
      body: chatBody(),
    });
    assert.equal(call.status, 200);

    // 列表里绝不出现明文
    const listed = (await (await fetch(`${e.base}/admin/api/keys`, { headers: H })).json()) as Record<string, any>;
    assert.ok(!JSON.stringify(listed).includes(created.secret), '接口不得回显明文 key');
    assert.ok(listed.keys.some((k: any) => k.id === created.key.id));
  } finally {
    await e.close();
  }
});

test('e2e: 面板可改分层/模型白名单、轮换、禁用、重置额度', async () => {
  const e = await boot({ adminToken: 'tok-1234567890abcdef' });
  const H = { 'X-Admin-Token': 'tok-1234567890abcdef', 'content-type': 'application/json' };
  const callWith = (key: string, body: Record<string, unknown> = {}): Promise<Response> =>
    fetch(`${e.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: chatBody(body),
    });
  try {
    const c = (await (await fetch(`${e.base}/admin/api/keys/create`, { method: 'POST', headers: H, body: JSON.stringify({ tier: 'standard', tenantId: 't', label: 'x' }) })).json()) as Record<string, any>;
    const id = c.key.id;

    // 限制模型 → 别的模型被拒（403 model_not_allowed）
    await fetch(`${e.base}/admin/api/keys/update`, { method: 'POST', headers: H, body: JSON.stringify({ keyId: id, allowedModels: ['mock-small'] }) });
    assert.equal((await callWith(c.secret, { model: 'mock-large' })).status, 403);

    // 放开白名单 → 恢复
    await fetch(`${e.base}/admin/api/keys/update`, { method: 'POST', headers: H, body: JSON.stringify({ keyId: id, allowedModels: null }) });
    assert.equal((await callWith(c.secret, { model: 'mock-large' })).status, 200);

    // 轮换：旧 key 立即失效，新 key 可用
    const rotated = (await (await fetch(`${e.base}/admin/api/keys/rotate`, { method: 'POST', headers: H, body: JSON.stringify({ keyId: id }) })).json()) as Record<string, any>;
    assert.ok(rotated.secret !== c.secret);
    assert.equal((await callWith(c.secret)).status, 401, '旧 key 必须立即失效');
    assert.equal((await callWith(rotated.secret)).status, 200);

    // 禁用 → 401
    await fetch(`${e.base}/admin/api/keys/revoke`, { method: 'POST', headers: H, body: JSON.stringify({ keyId: id }) });
    assert.equal((await callWith(rotated.secret)).status, 401);
  } finally {
    await e.close();
  }
});

test('e2e: 面板写操作全部进事件流（可审计）', async () => {
  const e = await boot({ adminToken: 'tok-1234567890abcdef' });
  const H = { 'X-Admin-Token': 'tok-1234567890abcdef', 'content-type': 'application/json' };
  try {
    const c = (await (await fetch(`${e.base}/admin/api/keys/create`, { method: 'POST', headers: H, body: JSON.stringify({ tier: 'pro', tenantId: 't' }) })).json()) as Record<string, any>;
    await fetch(`${e.base}/admin/api/keys/reset-quota`, { method: 'POST', headers: H, body: JSON.stringify({ keyId: c.key.id }) });
    await fetch(`${e.base}/admin/api/providers/toggle`, { method: 'POST', headers: H, body: JSON.stringify({ id: 'mock', disabled: true }) });
    await fetch(`${e.base}/admin/api/providers/toggle`, { method: 'POST', headers: H, body: JSON.stringify({ id: 'mock', disabled: false }) });
    await fetch(`${e.base}/admin/api/loss-reduction/update`, { method: 'POST', headers: H, body: JSON.stringify({ precheck: { enabled: false } }) });

    const events = (await (await fetch(`${e.base}/admin/api/events?limit=20`, { headers: H })).json()) as Record<string, any>;
    const kinds = events.events.map((x: any) => x.kind);
    for (const kind of ['key.create', 'quota.reset', 'provider.toggle', 'loss_reduction.update']) {
      assert.ok(kinds.includes(kind), `事件流缺少 ${kind}: ${JSON.stringify(kinds)}`);
    }
  } finally {
    await e.close();
  }
});

test('e2e: 降损层开关热更新后立刻生效（关闭预检即不再拦截）', async () => {
  const e = await boot({ adminToken: 'tok-1234567890abcdef' });
  const H = { 'X-Admin-Token': 'tok-1234567890abcdef', 'content-type': 'application/json' };
  const bad = JSON.stringify({
    model: 'mock-small',
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: { bad: true } } }] },
    ],
  });
  const post = (): Promise<Response> =>
    fetch(`${e.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-e2e', 'content-type': 'application/json' },
      body: bad,
    });
  try {
    assert.equal((await post()).status, 400, '默认 enforce 应拦截');

    const r = (await (
      await fetch(`${e.base}/admin/api/loss-reduction/update`, { method: 'POST', headers: H, body: JSON.stringify({ precheck: { enabled: false } }) })
    ).json()) as Record<string, any>;
    assert.ok(r.changed.some((x: string) => x.includes('precheck')));
    assert.equal((await post()).status, 200, '关闭预检后必须放行（可逆、可控）');
  } finally {
    await e.close();
  }
});

test('e2e: 面板权限边界——无令牌不能做任何写操作', async () => {
  const e = await boot({ adminToken: 'tok-1234567890abcdef' });
  try {
    for (const path of ['keys/create', 'keys/revoke', 'keys/rotate', 'keys/reset-quota', 'providers/toggle', 'loss-reduction/update']) {
      const res = await fetch(`${e.base}/admin/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keyId: 'x', id: 'mock' }) });
      assert.equal(res.status, 401, `${path} 未鉴权时必须 401`);
    }
  } finally {
    await e.close();
  }
});

/* ------------------------------------------------------------------ *
 * 持久化：进程重启后度量仍在
 * ------------------------------------------------------------------ */

test('e2e: SQLite 持久化——重启后仍能读到历史度量', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-persist-'));
  const dbPath = join(dir, 'relay.db');
  const mock = new MockUpstream({ port: 0, logger: silent });
  const mockBound = await mock.listen();
  const yaml = `
server: { host: 127.0.0.1, port: 0 }
storage: { driver: sqlite, path: ${JSON.stringify(dbPath)} }
logLevel: error
providers:
  - id: mock
    label: mock
    protocol: openai
    baseUrl: ${JSON.stringify(mockBound.url)}
    apiKey: mock-key
    models: [mock-small]
clients:
  - id: pro
    label: pro
    key: "{ENV:RELAY_KEY_PRO}"
    tier: pro
    tenantId: t1
    enabled: true
lossReduction:
  meter: { batchSize: 1, flushIntervalMs: 20 }
`;
  const cfgPath = join(dir, 'relay.yaml');
  writeFileSync(cfgPath, yaml, 'utf8');
  const env = { RELAY_KEY_PRO: 'sk-pro-persist' } as NodeJS.ProcessEnv;

  try {
    /* 第一次进程：发一个请求并退出 */
    const app1 = await createApp(loadConfig({ path: cfgPath, env }), silent);
    const bound1 = await app1.start();
    const res = await fetch(`${bound1.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-persist', 'content-type': 'application/json' },
      body: chatBody(),
    });
    assert.equal(res.status, 200);
    await res.json();

    /* 面板创建的 key 必须持久化：明文不可恢复，但哈希能用 */
    const created = (await (
      await fetch(`${bound1.url}/admin/api/keys/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier: 'pro', tenantId: 'acme', label: '跨重启 key' }),
      })
    ).json()) as Record<string, any>;
    const panelSecret = created.secret;
    assert.ok(panelSecret, '面板应返回明文 key');
    await app1.shutdown();

    /* 第二次进程：同一个数据库，历史度量必须还在，面板 key 也必须还能用 */
    const app2 = await createApp(loadConfig({ path: cfgPath, env }), silent);
    const bound2 = await app2.start();
    try {
      await app2.store.flush();
      const overview = (await (await fetch(`${bound2.url}/healthz`)).json()) as Record<string, any>;
      assert.equal(overview.status, 'ok');
      const summary = app2.meter.summarize(86_400_000);
      assert.ok(summary.overall.requests >= 1, '重启后应能读到重启前的度量');
      assert.equal(overview.store.path, dbPath);

      const call = await fetch(`${bound2.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${panelSecret}`, 'content-type': 'application/json' },
        body: chatBody(),
      });
      assert.equal(call.status, 200, '面板创建的 key 重启后必须仍然可用（哈希持久化）');

      const keys = (await (await fetch(`${bound2.url}/admin/api/keys`, { headers: { 'content-type': 'application/json' } })).json()) as Record<string, any>;
      const restored = keys.keys.find((k: any) => k.id === created.key.id);
      assert.ok(restored, '重启后应能从库里恢复面板 key');
      assert.equal(restored.origin, 'panel');
    } finally {
      await app2.shutdown();
    }
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 多 key 池
 * ------------------------------------------------------------------ */

test('e2e: 多 key 池在某个 key 被拒时自动轮换（用户无感，内部两次请求）', async () => {
  const e = await boot({
    apiKeysYaml: `    apiKeys: ["bad-key-1", "good-key-2"]`,
    acceptedApiKeys: ['good-key-2'],
  });
  try {
    const res = await fetch(`${e.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-e2e', 'content-type': 'application/json' },
      body: chatBody(),
    });
    assert.equal(res.status, 200, '坏 key 应被自动换成好 key，而不是把错误抛给用户');
    assert.equal(e.mock.count, 2, '内部应发生两次上游请求（坏 key 被拒 → 换 key）');
    const usedKeys = e.mock.received.map((r) => (r.headers['authorization'] ?? '').replace('Bearer ', ''));
    assert.deepEqual(usedKeys, ['bad-key-1', 'good-key-2']);

    const pool = e.app.pool.snapshot()[0]!;
    assert.equal(pool.apiKeyMasked, '2 keys');
    assert.equal(pool.keyPool!.length, 2);
    assert.equal(pool.keyPool![0]!.dead, true, '401 的 key 应被判定为报废');
    assert.equal(pool.keyPool![1]!.dead, false);
  } finally {
    await e.close();
  }
});

/* ------------------------------------------------------------------ *
 * 公开额度端点（给本机面板/插件读，无需管理令牌）
 * ------------------------------------------------------------------ */

test('e2e: /v1/quota 无需令牌即可读，且只暴露计数不暴露密钥', async () => {
  const e = await boot();
  try {
    // 造两个请求
    for (let i = 0; i < 2; i++) {
      await fetch(`${e.base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-pro-e2e', 'content-type': 'application/json' },
        body: chatBody(),
      });
    }
    const res = await fetch(`${e.base}/v1/quota`);
    assert.equal(res.status, 200, '公开端点不该要求令牌');
    const body = (await res.json()) as Record<string, any>;

    // 结构：窗口 + 上游
    assert.ok(Array.isArray(body.windows));
    const w5 = body.windows.find((w: any) => w.windowHours === 5);
    assert.ok(w5, '必须有 5 小时窗口');
    assert.equal(w5.requests, 2);
    assert.ok(w5.oldestTs > 0, '窗口内最早请求时间必须给出来');
    assert.equal(w5.nextReleaseAt, w5.oldestTs + 5 * 3600_000, '释放时刻 = 最早请求 + 窗口长度');

    // 绝不泄漏敏感信息
    const text = JSON.stringify(body);
    assert.ok(!text.includes('sk-'), '不得暴露任何密钥');
    assert.ok(!text.includes('authorization'), '不得暴露鉴权头');
    assert.ok(!/messages|content|prompt_text/.test(text), '不得暴露正文');
  } finally {
    await e.close();
  }
});

test('e2e: 可用 publicQuota=false 关闭公开端点', async () => {
  const e = await boot();
  try {
    e.app.config.server.publicQuota = false;
    const res = await fetch(`${e.base}/v1/quota`);
    assert.equal(res.status, 404);
  } finally {
    await e.close();
  }
});

/* ------------------------------------------------------------------ *
 * 额度计数必须跨重启存活（否则滚动窗口计数会归零）
 * ------------------------------------------------------------------ */

test('e2e: /v1/quota 的窗口计数走 SQLite，重启后不归零', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-quota-'));
  const dbPath = join(dir, 'relay.db');
  const mock = new MockUpstream({ port: 0, logger: silent });
  const mockBound = await mock.listen();
  const yaml = `
server: { host: 127.0.0.1, port: 0 }
storage: { driver: sqlite, path: ${JSON.stringify(dbPath)} }
logLevel: error
providers:
  - id: mock
    label: mock
    protocol: openai
    baseUrl: ${JSON.stringify(mockBound.url)}
    apiKey: mock-key
    models: [mock-small, mock-large]
clients:
  - id: pro
    label: pro
    key: "{ENV:RELAY_KEY_PRO}"
    tier: pro
    tenantId: t1
    enabled: true
lossReduction:
  meter: { batchSize: 1, flushIntervalMs: 20 }
`;
  const cfgPath = join(dir, 'relay.yaml');
  writeFileSync(cfgPath, yaml, 'utf8');
  const env = { RELAY_KEY_PRO: 'sk-quota-restart' } as NodeJS.ProcessEnv;

  try {
    /* 第一次进程：不同模型各发一次，让模型分布有两条 */
    const app1 = await createApp(loadConfig({ path: cfgPath, env }), silent);
    const b1 = await app1.start();
    for (const model of ['mock-small', 'mock-large']) {
      await fetch(`${b1.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-quota-restart', 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
      });
    }
    const before = (await (await fetch(`${b1.url}/v1/quota`)).json()) as Record<string, any>;
    const w5before = before.windows.find((w: any) => w.windowHours === 5);
    assert.equal(w5before.requests, 2);
    assert.equal(w5before.models.length, 2, '模型分布应有两条');
    assert.ok(w5before.oldestTs > 0);
    await app1.shutdown();

    /* 第二次进程：内存镜像为空，但计数必须还在（这是回归点） */
    const app2 = await createApp(loadConfig({ path: cfgPath, env }), silent);
    const b2 = await app2.start();
    try {
      await app2.store.flush();
      const after = (await (await fetch(`${b2.url}/v1/quota`)).json()) as Record<string, any>;
      const w5after = after.windows.find((w: any) => w.windowHours === 5);
      assert.equal(w5after.requests, 2, '重启后 5 小时窗口计数不能归零');
      assert.equal(w5after.models.length, 2, '重启后模型分布不能丢');
      assert.equal(w5after.nextReleaseAt, w5after.oldestTs + 5 * 3600_000);
      const models = w5after.models.map((m: any) => m.model).sort();
      assert.deepEqual(models, ['mock-large', 'mock-small']);
      // 每个模型都要有 token 与成本，不只是次数
      for (const m of w5after.models) {
        assert.ok(m.totalTokens > 0, `${m.model} 应有 token 数`);
        assert.equal(typeof m.costCny, 'number');
      }
    } finally {
      await app2.shutdown();
    }
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 公开面板数据包：一次调用给齐各视图，且不得泄漏管理面字段
 * ------------------------------------------------------------------ */

test('e2e: /v1/panel 一次给齐各视图数据', async () => {
  const e = await boot();
  try {
    for (const model of ['mock-small', 'mock-large']) {
      await fetch(`${e.base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-pro-e2e', 'content-type': 'application/json' },
        body: chatBody({ model }),
      });
    }
    const res = await fetch(`${e.base}/v1/panel?window=1h&traces=10`);
    assert.equal(res.status, 200, '公开面板端点不该要求令牌');
    const d = (await res.json()) as Record<string, any>;

    // 各视图的数据都在
    assert.ok(d.overview?.summary?.overall, '缺总览');
    assert.ok(d.metrics?.counters, '缺指标计数器');
    assert.ok(d.metrics?.derived, '缺派生比率');
    assert.ok(Array.isArray(d.providers), '缺上游');
    assert.ok(Array.isArray(d.reachability), '缺模型可达性');
    assert.ok(Array.isArray(d.traces) && d.traces.length >= 2, '缺轨迹');
    assert.ok(Array.isArray(d.keys), '缺 key 用量');
    assert.ok(Array.isArray(d.attribution?.failure_reasons), '缺归因词表');

    // 轨迹要能支撑 P5 视图
    const t0 = d.traces[0];
    assert.ok(typeof t0.traceId === 'string' && Array.isArray(t0.steps) && t0.steps.length > 0);
    assert.ok(t0.steps.every((s: any) => typeof s.stage === 'string' && typeof s.ok === 'boolean'));
  } finally {
    await e.close();
  }
});

test('e2e: /v1/panel 绝不泄漏 hashPrefix 与任何密钥', async () => {
  const e = await boot();
  try {
    await fetch(`${e.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-e2e', 'content-type': 'application/json' },
      body: chatBody(),
    });
    const text = await (await fetch(`${e.base}/v1/panel`)).text();

    // hashPrefix 是管理员核对 key 用的，属管理面字段
    assert.ok(!text.includes('hashPrefix'), '公开端点不得出现 hashPrefix');
    assert.ok(!text.includes('sk-pro-e2e'), '不得回显客户端 key 明文');
    assert.ok(!/sk-[A-Za-z0-9]{8}/.test(text), '不得出现任何 sk- 开头的密钥');
    assert.ok(!text.toLowerCase().includes('authorization'), '不得出现鉴权头');
    assert.ok(!/baseUrl|apiKey/.test(text), '不得暴露上游地址与密钥字段');
  } finally {
    await e.close();
  }
});

test('e2e: /v1/panel 的轨迹跨重启仍可回看', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-panel-'));
  const dbPath = join(dir, 'relay.db');
  const mock = new MockUpstream({ port: 0, logger: silent });
  const mockBound = await mock.listen();
  const yaml = `
server: { host: 127.0.0.1, port: 0 }
storage: { driver: sqlite, path: ${JSON.stringify(dbPath)} }
logLevel: error
providers:
  - id: mock
    label: mock
    protocol: openai
    baseUrl: ${JSON.stringify(mockBound.url)}
    apiKey: mock-key
    models: [mock-small]
clients:
  - id: pro
    label: pro
    key: "{ENV:RELAY_KEY_PRO}"
    tier: pro
    tenantId: t1
    enabled: true
lossReduction:
  meter: { batchSize: 1, flushIntervalMs: 20 }
`;
  const cfgPath = join(dir, 'relay.yaml');
  writeFileSync(cfgPath, yaml, 'utf8');
  const env = { RELAY_KEY_PRO: 'sk-panel-restart' } as NodeJS.ProcessEnv;
  try {
    const app1 = await createApp(loadConfig({ path: cfgPath, env }), silent);
    const b1 = await app1.start();
    await fetch(`${b1.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-panel-restart', 'content-type': 'application/json' },
      body: chatBody(),
    });
    await app1.store.flush();
    await app1.shutdown();

    const app2 = await createApp(loadConfig({ path: cfgPath, env }), silent);
    const b2 = await app2.start();
    try {
      await app2.store.flush();
      const d = (await (await fetch(`${b2.url}/v1/panel`)).json()) as Record<string, any>;
      assert.ok(d.traces.length >= 1, '重启后仍应能回看轨迹（来自 SQLite，而非内存环）');
      assert.ok(d.traces[0].steps.length > 0);
    } finally {
      await app2.shutdown();
    }
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 事故复现：客户端拿错 key → 全天 401，面板必须自己说出来
 * ------------------------------------------------------------------ */

test('e2e: 客户端拿错 key 时，面板要能指出"是 key 不对"而不是让人以为服务挂了', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-authdiag-'));
  const dbPath = join(dir, 'relay.db');
  const mock = new MockUpstream({ port: 0, logger: silent });
  const mockBound = await mock.listen();
  const yaml = `
server: { host: 127.0.0.1, port: 0 }
storage: { driver: sqlite, path: ${JSON.stringify(dbPath)} }
logLevel: error
providers:
  - id: mock
    label: mock
    protocol: openai
    baseUrl: ${JSON.stringify(mockBound.url)}
    apiKey: mock-key
    models: [mock-small]
clients:
  - id: pro
    label: pro
    key: "{ENV:RELAY_KEY_PRO}"
    tier: pro
    tenantId: t1
    enabled: true
lossReduction:
  meter: { batchSize: 1, flushIntervalMs: 20 }
`;
  const cfgPath = join(dir, 'relay.yaml');
  writeFileSync(cfgPath, yaml, 'utf8');
  const env = { RELAY_KEY_PRO: 'sk-good-now' } as NodeJS.ProcessEnv;
  const stale = 'sk-relay-old-key-from-last-round';

  try {
    const app1 = await createApp(loadConfig({ path: cfgPath, env }), silent);
    const b1 = await app1.start();
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${b1.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${stale}`, 'content-type': 'application/json' },
        body: chatBody(),
      });
      assert.equal(r.status, 401, '旧 key 必须被拒');
      const body = (await r.json()) as Record<string, any>;
      assert.equal(body.error.code, 'invalid_key');
    }
    await app1.store.flush();

    // 同一进程内：面板必须已经能说出"是客户端 key 不对"
    const live = app1.meter.summarize(3_600_000);
    assert.equal(live.clientAuthFailures.count, 3, '客户端 401 必须计入 clientAuthFailures');
    assert.equal(
      live.byFailureReason.find((r) => r.reason === 'auth_invalid'),
      undefined,
      '客户端 401 不得混进上游失败归因（否则横幅会说成上游密钥问题）',
    );
    assert.equal(app1.keys.authRejections().total, 3, '被拒 key 台账要留下指纹');
    assert.equal(app1.keys.authRejections().groups[0]!.matchesIssuedKey, false);

    await app1.shutdown();

    // 重启后：结论不能丢，否则运维第二天打开面板会以为"一切正常"
    const app2 = await createApp(loadConfig({ path: cfgPath, env }), silent);
    const b2 = await app2.start();
    try {
      await app2.store.flush();
      const after = app2.meter.summarize(3_600_000);
      assert.equal(after.clientAuthFailures.count, 3, '重启后仍必须看得见这 3 次 key 拒绝');
      const byTier = after.byTier.find((r) => r.key === '(未鉴权)');
      assert.equal(byTier?.requests, 3, '未鉴权流量必须单独成桶');
      assert.equal(after.byTier.find((r) => r.key === 'free'), undefined, '不得冒充 free 层');

      // 面板自检接口：把旧 key 贴进去，直接告诉用户"这不是本网关签发的"
      const who = (await (
        await fetch(`${b2.url}/admin/api/keys/whoami`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ secret: stale }),
        })
      ).json()) as Record<string, any>;
      assert.equal(who.status, 'not_issued');
      assert.equal(who.found, false);

      // 对照：正确的 key 必须自检通过，并报出它是哪个 key
      const ok = (await (
        await fetch(`${b2.url}/admin/api/keys/whoami`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ secret: 'sk-good-now' }),
        })
      ).json()) as Record<string, any>;
      assert.equal(ok.status, 'ok');
      assert.equal(ok.key.id, 'pro');

      // 正确的 key 能正常转发（证明"服务没挂，是 key 不对"）
      const good = await fetch(`${b2.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-good-now', 'content-type': 'application/json' },
        body: chatBody(),
      });
      assert.equal(good.status, 200);
    } finally {
      await app2.shutdown();
    }
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('e2e: 面板设的「预算(元)」必须跨重启仍在（逐字段映射最容易漏）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cny-restart-'));
  const dbPath = join(dir, 'relay.db');
  const mock = new MockUpstream({ port: 0, logger: silent });
  const mockBound = await mock.listen();
  const yaml = `
server: { host: 127.0.0.1, port: 0 }
storage: { driver: sqlite, path: ${JSON.stringify(dbPath)} }
logLevel: error
providers:
  - id: mock
    label: mock
    protocol: openai
    baseUrl: ${JSON.stringify(mockBound.url)}
    apiKey: mock-key
    models: [mock-small]
    cost: { inputPerMTok: 3, outputPerMTok: 6, cachedInputPerMTok: 0.025 }
clients: []
lossReduction:
  meter: { batchSize: 1, flushIntervalMs: 20 }
`;
  const cfgPath = join(dir, 'relay.yaml');
  writeFileSync(cfgPath, yaml, 'utf8');
  try {
    const app1 = await createApp(loadConfig({ path: cfgPath }), silent);
    const b1 = await app1.start();
    const created = (await (
      await fetch(`${b1.url}/admin/api/keys/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier: 'pro', tenantId: 'acme', label: '带预算', quotaCny: 10 }),
      })
    ).json()) as Record<string, any>;
    assert.equal(created.key.quotaCnyOverride, 10, '创建响应就该带上预算');
    await app1.store.flush();
    await app1.shutdown();

    // 重启：内存全丢，只能从 key_meta 恢复
    const app2 = await createApp(loadConfig({ path: cfgPath }), silent);
    const b2 = await app2.start();
    try {
      const keys = (await (await fetch(`${b2.url}/admin/api/keys`)).json()) as Record<string, any>;
      const k = keys.keys.find((x: any) => x.id === created.key.id);
      assert.ok(k, '重启后应恢复这个 key');
      assert.equal(k.quotaCnyOverride, 10, '预算必须跨重启仍在');
      assert.equal(k.usage.quotaCny, 10, '用量视图里的预算口径也要在');
    } finally {
      await app2.shutdown();
    }
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('e2e: 流式整体超时必须真的咬人（上游慢慢流也会被截断）', async () => {
  // 完整流 = 6 块 × 300ms ≈ 1.8s；整体上限 1000ms 应当提前掐断
  const e = await boot({
    serverYaml: '  upstreamTimeoutMs: 1000\n  upstreamTtfbTimeoutMs: 3000',
  });
  try {
    e.mock.queueScenarios('mock-small', [{ status: 200, chunkDelayMs: 300 }]);
    const t0 = Date.now();
    const res = await fetch(`${e.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-e2e', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-small', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    const text = await res.text();
    const elapsed = Date.now() - t0;
    // 审计 D-P0-2：upstreamTimeoutMs 此前从未真正 arm —— "首块之后无看门狗"，
    // 上游慢慢流就能无限期挂住，面板上的"总上限"只是假话。现在必须提前截断。
    assert.ok(elapsed < 1_500, `应被整体超时截断（实际 ${elapsed}ms，完整流约 1800ms）`);
    assert.ok(!text.includes('data: [DONE]'), '被截断的流不应有 [DONE]（EOF 截断是标准信号）');
    assert.ok(text.length > 0, '但已送达的 chunk 应在');
  } finally {
    await e.close();
  }
});
