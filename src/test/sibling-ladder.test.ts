/**
 * 精确模型名的阶梯补齐（siblingModelFallback）回归测试。
 *
 * 背景（2026-10-02 实测）：
 *   resolveLadder 原本只认「阶梯名」，客户直接点名某个具体模型时阶梯退化成单阶
 *   [该模型]，于是 maxAttempts = 1 × (1+autoRetry) = 2 —— 只剩两次**横向**尝试
 *   （换供应商），竖向换模型的兜底一步都走不了。
 *
 *   实测 customer 点名 agnes-2.0-flash（Agnes 免费档限流极低）：
 *     agnes-cn 429 → autoRetry 重试到 agnes → 也 429 → 429 原样丢回客户端。
 *   而同厂商 agnes-2.5-flash / agnes-3.0-flash 当时完全正常，且运营已在
 *   modelLadders 把这三者声明为同属「极速」档可互换。DB 里 09-14 有真实客户
 *   30 秒内连吃 3 个 429。横向兜底其实是生效的，只是两个 Agnes 节点同属一个
 *   免费档、会同时被限流，此时唯一的活路就是竖向换模型。
 *
 * 这里的每一条断言都是可反驳的：既锁住「该换的时候必须换」，也锁住
 * 「不该换的时候不许换」——补齐规则必须保守到不擅自替换客户点名的模型。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, memoryConfig, type App } from '../app.js';
import { MockUpstream } from '../mock/upstream.js';
import { Logger } from '../core/logger.js';
import type { RelayConfig, ProviderConfig } from '../core/types.js';

const silent = new Logger('error', () => undefined);

interface Harness {
  app: App;
  mock: MockUpstream;
  close: () => Promise<void>;
}

async function harness(opts: {
  providers: (mockUrl: string) => ProviderConfig[];
  ladders?: Record<string, string[]>;
  siblingModelFallback?: boolean;
  breakerThreshold?: number;
}): Promise<Harness> {
  const mock = new MockUpstream({ port: 0, logger: silent });
  const bound = await mock.listen();
  const config = memoryConfig({
    providers: opts.providers(bound.url),
    clients: [
      { id: 'pro-key', label: 'pro', key: 'sk-pro-test', tier: 'pro', tenantId: 't', enabled: true },
    ],
    logLevel: 'error',
  });
  if (opts.ladders) config.modelLadders = opts.ladders;
  // 退避压到毫秒级，避免测试真的去睡 300ms+
  config.lossReduction.attribution.backoffBaseMs = 5;
  config.lossReduction.attribution.backoffMaxMs = 20;
  if (opts.siblingModelFallback !== undefined) config.lossReduction.attribution.siblingModelFallback = opts.siblingModelFallback;
  if (opts.breakerThreshold !== undefined) config.lossReduction.attribution.breakerThreshold = opts.breakerThreshold;
  const app = await createApp(config, silent);
  return { app, mock, close: async () => { await app.shutdown(); await mock.close(); } };
}

let seq = 0;
async function call(app: App, model: string): Promise<{ status: number; json: any; text: string }> {
  const raw = Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: '你好' }] }), 'utf8');
  const result = await app.engine.handle({
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { authorization: 'Bearer sk-pro-test', 'content-type': 'application/json' },
    rawBody: new Uint8Array(raw),
    signal: new AbortController().signal,
    requestId: `req_sl${++seq}`,
  });
  if (result.kind === 'json') {
    let json: unknown;
    try { json = JSON.parse(result.body); } catch { json = undefined; }
    return { status: result.status, json, text: result.body };
  }
  throw new Error('期望非流式结果');
}

/** 两个同模型上游：模拟「同一免费档的两个节点会同时被限流」 */
function twoNodes(mockUrl: string): ProviderConfig[] {
  return [
    { id: 'p1', label: '节点一', protocol: 'openai', baseUrl: mockUrl, apiKey: 'k', models: ['m-fast', 'm-slow'], priority: 10 },
    { id: 'p2', label: '节点二', protocol: 'openai', baseUrl: mockUrl, apiKey: 'k', models: ['m-fast', 'm-slow'], priority: 5 },
  ];
}

const LADDERS: Record<string, string[]> = { 'tier-fast': ['m-fast', 'm-slow'] };

test('点名模型被限流：横向换供应商耗尽后，沿阶梯竖向换模型而不是丢 429 回客户端', async () => {
  const h = await harness({ providers: twoNodes, ladders: LADDERS });
  try {
    // m-fast 两个节点都 429；m-slow 健康
    h.mock.queueScenarios('m-fast', [
      { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' } } },
      { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' } } },
    ]);
    h.mock.queueScenarios('m-slow', [{ status: 200 }]);

    const r = await call(h.app, 'm-fast');
    assert.equal(r.status, 200, `期望竖向换模型后成功，实际: ${r.text}`);

    // 横向兜底确实先跑过：点名模型试满 autoRetry 的两次
    assert.equal(h.mock.attemptCount('m-fast'), 2, '点名模型应先试满横向兜底的两次');
    assert.equal(h.mock.attemptCount('m-slow'), 1, '横向耗尽后才允许竖向换模型');

    // 顺序锁死：先两次点名模型，最后才是同档后继
    const order = h.mock.received.map((x) => x.model);
    assert.deepEqual(order, ['m-fast', 'm-fast', 'm-slow'], `模型尝试顺序不对: ${order.join(' → ')}`);
  } finally {
    await h.close();
  }
});

test('客户点名的模型永远是第一阶：健康时绝不擅自替换成同档其他模型', async () => {
  const h = await harness({ providers: twoNodes, ladders: LADDERS });
  try {
    h.mock.queueScenarios('m-fast', [{ status: 200 }]);
    h.mock.queueScenarios('m-slow', [{ status: 200 }]);

    const r = await call(h.app, 'm-fast');
    assert.equal(r.status, 200);
    assert.equal(h.mock.attemptCount('m-fast'), 1);
    assert.equal(h.mock.attemptCount('m-slow'), 0, '点名模型健康时不允许替换成同档后继');
    assert.deepEqual(h.mock.received.map((x) => x.model), ['m-fast']);
  } finally {
    await h.close();
  }
});

test('开关关闭：退回单阶阶梯，429 原样丢回客户端（证明修复可逆）', async () => {
  const h = await harness({ providers: twoNodes, ladders: LADDERS, siblingModelFallback: false });
  try {
    h.mock.queueScenarios('m-fast', [
      { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' } } },
      { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' } } },
    ]);
    h.mock.queueScenarios('m-slow', [{ status: 200 }]);

    const r = await call(h.app, 'm-fast');
    assert.equal(r.status, 429, '关掉开关后必须退回修复前的行为');
    assert.equal(h.mock.attemptCount('m-slow'), 0, '单阶阶梯下不允许竖向换模型');
    assert.equal(h.mock.attemptCount('m-fast'), 2, '只剩横向兜底的两次尝试');
  } finally {
    await h.close();
  }
});

test('只追加排在其后的同档模型：flash 不会被换成排序更靠前的 pro', async () => {
  const h = await harness({
    providers: (url) => [
      { id: 'p1', label: '一', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['m-pro', 'm-flash', 'm-cheap'], priority: 10 },
      { id: 'p2', label: '二', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['m-pro', 'm-flash', 'm-cheap'], priority: 5 },
    ],
    ladders: { 'tier': ['m-pro', 'm-flash', 'm-cheap'] },
  });
  try {
    // 客户点名 m-flash（阶梯里排第 2）→ 只许往后找 m-cheap，不许回头看 m-pro
    h.mock.queueScenarios('m-flash', [
      { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' } } },
      { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' } } },
    ]);
    h.mock.queueScenarios('m-pro', [{ status: 200 }]);
    h.mock.queueScenarios('m-cheap', [{ status: 200 }]);

    const r = await call(h.app, 'm-flash');
    assert.equal(r.status, 200, `期望换到 m-cheap，实际: ${r.text}`);
    assert.equal(h.mock.attemptCount('m-pro'), 0, '绝不允许把客户点名的 flash 换成排序更前的 pro');
    assert.equal(h.mock.attemptCount('m-cheap'), 1);
    assert.deepEqual(h.mock.received.map((x) => x.model), ['m-flash', 'm-flash', 'm-cheap']);
  } finally {
    await h.close();
  }
});

test('未被任何阶梯声明的模型不擅自替换（运营没标等价关系就不猜）', async () => {
  const h = await harness({
    providers: (url) => [
      { id: 'p1', label: '一', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['m-orphan', 'm-slow'], priority: 10 },
      { id: 'p2', label: '二', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['m-orphan', 'm-slow'], priority: 5 },
    ],
    ladders: LADDERS, // 阶梯里只有 m-fast/m-slow，没有 m-orphan
  });
  try {
    h.mock.queueScenarios('m-orphan', [
      { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' } } },
      { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' } } },
    ]);
    h.mock.queueScenarios('m-slow', [{ status: 200 }]);

    const r = await call(h.app, 'm-orphan');
    assert.equal(r.status, 429, '没被阶梯声明过的模型必须原样返回失败');
    assert.equal(h.mock.attemptCount('m-slow'), 0, '不允许把没声明等价关系的模型换掉');
  } finally {
    await h.close();
  }
});

test('阶梯名请求的行为不变（修复只影响点名具体模型的场景）', async () => {
  const h = await harness({ providers: twoNodes, ladders: LADDERS });
  try {
    h.mock.queueScenarios('m-fast', [
      { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' } } },
      { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' } } },
    ]);
    h.mock.queueScenarios('m-slow', [{ status: 200 }]);

    const r = await call(h.app, 'tier-fast');
    assert.equal(r.status, 200, '阶梯名请求原本就有竖向兜底，必须保持');
    assert.deepEqual(h.mock.received.map((x) => x.model), ['m-fast', 'm-fast', 'm-slow']);
  } finally {
    await h.close();
  }
});

test('同厂姊妹优先：跨厂商兜底只排在同厂全限流之后', async () => {
  // 复刻真实配置的形状：agnes-2.0-flash 同时出现在三个阶梯里，
  // 其中「旗舰」（键序最前）的第 4 阶是跨厂商的 mimo-v2.6-flash。
  const h = await harness({
    providers: (url) => [
      { id: 'agnes', label: 'Agnes 国际', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['agnes-2.0-flash', 'agnes-2.5-flash', 'agnes-3.0-flash', 'mimo-v2.6-flash'], priority: 10 },
      { id: 'agnes-cn', label: 'Agnes 国内', protocol: 'openai', baseUrl: url, apiKey: 'k', models: ['agnes-2.0-flash', 'agnes-2.5-flash', 'agnes-3.0-flash', 'mimo-v2.6-flash'], priority: 5 },
    ],
    ladders: {
      '旗舰': ['agnes-3.0-flash', 'agnes-2.5-flash', 'agnes-2.0-flash', 'mimo-v2.6-flash'],
      '平衡': ['agnes-2.5-flash', 'agnes-2.0-flash', 'agnes-3.0-flash'],
      '极速': ['agnes-2.0-flash', 'agnes-2.5-flash', 'agnes-3.0-flash'],
    },
    // 本用例故意让前三阶全 429（共 6 次失败），用默认阈值 3 会正确地把两个上游
    // 熔断、第 4 阶直接 NoRoute——那测的是熔断而不是顺序。调高阈值才能观察到
    // 「同厂姊妹先试穿、跨厂商兜底排最后」这个顺序本身。
    breakerThreshold: 100,
  });
  try {
    const limited = { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' } } };
    h.mock.queueScenarios('agnes-2.0-flash', [limited, limited]);
    h.mock.queueScenarios('agnes-2.5-flash', [limited, limited]);
    h.mock.queueScenarios('agnes-3.0-flash', [limited, limited]);
    h.mock.queueScenarios('mimo-v2.6-flash', [{ status: 200 }]);

    const r = await call(h.app, 'agnes-2.0-flash');
    assert.equal(r.status, 200, `期望最终落到 mimo 兜底，实际: ${r.text}`);

    const order = h.mock.received.map((x) => x.model);
    // 同厂两个姊妹必须先被试穿，才允许跨厂商
    const firstMimo = order.indexOf('mimo-v2.6-flash');
    assert.ok(firstMimo > 0, `应该最终落到跨厂商兜底: ${order.join(' → ')}`);
    const lastAgnes = Math.max(order.lastIndexOf('agnes-2.5-flash'), order.lastIndexOf('agnes-3.0-flash'));
    assert.ok(lastAgnes < firstMimo, `同厂姊妹必须排在跨厂商兜底之前: ${order.join(' → ')}`);
    // 横向耗尽后的第一个替代品必须是同厂姊妹（不能一上来就跨厂商替换）
    assert.equal(order[2], 'agnes-3.0-flash', `第一个替代品应是同厂姊妹，实际: ${order[2]}`);
    // 完整顺序：点名模型两次 → 同厂 3.0 → 同厂 2.5 → 最后才跨厂商
    assert.deepEqual(
      order,
      ['agnes-2.0-flash', 'agnes-2.0-flash', 'agnes-3.0-flash', 'agnes-3.0-flash', 'agnes-2.5-flash', 'agnes-2.5-flash', 'mimo-v2.6-flash'],
      `模型尝试顺序不对: ${order.join(' → ')}`,
    );
  } finally {
    await h.close();
  }
});
