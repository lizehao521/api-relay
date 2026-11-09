/**
 * 扫码次数包业务测试。
 *
 * 守的边界：
 *   1. 商家闭环：下单 → 支付 → 出码 → 扫码 → 扣次 → 用尽（HTTP 全链路，真引擎/真 mock 上游）；
 *   2. 失败不计次：上游 5xx 不扣次数，随后成功才扣；
 *   3. 码状态：撤销 / 过期 / 不存在 / 会话篡改；
 *   4. 支付宝适配器：预下单签名可被验过、通知验签、金额不符、重复通知幂等。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, memoryConfig, type App } from '../app.js';
import { MockUpstream } from '../mock/upstream.js';
import { Logger } from '../core/logger.js';
import type { BusinessConfig, BusinessPaymentConfig, PackConfig, ProviderConfig } from '../core/types.js';
import { SqliteBizStore, type BizOrder } from '../biz/store.js';
import { normalizeCode } from '../biz/codes.js';
import { qrMatrix, qrSvg } from '../biz/qr.js';
import { rsa2Sign, rsa2Verify, signContent } from '../biz/payment.js';
import { rmTmp } from './testcleanup.js';

const silent = new Logger('error', () => undefined);
const ADMIN = 'biz-admin-token';

const TEST_PACKS: PackConfig[] = [
  { id: 'chat-3', name: '对话 3 次', uses: 3, priceCny: 3, models: ['mock-small'], validDays: 30 },
  { id: 'chat-1', name: '对话 1 次', uses: 1, priceCny: 1, models: ['mock-small'], validDays: 30 },
  { id: 'image-2', name: '画图 2 张', uses: 2, priceCny: 2, models: ['mock-image'], validDays: 30 },
  { id: 'chat-expire', name: '马上过期', uses: 2, priceCny: 2, models: ['mock-small'], validDays: 0.000001 },
  { id: 'slip-2', name: '外卖单码 2 次', uses: 2, priceCny: 0.2, models: ['mock-small'], validDays: 30 },
];

interface Harness {
  app: App;
  mock: MockUpstream;
  base: string;
  close: () => Promise<void>;
}

async function harness(opts: { autoRetry?: number; payment?: BusinessPaymentConfig; packs?: PackConfig[] } = {}): Promise<Harness> {
  const mock = new MockUpstream({ port: 0, logger: silent });
  const mockBound = await mock.listen();
  const providers: ProviderConfig[] = [
    {
      id: 'mock',
      label: 'mock 上游',
      protocol: 'openai',
      baseUrl: mockBound.url,
      apiKey: 'mock-key',
      models: ['mock-small', 'mock-image'],
      priority: 10,
      modelCosts: {
        'mock-image': { inputPerMTok: 0, outputPerMTok: 0, perImageCny: 0.1 },
      },
    },
  ];
  const business: BusinessConfig = {
    enabled: true,
    merchantName: '默认测试商家',
    sessionTtlHours: 12,
    costCapRatio: 0.9,
    packs: opts.packs ?? TEST_PACKS,
    payments: opts.payment ?? { provider: 'mock' },
  };
  const config = memoryConfig({ providers, business, logLevel: 'error' });
  config.server.adminToken = ADMIN;
  if (opts.autoRetry !== undefined) config.lossReduction.attribution.autoRetry = opts.autoRetry;
  const app = await createApp(config, silent);
  const bound = await app.start();
  return {
    app,
    mock,
    base: bound.url,
    close: async () => {
      await app.shutdown();
      await mock.close();
    },
  };
}

interface ReqOpts {
  method?: string;
  token?: string | null;
  cookie?: string;
  body?: unknown;
}

interface Res {
  status: number;
  text: string;
  json: any;
  cookie?: string;
  contentType: string | null;
}

async function api(h: Harness, path: string, opts: ReqOpts = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? ADMIN : opts.token;
  if (token) headers['x-admin-token'] = token;
  if (opts.cookie) headers['cookie'] = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${h.base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const setCookie = res.headers.get('set-cookie');
  return {
    status: res.status,
    text,
    json,
    ...(setCookie ? { cookie: setCookie.split(';')[0] ?? '' } : {}),
    contentType: res.headers.get('content-type'),
  };
}

async function buy(h: Harness, packId: string, quantity = 1, merchantName = '测试商家'): Promise<{ order: any; payment: any; token: string }> {
  const r = await api(h, '/biz/api/orders', { method: 'POST', body: { packId, quantity, merchantName } });
  assert.equal(r.status, 200, r.text);
  const payment = r.json.payment as { kind: string; payUrl: string };
  const token = payment.kind === 'redirect' ? new URL(payment.payUrl, h.base).searchParams.get('t') ?? '' : '';
  return { order: r.json.order, payment, token };
}

async function payMock(h: Harness, orderId: string, token: string): Promise<any> {
  const r = await api(h, `/biz/api/orders/${orderId}/mock-pay`, { method: 'POST', token: null, body: { t: token } });
  assert.equal(r.status, 200, r.text);
  return r.json.order;
}

async function openSession(h: Harness, code: string): Promise<Res & { cookie: string }> {
  const r = await api(h, '/biz/api/session', { method: 'POST', token: null, body: { code } });
  return r as Res & { cookie: string };
}

async function createMerchant(h: Harness, name: string): Promise<{ id: string; token: string; consolePath: string }> {
  const r = await api(h, '/biz/api/merchants', { method: 'POST', body: { name } });
  assert.equal(r.status, 200, r.text);
  return { id: r.json.merchant.id as string, token: r.json.token as string, consolePath: r.json.consolePath as string };
}

/* ------------------------------------------------------------------ *
 * 1. 完整闭环
 * ------------------------------------------------------------------ */

test('biz: 下单 → mock 支付 → 出码 → 扫码 → 对话扣次 → 用尽（HTTP 全链路）', async () => {
  const h = await harness();
  try {
    const { order, payment, token } = await buy(h, 'chat-3', 2, '一号店');
    assert.equal(order.status, 'pending');
    assert.equal(order.amountCny, 6);
    assert.equal(payment.kind, 'redirect');
    assert.match(payment.payUrl, /^\/pay\/ord_/);

    const checkout = await api(h, payment.payUrl);
    assert.equal(checkout.status, 200);
    assert.match(checkout.text, /演示收银台/);

    const paid = await payMock(h, order.id, token);
    assert.equal(paid.status, 'paid');
    assert.equal(paid.codes.length, 2);
    assert.equal(paid.codes[0].usesTotal, 3);

    // 重复支付通知幂等：不会多出码
    const again = await api(h, `/biz/api/orders/${order.id}/mock-pay`, { method: 'POST', token: null, body: { t: token } });
    assert.equal(again.status, 200);
    assert.equal(again.json.order.codes.length, 2);

    const code: string = paid.codes[0].code;
    const qr = await fetch(`${h.base}/biz/qr/${encodeURIComponent(code)}.svg`);
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type') ?? '', /image\/svg\+xml/);
    assert.match(await qr.text(), /<svg[\s\S]*<path/);

    const s1 = await openSession(h, code);
    assert.equal(s1.status, 200, s1.text);
    assert.ok(s1.cookie.startsWith('biz_sid='), '必须种签名会话 Cookie');
    assert.equal(s1.json.merchantName, '一号店');
    assert.equal(s1.json.remaining, 3);
    assert.deepEqual(s1.json.models, ['mock-small']);

    // 流式对话
    const chat1 = await api(h, '/biz/api/chat', {
      method: 'POST',
      token: null,
      cookie: s1.cookie,
      body: { messages: [{ role: 'user', content: '你好' }], stream: true },
    });
    assert.equal(chat1.status, 200, chat1.text);
    assert.match(chat1.text, /data:/);
    assert.match(chat1.text, /mock 上游/);
    let me = await api(h, '/biz/api/me', { token: null, cookie: s1.cookie });
    assert.equal(me.json.remaining, 2);

    // 非流式对话
    const chat2 = await api(h, '/biz/api/chat', {
      method: 'POST',
      token: null,
      cookie: s1.cookie,
      body: { model: 'mock-small', messages: [{ role: 'user', content: '再来一次' }] },
    });
    assert.equal(chat2.status, 200, chat2.text);
    me = await api(h, '/biz/api/me', { token: null, cookie: s1.cookie });
    assert.equal(me.json.remaining, 1);

    await api(h, '/biz/api/chat', {
      method: 'POST',
      token: null,
      cookie: s1.cookie,
      body: { messages: [{ role: 'user', content: '第三次' }] },
    });
    me = await api(h, '/biz/api/me', { token: null, cookie: s1.cookie });
    assert.equal(me.json.remaining, 0);

    const fourth = await api(h, '/biz/api/chat', {
      method: 'POST',
      token: null,
      cookie: s1.cookie,
      body: { messages: [{ role: 'user', content: '第四次' }] },
    });
    assert.equal(fourth.status, 402);
    assert.match(fourth.json.error.message, /次数已用完/);

    const chatCalls = h.mock.received.filter((r) => r.path.endsWith('/chat/completions')).length;
    assert.equal(chatCalls, 3, '用完后的调用不能打到上游');

    // 续购：另一张码仍完整
    const s2 = await openSession(h, paid.codes[1].code);
    assert.equal(s2.status, 200);
    assert.equal(s2.json.remaining, 3);

    const summary = await api(h, '/biz/api/summary');
    assert.equal(summary.json.revenueCny, 6);
    assert.equal(summary.json.paidOrderCount, 1);
    assert.equal(summary.json.usesUsed, 3);
    assert.equal(summary.json.usesSold, 6);
    assert.equal(summary.json.activeCodeCount, 1);

    const orders = await api(h, '/biz/api/orders');
    assert.equal(orders.json.orders[0].id, order.id);
    assert.equal(orders.json.orders[0].codes.length, 2);

    // 管理员接口无令牌必须 401
    const noToken = await api(h, '/biz/api/orders', { token: null });
    assert.equal(noToken.status, 401);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * 2. 失败不计次
 * ------------------------------------------------------------------ */

test('biz: 上游失败不计次，预留在同一次请求里回滚', async () => {
  const h = await harness({ autoRetry: 0 });
  try {
    const { order, token } = await buy(h, 'chat-1');
    const paid = await payMock(h, order.id, token);
    const s = await openSession(h, paid.codes[0].code);

    h.mock.setForcedScenario({ status: 500, body: { error: { message: 'boom' } } });
    const failed = await api(h, '/biz/api/chat', {
      method: 'POST',
      token: null,
      cookie: s.cookie,
      body: { messages: [{ role: 'user', content: '这次应该失败' }] },
    });
    assert.ok(failed.status >= 500, `期望上游失败，实际 ${failed.status}`);
    const me1 = await api(h, '/biz/api/me', { token: null, cookie: s.cookie });
    assert.equal(me1.json.remaining, 1, '失败不计次');

    h.mock.setForcedScenario(undefined);
    const ok = await api(h, '/biz/api/chat', {
      method: 'POST',
      token: null,
      cookie: s.cookie,
      body: { messages: [{ role: 'user', content: '这次成功' }] },
    });
    assert.equal(ok.status, 200, ok.text);
    const me2 = await api(h, '/biz/api/me', { token: null, cookie: s.cookie });
    assert.equal(me2.json.remaining, 0, '成功才扣次');
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * 3. 码状态与会话
 * ------------------------------------------------------------------ */

test('biz: 撤销 / 过期 / 不存在 / 会话篡改 / 跨商家隔离', async () => {
  const h = await harness();
  try {
    const a = await buy(h, 'chat-3', 1, '甲店');
    const paidA = await payMock(h, a.order.id, a.token);
    const codeA: string = paidA.codes[0].code;

    const b = await buy(h, 'chat-3', 1, '乙店');
    const paidB = await payMock(h, b.order.id, b.token);
    const codeB: string = paidB.codes[0].code;
    assert.notEqual(codeA, codeB);

    const sA = await openSession(h, codeA);
    const sB = await openSession(h, codeB);
    assert.equal(sA.json.merchantName, '甲店');
    assert.equal(sB.json.merchantName, '乙店');

    // Cookie 篡改：签名对不上
    const tampered = `${sA.cookie.slice(0, -1)}${sA.cookie.endsWith('A') ? 'B' : 'A'}`;
    const bad = await api(h, '/biz/api/me', { token: null, cookie: tampered });
    assert.equal(bad.status, 401);

    // 撤销：新会话 410，旧会话调用也 410
    const revoke = await api(h, `/biz/api/codes/${encodeURIComponent(codeA)}/revoke`, { method: 'POST' });
    assert.equal(revoke.status, 200);
    assert.equal(revoke.json.ok, true);
    const revokedSession = await openSession(h, codeA);
    assert.equal(revokedSession.status, 410);
    assert.match(revokedSession.json.error.message, /撤销/);
    const revokedChat = await api(h, '/biz/api/chat', {
      method: 'POST',
      token: null,
      cookie: sA.cookie,
      body: { messages: [{ role: 'user', content: 'x' }] },
    });
    assert.equal(revokedChat.status, 410);

    // 格式 / 存在性
    const badFormat = await openSession(h, 'ABC');
    assert.equal(badFormat.status, 400);
    const missing = await openSession(h, 'AAAA-BBBB');
    assert.equal(missing.status, 410);

    // 过期：validDays 极小，支付后等它过期
    const e = await buy(h, 'chat-expire');
    const paidE = await payMock(h, e.order.id, e.token);
    await new Promise((r) => setTimeout(r, 150));
    const expired = await openSession(h, paidE.codes[0].code);
    assert.equal(expired.status, 410);
    assert.match(expired.json.error.message, /过期/);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * 4. 多商家邀请与数据隔离
 * ------------------------------------------------------------------ */

test('biz: 邀请商家后订单/码按商家隔离，停用与轮换令牌生效', async () => {
  const h = await harness();
  try {
    const a = await createMerchant(h, '甲店');
    const b = await createMerchant(h, '乙店');
    assert.match(a.token, /^mch_/);
    assert.match(a.consolePath, /^\/biz\?t=mch_/);
    assert.notEqual(a.token, b.token);

    // 商家令牌下单：服务端用商家名与归属，忽略请求体里的冒名
    const oa = await api(h, '/biz/api/orders', {
      method: 'POST',
      token: a.token,
      body: { packId: 'chat-3', quantity: 1, merchantName: '冒名店铺' },
    });
    assert.equal(oa.status, 200, oa.text);
    assert.equal(oa.json.order.merchantName, '甲店');
    assert.equal(oa.json.order.merchantId, a.id);

    const ob = await api(h, '/biz/api/orders', {
      method: 'POST',
      token: b.token,
      body: { packId: 'chat-3', quantity: 1 },
    });
    assert.equal(ob.status, 200, ob.text);
    assert.equal(ob.json.order.merchantName, '乙店');
    assert.equal(ob.json.order.merchantId, b.id);

    // 列表与汇总只算自己的
    const aOrders = await api(h, '/biz/api/orders', { token: a.token });
    assert.deepEqual(aOrders.json.orders.map((o: any) => o.id), [oa.json.order.id]);
    const bOrders = await api(h, '/biz/api/orders', { token: b.token });
    assert.deepEqual(bOrders.json.orders.map((o: any) => o.id), [ob.json.order.id]);

    // 乙不能看甲订单的码 / 支付链接 / 打印页
    const oid = oa.json.order.id as string;
    assert.equal((await api(h, `/biz/api/orders/${oid}/codes`, { token: b.token })).status, 404);
    assert.equal((await api(h, `/biz/api/orders/${oid}/pay-link`, { token: b.token })).status, 404);
    assert.equal((await api(h, `/biz/print/${oid}`, { token: b.token })).status, 404);

    // 甲支付后，乙不能撤销甲的码
    const payToken = new URL(oa.json.payment.payUrl, h.base).searchParams.get('t') ?? '';
    const paid = await payMock(h, oid, payToken);
    assert.equal(paid.codes.length, 1);
    const code = paid.codes[0].code as string;
    assert.equal(
      (await api(h, `/biz/api/codes/${encodeURIComponent(code)}/revoke`, { method: 'POST', token: b.token })).status,
      404,
    );
    assert.equal(
      (await api(h, `/biz/api/codes/${encodeURIComponent(code)}/revoke`, { method: 'POST', token: a.token })).status,
      200,
    );

    // 商家汇总只含自己的已付订单
    const aSummary = await api(h, '/biz/api/summary', { token: a.token });
    assert.equal(aSummary.json.orderCount, 1);
    assert.equal(aSummary.json.paidOrderCount, 1);
    assert.equal(aSummary.json.revenueCny, 3);
    assert.equal(aSummary.json.usesSold, 3);

    // 商家不能访问管理员接口
    assert.equal((await api(h, '/biz/api/merchants', { token: a.token })).status, 403);
    const whoA = await api(h, '/biz/api/whoami', { token: a.token });
    assert.equal(whoA.json.kind, 'merchant');
    assert.equal(whoA.json.merchant.name, '甲店');
    const whoAdmin = await api(h, '/biz/api/whoami');
    assert.equal(whoAdmin.json.kind, 'admin');

    // 停用后商家令牌立即失效
    assert.equal((await api(h, `/biz/api/merchants/${a.id}/disable`, { method: 'POST' })).status, 200);
    assert.equal((await api(h, '/biz/api/orders', { token: a.token })).status, 401);

    // 轮换：旧令牌失效，新令牌可用
    const rotated = await api(h, `/biz/api/merchants/${b.id}/rotate`, { method: 'POST' });
    assert.equal(rotated.status, 200, rotated.text);
    assert.notEqual(rotated.json.token, b.token);
    assert.equal((await api(h, '/biz/api/orders', { token: b.token })).status, 401);
    assert.equal((await api(h, '/biz/api/orders', { token: rotated.json.token })).status, 200);

    // 管理员仍看全部
    const all = await api(h, '/biz/api/orders');
    assert.equal(all.json.orders.length, 2);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * 5. 页面与二维码
 * ------------------------------------------------------------------ */

test('biz: 商家台/顾客页/打印/收银台/QR 路由可用', async () => {
  const h = await harness();
  try {
    const consolePage = await api(h, '/biz', { token: null });
    assert.equal(consolePage.status, 200);
    assert.match(consolePage.text, /商家台/);
    assert.match(consolePage.text, /\/biz\/api\/orders/);
    assert.match(consolePage.text, /邀请商家/);
    assert.match(consolePage.text, /\/biz\/api\/merchants/);

    const customerPage = await api(h, '/s/ABCD-EFGH', { token: null });
    assert.equal(customerPage.status, 200);
    assert.match(customerPage.text, /扫码即用/);

    const packs = await api(h, '/biz/api/packs');
    assert.equal(packs.status, 200);
    assert.equal(packs.json.packs.length, TEST_PACKS.length);
    assert.equal((await api(h, '/biz/api/packs', { token: null })).status, 401);

    const { order, payment, token } = await buy(h, 'chat-3', 1);
    const badPay = await api(h, payment.payUrl.replace(/t=[^&]+/, 't=forged'));
    assert.equal(badPay.status, 403);
    const printBefore = await api(h, `/biz/print/${order.id}`, { token: null });
    assert.equal(printBefore.status, 401);
    await payMock(h, order.id, token);
    const print = await api(h, `/biz/print/${order.id}`);
    assert.equal(print.status, 200);
    assert.match(print.text, /<svg/);
    assert.match(print.text, /扫码即用/);

    const root = await api(h, '/', { token: null });
    assert.equal(root.status, 200);
    assert.match(root.json.endpoints.biz, /商家台/);
    assert.match(root.json.endpoints.scan, /顾客/);
  } finally {
    await h.close();
  }
});

test('biz: 图片按次计费且强制 n=1；mock 假链接替换为内联图', async () => {
  const h = await harness();
  try {
    const { order, token } = await buy(h, 'image-2');
    const paid = await payMock(h, order.id, token);
    const s = await openSession(h, paid.codes[0].code);
    const img = await api(h, '/biz/api/image', {
      method: 'POST',
      token: null,
      cookie: s.cookie,
      body: { prompt: '一杯冰美式', n: 3, size: '1024x1024' },
    });
    assert.equal(img.status, 200, img.text);
    assert.equal(img.json.data.length, 1);
    assert.match(img.json.data[0].url, /^data:image\/svg\+xml;base64,/);
    const seen = h.mock.received.filter((r) => r.path.endsWith('/images/generations')).at(-1);
    assert.ok(seen);
    assert.equal((seen.body as Record<string, unknown>)['n'], 1, '一次调用只生成一张');
    assert.equal((seen.body as Record<string, unknown>)['model'], 'mock-image');
    const me = await api(h, '/biz/api/me', { token: null, cookie: s.cookie });
    assert.equal(me.json.remaining, 1);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * 5. 纯函数 / 存储
 * ------------------------------------------------------------------ */

test('biz: 码规范化与二维码结构', () => {
  assert.equal(normalizeCode('ab12cd34'), 'AB12-CD34');
  assert.equal(normalizeCode('AB12-CD34'), 'AB12-CD34');
  assert.equal(normalizeCode('IIII-IIII'), null, 'I/L/O/U 不在字符集');
  assert.equal(normalizeCode('ABC'), null);

  const m = qrMatrix('https://example.com/s/ABCD-EFGH');
  assert.ok(m.size >= 21);
  assert.equal(m.modules[0]?.[0], true, '左上定位符');
  assert.equal(m.modules[0]?.[6], true);
  assert.equal(m.modules[1]?.[1], false);
  assert.equal(m.modules[3]?.[3], true);
  assert.equal(m.modules[0]?.[m.size - 1], true, '右上定位符');
  assert.equal(m.modules[m.size - 1]?.[0], true, '左下定位符');
  const svg = qrSvg('https://example.com/s/ABCD-EFGH');
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<path d="M/);
});

test('biz: SQLite 业务库往返（重启后订单/码/核销数不丢）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-biz-'));
  const path = join(dir, 'biz.db');
  const order: BizOrder = {
    id: 'ord_store_test',
    merchantName: '存储商户',
    packId: 'chat-3',
    packName: '对话 3 次',
    quantity: 1,
    unitPriceCny: 3,
    amountCny: 3,
    usesTotal: 3,
    validDays: 30,
    models: ['mock-small'],
    status: 'pending',
    provider: 'mock',
    createdAt: 1000,
  };
  try {
    const store = new SqliteBizStore(path, silent);
    await store.init();
    store.createOrder(order);
    assert.equal(store.markPaid(order.id, 'mock_1', 2000), true);
    assert.equal(store.markPaid(order.id, 'mock_1', 2000), false, '重复支付必须返回 false');
    store.createCodes([
      {
        code: 'TEST-CODE',
        orderId: order.id,
        packId: 'chat-3',
        merchantName: '存储商户',
        usesTotal: 3,
        usesUsed: 0,
        keyId: 'pk_test',
        createdAt: 2000,
        expiresAt: Date.now() + 86_400_000,
      },
    ]);
    await store.close();

    const reopened = new SqliteBizStore(path, silent);
    await reopened.init();
    const got = reopened.getOrder(order.id);
    assert.equal(got?.status, 'paid');
    assert.equal(got?.usesTotal, 3);
    assert.deepEqual(got?.models, ['mock-small']);
    const code = reopened.getCode('TEST-CODE');
    assert.equal(code?.usesTotal, 3);
    reopened.incrementUsed('TEST-CODE');
    assert.equal(reopened.getCode('TEST-CODE')?.usesUsed, 1);
    const summary = reopened.summary(Date.now());
    assert.equal(summary.revenueCny, 3);
    assert.equal(summary.usesUsed, 1);

    // 外卖单码绑定也要能跨重启：唯一索引挡住重复单号，码只被绑一次
    const now = Date.now();
    assert.equal(reopened.countBindableCodes('', now), 1);
    assert.equal(reopened.findBindableCode('', now)?.code, 'TEST-CODE');
    assert.equal(
      reopened.bindSlip({ code: 'TEST-CODE', merchantId: '', externalNo: 'ORD-1', orderId: order.id, createdAt: now }),
      true,
    );
    assert.equal(
      reopened.bindSlip({ code: 'TEST-CODE', merchantId: '', externalNo: 'ORD-2', orderId: order.id, createdAt: now }),
      false,
      '同一个码不能绑到第二个单号',
    );
    assert.equal(reopened.countBindableCodes('', now), 0);
    assert.equal(reopened.getSlip('', 'ORD-1')?.code, 'TEST-CODE');
    assert.equal(reopened.getSlipByCode('TEST-CODE')?.externalNo, 'ORD-1');
    assert.equal(reopened.listSlips('', 10).length, 1);
    await reopened.close();

    const again = new SqliteBizStore(path, silent);
    await again.init();
    assert.equal(again.getSlip('', 'ORD-1')?.code, 'TEST-CODE', '绑定要落盘');
    await again.close();
  } finally {
    await rmTmp(dir);
  }
});

/* ------------------------------------------------------------------ *
 * 6. 支付宝适配器
 * ------------------------------------------------------------------ */

function keyPair(): { priv: string; pub: string; privKey: KeyObject; pubKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    priv: privateKey,
    pub: publicKey,
    privKey: createPrivateKey(privateKey),
    pubKey: createPublicKey(publicKey),
  };
}

test('biz: 支付宝预下单签名可验、通知验签/金额/幂等/伪造全断言', async () => {
  const keys = keyPair();
  const gatewayCalls: Record<string, string>[] = [];
  const gateway = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) params[k] = v;
    gatewayCalls.push(params);
    const sign = params['sign'] ?? '';
    const ok = rsa2Verify(params, sign, keys.pubKey);
    res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        alipay_trade_precreate_response: ok
          ? { code: '10000', msg: 'Success', qr_code: 'https://qr.alipay.com/bax-test-qr', out_trade_no: params['out_trade_no'] }
          : { code: '40004', msg: 'bad sign' },
      }),
    );
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()));
  const addr = gateway.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;

  const h = await harness({
    payment: {
      provider: 'alipay',
      alipay: {
        appId: '2021000000000000',
        privateKey: keys.priv,
        alipayPublicKey: keys.pub,
        gateway: `http://127.0.0.1:${port}/gateway.do`,
        notifyUrl: 'https://relay.example.com/biz/api/alipay/notify',
      },
    },
  });
  try {
    const { order } = await buy(h, 'chat-3', 2, '支付宝商户');
    assert.equal(gatewayCalls.length, 1);
    const reqParams = gatewayCalls[0]!;
    assert.equal(reqParams['method'], 'alipay.trade.precreate');
    assert.equal(reqParams['app_id'], '2021000000000000');
    assert.equal(reqParams['sign_type'], 'RSA2');
    assert.ok(rsa2Verify(reqParams, reqParams['sign'] ?? '', keys.pubKey), '预下单请求签名必须能验过');
    const bizContent = JSON.parse(reqParams['biz_content'] ?? '{}') as Record<string, string>;
    assert.equal(bizContent['out_trade_no'], order.id);
    assert.equal(bizContent['total_amount'], '6.00');
    assert.match(bizContent['subject'] ?? '', /对话 3 次/);

    const orders = await api(h, '/biz/api/orders');
    const created = orders.json.orders.find((o: any) => o.id === order.id);
    assert.equal(created.status, 'pending');

    const notify = (over: Record<string, string>): string => {
      const params: Record<string, string> = {
        app_id: '2021000000000000',
        trade_status: 'TRADE_SUCCESS',
        total_amount: '6.00',
        out_trade_no: order.id,
        trade_no: '2026110822001',
        ...over,
      };
      const sign = rsa2Sign(params, keys.privKey);
      return new URLSearchParams({ ...params, sign, sign_type: 'RSA2' }).toString();
    };
    const postNotify = async (body: string): Promise<{ status: number; text: string }> => {
      const res = await fetch(`${h.base}/biz/api/alipay/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      return { status: res.status, text: await res.text() };
    };

    // 金额不符：拒
    const mismatch = await postNotify(notify({ total_amount: '0.01' }));
    assert.equal(mismatch.text, 'failure');
    const stillPending = (await api(h, '/biz/api/orders')).json.orders.find((o: any) => o.id === order.id);
    assert.equal(stillPending.status, 'pending');

    // 伪造签名：拒
    const forged = notify({});
    const forgedBroken = forged.replace(/sign=[^&]+/, 'sign=AAAA');
    const bad = await postNotify(forgedBroken);
    assert.equal(bad.status, 400);
    assert.equal(bad.text, 'failure');

    // 未知订单：failure
    const unknown = await postNotify(notify({ out_trade_no: 'ord_not_exist' }));
    assert.equal(unknown.text, 'failure');

    // 正常通知：paid + 出码
    const ok = await postNotify(notify({}));
    assert.equal(ok.status, 200);
    assert.equal(ok.text, 'success');
    const paidOrder = (await api(h, '/biz/api/orders')).json.orders.find((o: any) => o.id === order.id);
    assert.equal(paidOrder.status, 'paid');
    assert.equal(paidOrder.codes.length, 2);

    // 重复通知：仍 success，码不重复
    const dup = await postNotify(notify({}));
    assert.equal(dup.text, 'success');
    const after = (await api(h, '/biz/api/orders')).json.orders.find((o: any) => o.id === order.id);
    assert.equal(after.codes.length, 2);

    // 签名原文规则：排除 sign/sign_type，按字典序
    assert.equal(signContent({ b: '2', a: '1', sign: 'x', sign_type: 'RSA2', c: '' }), 'a=1&b=2');
  } finally {
    await h.close();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
});

/* ------------------------------------------------------------------ *
 * 外卖单码：一单一个码，重复单号返回原码
 * ------------------------------------------------------------------ */

async function buyWithToken(h: Harness, token: string, packId: string, quantity: number): Promise<any> {
  const r = await api(h, '/biz/api/orders', { method: 'POST', token, body: { packId, quantity } });
  assert.equal(r.status, 200, r.text);
  const payment = r.json.payment as { kind: string; payUrl: string };
  const payToken = payment.kind === 'redirect' ? new URL(payment.payUrl, h.base).searchParams.get('t') ?? '' : '';
  return payMock(h, r.json.order.id, payToken);
}

test('biz: 外卖单码——同一订单号只出一个码，池子按码消耗', async () => {
  const h = await harness();
  try {
    const paid = await buyWithToken(h, ADMIN, 'slip-2', 2);
    assert.equal(paid.codes.length, 2);

    const first = await api(h, '/biz/api/slips/bind', { method: 'POST', body: { externalOrderNo: '#MT 2026 1109 001' } });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.reused, false);
    assert.equal(first.json.slip.externalNo, 'MT20261109001');
    assert.equal(first.json.slip.usesTotal, 2);
    assert.equal(first.json.pool.remaining, 1);
    const code1 = first.json.slip.code as string;

    // 同一单号换大小写/空格再录：返回原码，不再消耗
    const again = await api(h, '/biz/api/slips/bind', { method: 'POST', body: { externalOrderNo: 'mt20261109001' } });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.reused, true);
    assert.equal(again.json.slip.code, code1);
    assert.equal(again.json.pool.remaining, 1);

    const second = await api(h, '/biz/api/slips/bind', { method: 'POST', body: { externalOrderNo: 'JD20261109002' } });
    assert.equal(second.status, 200, second.text);
    assert.notEqual(second.json.slip.code, code1);
    assert.equal(second.json.pool.remaining, 0);

    // 池子空了：拒绝，不凭空造码
    const empty = await api(h, '/biz/api/slips/bind', { method: 'POST', body: { externalOrderNo: 'ELM20261109003' } });
    assert.equal(empty.status, 409);
    assert.equal(empty.json.error.code, 'slip_pool_empty');

    // 绑出来的码就是普通核销码：扫码能开会话
    const session = await openSession(h, code1);
    assert.equal(session.status, 200, session.text);
    assert.equal(session.json.remaining, 2);

    // 58mm 标签：含单号与二维码；没有令牌不能看
    const label = await api(h, first.json.slip.labelPath);
    assert.equal(label.status, 200, label.text);
    assert.match(label.text, /58mm/);
    assert.match(label.text, /MT20261109001/);
    assert.match(label.text, /<svg/);
    assert.equal((await fetch(`${h.base}${first.json.slip.labelPath}`)).status, 401);

    const list = await api(h, '/biz/api/slips');
    assert.equal(list.json.slips.length, 2);
    assert.equal(list.json.slips[0].externalNo, 'JD20261109002');
  } finally {
    await h.close();
  }
});

test('biz: 外卖单码——商家各绑各的码，跨商家同单号互不影响', async () => {
  const h = await harness();
  try {
    const a = await createMerchant(h, '甲面馆');
    const b = await createMerchant(h, '乙咖啡');
    await buyWithToken(h, a.token, 'slip-2', 1);
    await buyWithToken(h, b.token, 'slip-2', 1);

    const ra = await api(h, '/biz/api/slips/bind', { method: 'POST', token: a.token, body: { externalOrderNo: 'ORD-SAME-001' } });
    const rb = await api(h, '/biz/api/slips/bind', { method: 'POST', token: b.token, body: { externalOrderNo: 'ORD-SAME-001' } });
    assert.equal(ra.status, 200, ra.text);
    assert.equal(rb.status, 200, rb.text);
    assert.notEqual(ra.json.slip.code, rb.json.slip.code);
    assert.equal(ra.json.slip.merchantName, '甲面馆');
    assert.equal(rb.json.slip.merchantName, '乙咖啡');

    // 标签页只能看自己的码
    assert.equal((await api(h, ra.json.slip.labelPath, { token: a.token })).status, 200);
    assert.equal((await api(h, rb.json.slip.labelPath, { token: a.token })).status, 404);

    // 列表按商家隔离
    const la = await api(h, '/biz/api/slips', { token: a.token });
    assert.equal(la.json.slips.length, 1);
    assert.equal(la.json.slips[0].code, ra.json.slip.code);

    // 非法单号 400；未登录 401
    assert.equal(
      (await api(h, '/biz/api/slips/bind', { method: 'POST', token: a.token, body: { externalOrderNo: 'x' } })).status,
      400,
    );
    assert.equal(
      (await api(h, '/biz/api/slips/bind', { method: 'POST', token: null, body: { externalOrderNo: 'ORD-2' } })).status,
      401,
    );
  } finally {
    await h.close();
  }
});
