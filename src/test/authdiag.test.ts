/**
 * 「API 全 401，但系统里没有一处告诉你为什么」的回归测试。
 *
 * 背景（真实事故）：用户评测时客户端拿的还是上一轮的旧 key，网关连回 202 次 401。
 * 结果是：
 *   1. 日志里没有任何一行记录这次拒绝；
 *   2. 401 文案只有一句"无效的 relay key"，分不清"没签发过"和"已轮换"；
 *   3. 面板的失败归因只读**内存**，重启后只剩 1 条，而 byModel/byTier 走 SQL 报 199 条
 *      —— 同一个看板自己跟自己矛盾；
 *   4. 这 202 条未鉴权请求被记成 tier=free / model="" / provider=""，读起来像"免费层全挂了"。
 *
 * 这组测试把上面每一条都钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, SqliteStore, UNATTRIBUTED, UNATTRIBUTED_KEY_ID } from '../store/index.js';
import { KeyRegistry, fingerprintOf } from '../gateway/keys.js';
import { memoryConfig } from '../app.js';
import { Logger } from '../core/logger.js';
import { Meter } from '../loss/meter.js';
import { inspectConfig } from '../core/config.js';
import type { MeterRecord, TierId } from '../core/types.js';

const silent = new Logger('error', () => undefined);

/** 造一条度量记录（默认是"未鉴权的 401"，也就是事故里那 202 条的样子） */
function mkRecord(patch: Partial<MeterRecord> = {}): MeterRecord {
  return {
    ts: Date.now(),
    traceId: 'tr_x',
    requestId: 'req_x',
    keyId: UNATTRIBUTED_KEY_ID,
    tenantId: 'anonymous',
    tier: 'free' as TierId,
    clientKind: 'unknown',
    agentScore: 0,
    model: '',
    providerId: '',
    stream: false,
    toolCalling: false,
    outcome: 'client_error',
    httpStatus: 401,
    durationMs: 1,
    ttfbMs: null,
    bytesIn: 10,
    bytesOut: 200,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    costCny: 0,
    listCostCny: 0,
    attemptCount: 0,
    failureReason: 'auth_invalid',
    quickAction: 'fix_credentials',
    recoverable: false,
    precheckViolations: 0,
    precheckBlocked: false,
    precheckDegraded: false,
    precheckUs: 0,
    classifyUs: 0,
    attributionDelivered: true,
    duplicateInWindow: 1,
    ...patch,
  };
}

/* ------------------------------------------------------------------ *
 * 1. 失败归因必须跨重启（这是"面板说没事"的直接成因）
 * ------------------------------------------------------------------ */

test('失败归因跨重启：byFailureReason / clientAuth 不能只有内存那几条', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-attrib-'));
  const dbPath = join(dir, 'relay.db');
  try {
    /* 第一个"进程"：写入 5 条客户端 401 + 2 条上游限流 */
    const s1 = new SqliteStore({ path: dbPath, flushIntervalMs: 10, batchSize: 1, logger: silent });
    await s1.init();
    for (let i = 0; i < 5; i++) s1.record(mkRecord({ ts: Date.now() - 1000 }));
    for (let i = 0; i < 2; i++) {
      s1.record(
        mkRecord({
          ts: Date.now() - 1000,
          keyId: 'pro',
          tenantId: 't1',
          tier: 'pro' as TierId,
          clientKind: 'script',
          model: 'm1',
          providerId: 'p1',
          outcome: 'upstream_error',
          httpStatus: 429,
          failureReason: 'rate_limited',
          quickAction: 'retry_with_backoff',
          recoverable: true,
        }),
      );
    }
    await s1.flush();
    await s1.close();

    /* 第二个"进程"：全新的 store，内存镜像为空 */
    const s2 = new SqliteStore({ path: dbPath, flushIntervalMs: 10, batchSize: 1, logger: silent });
    await s2.init();
    try {
      const st = s2.attributionStats(Date.now() - 3_600_000);
      // 重启后仍必须看得见历史失败（修复前这里只剩内存里的 0 条）
      assert.equal(st.clientAuth.count, 5, '客户端 401 次数必须跨重启保留');
      const rl = st.byReason.find((r) => r.reason === 'rate_limited');
      assert.equal(rl?.count, 2, '上游限流次数必须跨重启保留');

      // 客户端 key 被拒（无上游参与）不得混进"上游失败归因"，否则横幅会说成"上游拒绝密钥"
      assert.equal(
        st.byReason.find((r) => r.reason === 'auth_invalid'),
        undefined,
        '客户端 401 不能冒充上游 auth_invalid',
      );

      // 维度聚合：未鉴权流量必须单独成桶，不能冒充 free 层 / 空模型
      const byTier = s2.dimensionStats(Date.now() - 3_600_000, 'tier')!;
      assert.equal(byTier.get(UNATTRIBUTED)?.requests, 5, '未鉴权请求应落在 (未鉴权) 桶');
      assert.equal(byTier.get('pro')?.requests, 2);
      assert.equal(byTier.get('free'), undefined, '未鉴权流量不得算到 free 层头上');

      const byModel = s2.dimensionStats(Date.now() - 3_600_000, 'model')!;
      const byProvider = s2.dimensionStats(Date.now() - 3_600_000, 'provider_id')!;
      assert.equal(byModel.get(UNATTRIBUTED)?.requests, 5);
      assert.equal(byModel.get('') , undefined, '不得再出现空字符串桶');
      assert.equal(byProvider.get(UNATTRIBUTED)?.requests, 5);
      assert.equal(byProvider.get('') , undefined);
    } finally {
      await s2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('内存实现与 SQL 实现的桶名必须逐字一致（曾经是 "unknown" vs ""）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-parity-'));
  try {
    const mem = new MemoryStore();
    const sql = new SqliteStore({ path: join(dir, 'relay.db'), flushIntervalMs: 10, batchSize: 1, logger: silent });
    await sql.init();
    try {
      for (const s of [mem, sql]) {
        s.record(mkRecord()); // 未鉴权
        s.record(mkRecord({ keyId: 'k1', tier: 'pro' as TierId, model: '', providerId: '', outcome: 'client_error', httpStatus: 400, failureReason: 'invalid_request' })); // 已鉴权但没解析出模型
      }
      await sql.flush();
      const from = Date.now() - 3_600_000;
      for (const dim of ['tier', 'model', 'provider_id'] as const) {
        const a = [...mem.dimensionStats(from, dim)!.keys()].sort();
        const b = [...sql.dimensionStats(from, dim)!.keys()].sort();
        assert.deepEqual(b, a, `维度 ${dim} 的两套实现桶名不一致`);
      }
    } finally {
      await sql.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 2. 被拒的 key 必须留得下证据（指纹），并且能被人工对上号
 * ------------------------------------------------------------------ */

function makeRegistry(
  clients: { id: string; key: string; tier: TierId; enabled?: boolean; expiresAt?: number; quotaCny?: number }[],
  extra: { models?: string[]; ladders?: Record<string, string[]> } = {},
) {
  const store = new MemoryStore();
  const config = memoryConfig({
    ...(extra.models
      ? { providers: [{ id: 'p1', label: 'p1', protocol: 'openai' as const, baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', models: extra.models, priority: 1 }] }
      : {}),
    ...(extra.ladders ? { modelLadders: extra.ladders } : {}),
    clients: clients.map((c) => ({
      id: c.id,
      label: c.id,
      key: c.key,
      tier: c.tier,
      tenantId: 't1',
      enabled: c.enabled ?? true,
      ...(c.expiresAt !== undefined ? { expiresAt: c.expiresAt } : {}),
      ...(c.quotaCny !== undefined ? { quotaCny: c.quotaCny } : {}),
    })),
  });
  return { registry: new KeyRegistry({ config, store, logger: silent }), config, store };
}

test('鉴权失败的 401 文案必须带指纹，且指纹能对上"已签发 key"列表', async () => {
  const { registry } = makeRegistry([{ id: 'pro', key: 'sk-relay-good', tier: 'pro' }]);
  const stale = 'sk-relay-old-key-from-last-round';
  const out = await registry.authenticate({ authorization: `Bearer ${stale}`, path: '/v1/chat/completions' });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.code, 'invalid_key');
  assert.ok(out.error.message.includes(fingerprintOf(stale)), '401 文案里应包含客户端 key 的指纹');

  const rej = registry.authRejections();
  assert.equal(rej.total, 1);
  assert.equal(rej.groups.length, 1);
  const g = rej.groups[0]!;
  assert.equal(g.code, 'invalid_key');
  assert.equal(g.fingerprint, fingerprintOf(stale));
  assert.equal(g.keyLength, stale.length, '记长度才能分辨"没带 key"和"带了个错的 key"');
  assert.equal(g.headerForm, 'bearer');
  assert.equal(g.matchesIssuedKey, false, '这个 key 不是本网关签发的');

  // 已签发 key 的指纹就在面板的 key 列表里，人工可直接对照
  const issued = registry.listKeys().map((k) => k.hashPrefix);
  assert.ok(!issued.includes(fingerprintOf(stale)));
  assert.equal(registry.listKeys()[0]!.hashPrefix, fingerprintOf('sk-relay-good'));
});

test('同一种错 key 刷 200 次只聚成一行；不同 key 分开记', async () => {
  const { registry } = makeRegistry([{ id: 'pro', key: 'sk-relay-good', tier: 'pro' }]);
  for (let i = 0; i < 200; i++) await registry.authenticate({ authorization: 'Bearer sk-relay-wrong' });
  await registry.authenticate({ authorization: 'Bearer sk-relay-wrong-2' });
  const rej = registry.authRejections();
  assert.equal(rej.total, 201);
  assert.equal(rej.groups.length, 2, '200 次同一个错 key 只占一行');
  assert.equal(rej.groups[0]!.count, 200);
  assert.equal(rej.groups[1]!.count, 1);
});

test('提交形态可分辨：没带 key / 裸 key（少写 Bearer）/ 标准 Bearer', async () => {
  const { registry } = makeRegistry([{ id: 'pro', key: 'sk-relay-good', tier: 'pro' }]);
  await registry.authenticate({});
  await registry.authenticate({ authorization: 'sk-relay-wrong-bare' }); // 裸 key（没写 Bearer）
  await registry.authenticate({ authorization: 'Bearer sk-relay-wrong' });
  // 对照：形态正确且 key 也正确时必须通过，不能进台账
  const ok = await registry.authenticate({ authorization: 'Bearer sk-relay-good' });
  assert.equal(ok.ok, true);
  assert.equal(registry.authRejections().total, 3, '成功的鉴权不进台账');
  const forms = registry.authRejections().groups.map((g) => g.headerForm).sort();
  assert.deepEqual(forms, ['bare', 'bearer', 'none']);
});

test('key 自检（whoami）：有效 / 已禁用 / 已过期 / 不是这里签发的 四种结论', async () => {
  const { registry } = makeRegistry([
    { id: 'ok', key: 'sk-relay-ok', tier: 'pro' },
    { id: 'off', key: 'sk-relay-off', tier: 'pro', enabled: false },
    { id: 'old', key: 'sk-relay-expired', tier: 'pro', expiresAt: Date.now() - 1000 },
  ]);

  const good = registry.resolveSecret('sk-relay-ok');
  assert.equal(good.status, 'ok');
  assert.equal(good.key?.id, 'ok');
  assert.equal(good.fingerprint, fingerprintOf('sk-relay-ok'));

  assert.equal(registry.resolveSecret('sk-relay-off').status, 'key_disabled');
  assert.equal(registry.resolveSecret('sk-relay-expired').status, 'expired_key');

  const unknown = registry.resolveSecret('sk-relay-never-issued');
  assert.equal(unknown.status, 'not_issued');
  assert.equal(unknown.found, false);
  assert.equal(unknown.key, undefined);
});

test('被禁用的 key：401 说法必须是"已禁用"，且指纹命中已签发列表', async () => {
  const { registry } = makeRegistry([{ id: 'off', key: 'sk-relay-off', tier: 'pro', enabled: false }]);
  const out = await registry.authenticate({ authorization: 'Bearer sk-relay-off' });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.code, 'key_disabled');
  const g = registry.authRejections().groups[0]!;
  assert.equal(g.matchesIssuedKey, true, 'key 存在但不可用 —— 与"根本不是这里签发的"必须区分开');
});

/* ------------------------------------------------------------------ *
 * 3. 配置检查器不能先崩
 * ------------------------------------------------------------------ */

test('客户端缺 tier：校验给出明确错误，而不是让渲染层崩在 padEnd 上', () => {
  const config = memoryConfig({
    clients: [{ id: 'c2', label: 'c2', key: 'sk-x', tenantId: 'demo', enabled: true } as never],
  });
  const issues = inspectConfig(config);
  const err = issues.find((i) => i.level === 'error' && /缺少 tier/.test(i.message));
  assert.ok(err, `缺 tier 必须是一个明确 error，实际: ${JSON.stringify(issues.map((i) => i.message))}`);
  assert.match(err!.message, /必须从 free \/ standard \/ pro 里选一个/);
});

/* ------------------------------------------------------------------ *
 * 4. 面板自身必须是"可执行的 JS"（tsc 查不出内嵌 <script> 的语法错）
 * ------------------------------------------------------------------ */

test('看板内嵌脚本语法正确，且带上鉴权自检入口', async () => {
  const { dashboardHtml } = await import('../admin/dashboard.js');
  const html = dashboardHtml();
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, '看板必须内嵌一个 <script>');
  const js = m![1]!;
  // 用 Function 构造做语法检查：不执行，只解析
  assert.doesNotThrow(() => new Function(js), '内嵌脚本必须能通过语法解析');
  for (const needle of ['whoami-go', '最近被拒的 key', '<th>指纹</th>', 'keys/whoami']) {
    assert.ok(html.includes(needle) || js.includes(needle), `看板缺少鉴权自检要素: ${needle}`);
  }
});

test('客户端 key 是空串：必须给告警，不能静默注册一个永远用不了的 key', () => {
  const config = memoryConfig({
    clients: [{ id: 'dead', label: 'dead', key: '', tier: 'pro', tenantId: 't', enabled: true } as never],
  });
  const issues = inspectConfig(config);
  assert.ok(
    issues.some((i) => i.level === 'warn' && /空串/.test(i.message) && /dead/.test(i.message)),
    `空 key 必须被指出来，实际: ${JSON.stringify(issues.map((i) => `${i.level}:${i.message}`))}`,
  );
});


/* ------------------------------------------------------------------ *
 * 5. 按「钱」计的额度（quotaCny）
 *
 * token 额度表达不了"就给他 ¥10 预算"：输入 ¥3/M、输出 ¥6/M，
 * 同样 ¥10 折成 token 数完全取决于输入输出比例，只能猜。
 * 客户对得上账的口径是按钱算 —— 所以钱必须按钱判断。
 * ------------------------------------------------------------------ */

test('预算用尽必须按钱拦住，且返回 402 而不是 429（别让客户端无效重试）', async () => {
  const { registry, store } = makeRegistry([{ id: 'budget', key: 'sk-relay-budget', tier: 'pro', quotaCny: 10 }]);
  // 先记一笔 ¥3 的花费（未超预算）
  store.record(mkRecord({ keyId: 'budget', tenantId: 't1', tier: 'pro' as TierId, outcome: 'success', httpStatus: 200, costCny: 3, model: 'mimo-v2.5-pro', providerId: 'mimo' }));
  const ok = await registry.authenticate({ authorization: 'Bearer sk-relay-budget' });
  assert.equal(ok.ok, true, '未超预算应放行');

  // 再记一笔，累计 ¥12 > ¥10
  store.record(mkRecord({ keyId: 'budget', tenantId: 't1', tier: 'pro' as TierId, outcome: 'success', httpStatus: 200, costCny: 9, model: 'mimo-v2.5-pro', providerId: 'mimo' }));
  const blocked = await registry.authenticate({ authorization: 'Bearer sk-relay-budget' });
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.error.code, 'quota_exhausted');
  assert.match(blocked.error.message, /预算已用尽/);
  assert.match(blocked.error.message, /¥12/, '文案里要能看出实际花了多少');
});

test('预算与 token 额度互不干扰：只设预算时不能因为 token 数小而提前拦', async () => {
  const { registry, store } = makeRegistry([{ id: 'b2', key: 'sk-relay-b2', tier: 'pro', quotaCny: 1 }]);
  // 花了很多 token，但都是缓存命中（¥0.025/M），钱没超
  store.record(mkRecord({ keyId: 'b2', tenantId: 't1', tier: 'pro' as TierId, outcome: 'success', httpStatus: 200, totalTokens: 5_000_000, costCny: 0.1 }));
  const r = await registry.authenticate({ authorization: 'Bearer sk-relay-b2' });
  assert.equal(r.ok, true, '钱没超就不该拦，哪怕 token 很多');
});

test('额度用量口径同时给出 token 与金额两种进度', () => {
  const { registry, store } = makeRegistry([{ id: 'b3', key: 'sk-relay-b3', tier: 'pro', quotaCny: 10 }]);
  store.record(mkRecord({ keyId: 'b3', tenantId: 't1', tier: 'pro' as TierId, outcome: 'success', httpStatus: 200, totalTokens: 1000, costCny: 2.5 }));
  const u = registry.usageForKey('b3');
  assert.equal(u.quotaCny, 10);
  assert.equal(u.costCny, 2.5);
  assert.equal(u.quotaCnyUsedPct, 0.25);
});

test('预算必须落库：进程重启后 ¥10 额度还在（老库缺列时靠迁移补上）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-quotacny-'));
  const dbPath = join(dir, 'relay.db');
  try {
    const s1 = new SqliteStore({ path: dbPath, flushIntervalMs: 10, batchSize: 1, logger: silent });
    await s1.init();
    s1.upsertKeyMeta({
      keyId: 'k_budget',
      label: '预算 key',
      tier: 'pro' as TierId,
      tenantId: 't1',
      enabled: true,
      keyHash: 'x'.repeat(64),
      origin: 'panel',
      costQuotaOverride: 10,
    });
    await s1.close();

    // 第二个"进程"：从库里读回来
    const s2 = new SqliteStore({ path: dbPath, flushIntervalMs: 10, batchSize: 1, logger: silent });
    await s2.init();
    try {
      const meta = s2.listKeyMeta().find((m) => m.keyId === 'k_budget');
      assert.ok(meta, '重启后应能读回这条 key 元数据');
      assert.equal(meta!.costQuotaOverride, 10, '¥ 额度必须跨重启保留');
    } finally {
      await s2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 6. 看板自己不能自相矛盾（由一次"让模型看图评审面板"暴露出来）
 * ------------------------------------------------------------------ */

test('时序分桶必须真的按 bucketMs 聚合，不能退化成"每条记录一个桶"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-series-'));
  const dbPath = join(dir, 'relay.db');
  try {
    const s = new SqliteStore({ path: dbPath, flushIntervalMs: 10, batchSize: 1, logger: silent });
    await s.init();
    try {
      // 同一小时内的 5 条记录 + 上一小时的 2 条
      const hour = 3_600_000;
      const base = Math.floor(Date.now() / hour) * hour;
      for (let i = 0; i < 5; i++) s.record(mkRecord({ ts: base + i * 1000, outcome: 'success', httpStatus: 200 }));
      for (let i = 0; i < 2; i++) s.record(mkRecord({ ts: base - hour + i * 1000, outcome: 'success', httpStatus: 200 }));
      await s.flush();
      const points = s.series(Date.now() - 24 * hour, hour);
      assert.equal(points.length, 2, `应聚成 2 个小时桶，实际 ${points.length} 个（退化成每条一桶了？）`);
      for (const p of points) {
        assert.equal(p.ts % hour, 0, `桶的起点必须对齐到小时，实际 ${new Date(p.ts).toISOString()}`);
      }
      const total = points.reduce((n, p) => n + p.requests, 0);
      assert.equal(total, 7, '聚合不能丢记录');
      assert.deepEqual(points.map((p) => p.requests).sort(), [2, 5]);
    } finally {
      await s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('降损层开销比必须是同口径平均值之比，不能因为样本数错配而爆表', () => {
  const store = new MemoryStore();
  const meter = new Meter({ store, enabled: true, hashPayloads: true });
  // 20 条请求，每条耗时 1000ms、开销 200µs → 开销占比应约 0.02%
  for (let i = 0; i < 20; i++) {
    store.record(mkRecord({ outcome: 'success', httpStatus: 200, durationMs: 1000, precheckUs: 200, classifyUs: 0, totalTokens: 10 }));
  }
  const s = meter.summarize(3_600_000);
  const got = s.lossReduction.overheadRatio;
  // 200µs / 1000ms = 0.0002；允许一点舍入误差
  assert.ok(got > 0.0001 && got < 0.0004, `开销比应约 0.0002（0.02%），实际 ${got}`);
});

/* ------------------------------------------------------------------ *
 * 7. "模型名写错了" 不能说成 "你的 key 没开通"
 *
 * 真实反馈：用户把 agnes 写成 agens，网关回的是
 *   "当前 key（Pro 层）未开通模型 agens"
 * 这会把人送去开通/升级，而真正要做的只是改个名字。
 * ------------------------------------------------------------------ */

test('模型名不存在 → 404 model_not_found，并给出拼写建议与可用清单', async () => {
  const { registry } = makeRegistry([{ id: 'ag', key: 'sk-relay-ag', tier: 'pro' }], { models: ['agnes-3.0-flash', 'agnes-2.5-flash'] });
  // 让这个 key 只认 Agnes 那几个型号
  registry.update('ag', { allowedModels: ['agnes-3.0-flash', 'agnes-2.5-flash', 'flagship'] });

  const out = await registry.authenticate({ authorization: 'Bearer sk-relay-ag', model: 'agens' });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.code, 'model_not_found', '拼错的名字必须是"不存在"，不是"没开通"');
  assert.match(out.error.message, /不在本网关的模型清单里/);
  assert.ok('suggestion' in out.error && out.error.suggestion === 'agnes-3.0-flash', '应建议最接近的真名');
  assert.deepEqual('allowed' in out.error ? out.error.allowed : [], ['agnes-3.0-flash', 'agnes-2.5-flash', 'flagship']);
});

test('模型存在但白名单没有 → 403 model_not_allowed（与"不存在"分开）', async () => {
  const { registry } = makeRegistry([{ id: 'ag2', key: 'sk-relay-ag2', tier: 'pro' }], { ladders: { flagship: ['agnes-3.0-flash', 'agnes-2.5-flash'] } });
  registry.update('ag2', { allowedModels: ['agnes-3.0-flash'] });
  const out = await registry.authenticate({ authorization: 'Bearer sk-relay-ag2', model: 'flagship' });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.code, 'model_not_allowed');
  assert.match(out.error.message, /该模型存在/);
});

test('拼写建议：太不像就不猜（宁可不建议，也别给更误导的）', async () => {
  const { nearestModel } = await import('../gateway/keys.js');
  const cands = ['agnes-3.0-flash', 'agnes-2.5-flash', 'flagship', 'balanced'];
  assert.equal(nearestModel('agens', cands), 'agnes-3.0-flash');
  assert.equal(nearestModel('agnes3', cands), 'agnes-3.0-flash');
  assert.equal(nearestModel('flagship', cands), 'flagship');
  assert.equal(nearestModel('completely-different-model-xyz', cands), undefined);
});

/* ------------------------------------------------------------------ *
 * 额度快照必须按**精确时间**聚合（生产走 SQLite 那条路）
 * 2026-09-14 交叉审计：老实现按 UTC 天分桶，导致「重置额度」静默失效
 * ------------------------------------------------------------------ */

test('额度快照按精确时间聚合：月中重置后不能再算上重置前的用量', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-quota-'));
  try {
    const sql = new SqliteStore({ path: join(dir, 'relay.db'), flushIntervalMs: 10, batchSize: 1, logger: silent });
    await sql.init();
    try {
      const now = Date.now();
      // 同一天里：3 小时前 1000 token / ¥5，1 分钟前 7 token / ¥0.1
      sql.record(mkRecord({ ts: now - 3 * 3_600_000, keyId: 'kq', totalTokens: 1000, costCny: 5, outcome: 'success' }));
      sql.record(mkRecord({ ts: now - 60_000, keyId: 'kq', totalTokens: 7, costCny: 0.1, outcome: 'success' }));
      await sql.flush();

      // 模拟"刚按了重置额度"：窗口起点 = 1 小时前（落在同一天的**中间**）
      const used = sql.quotaSnapshot('kq', now - 3_600_000);
      assert.equal(used.tokens, 7, '必须按精确 ts 过滤：同一天 3 小时前那 1000 算进来 = 重置额度没生效');
      assert.equal(used.requests, 1);
      assert.ok(Math.abs(used.costCny - 0.1) < 1e-9, '钱的口径同样要按精确时间');

      // 全窗口仍然两条都在
      assert.equal(sql.quotaSnapshot('kq', now - 7 * 86_400_000).tokens, 1007);

      // 5 秒桶缓存不能把不同窗口混起来（窗口变了必须重新算）
      assert.equal(sql.quotaSnapshot('kq', now - 30 * 60_000).tokens, 7);
      assert.equal(sql.quotaSnapshot('kq', now - 4 * 3_600_000).tokens, 1007);
    } finally {
      await sql.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('额度快照不能因为「库还没 flush」而返回 0（缓存必须存解析后的值）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-quota-cache-'));
  try {
    // batchSize 拉大 + flush 间隔拉长：模拟"记录还在内存里、库里是空的"那个窗口
    const sql = new SqliteStore({ path: join(dir, 'relay.db'), flushIntervalMs: 60_000, batchSize: 1_000, logger: silent });
    await sql.init();
    try {
      const now = Date.now();
      sql.record(mkRecord({ ts: now - 1000, keyId: 'kc', totalTokens: 1000, costCny: 10, outcome: 'success' }));
      // 还没 flush：连续三次调用都必须看到那 1000
      // （老实现第一次走内存兜底给对的，但把库的 0 写进了缓存 → 后两次变 0 → 闸门失明）
      for (let i = 0; i < 3; i++) {
        const used = sql.quotaSnapshot('kc', now - 3_600_000);
        assert.equal(used.tokens, 1000, `第 ${i + 1} 次调用就必须看到未落盘的那条记录`);
        assert.equal(used.requests, 1);
      }
      await sql.flush();
      assert.equal(sql.quotaSnapshot('kc', now - 3_600_000).tokens, 1000);
    } finally {
      await sql.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flush 失败不能丢账：记录必须重新入队等下次重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-flush-'));
  try {
    // batchSize 拉大：让记录**留在缓冲里**（batchSize=1 会在 record() 时立刻 flush 掉，
    // 那样关库前账已经落了，就测不到失败路径了）
    const sql = new SqliteStore({ path: join(dir, 'relay.db'), flushIntervalMs: 60_000, batchSize: 100, logger: silent });
    await sql.init();
    try {
      sql.record(mkRecord({ keyId: 'kf', totalTokens: 100, outcome: 'success' }));
      sql.record(mkRecord({ keyId: 'kf', totalTokens: 200, outcome: 'success' }));
      // 把底层库关掉，让下一次 flush 必然失败（prepare 抛错）
      (sql as unknown as { db: { close(): void } | undefined }).db?.close();
      await sql.flush();

      // 老实现：catch 里 ROLLBACK 完就结束 → 本批被丢弃（审计 C-4 实测 5 条凭空消失，
      // 额度没扣 = 客户白用）。现在必须留在缓冲里等重试。
      const buf = (sql as unknown as { buffer: unknown[] }).buffer;
      assert.equal(buf.length, 2, `flush 失败后记录应留在缓冲里等待重试，实际剩 ${buf.length}`);
      const state = (sql as unknown as { health(): { degradedEvents: number } }).health();
      assert.ok(state.degradedEvents >= 1, 'degraded 要立证据');
    } finally {
      await sql.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
