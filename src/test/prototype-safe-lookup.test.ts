/**
 * 原型链安全查找（ownLookup）+ 窗口参数不变量（r18）。
 *
 * 同一个 bug 类，两处实证：
 *
 *  A. `ownLookup` —— `obj[key]` 在 key 为 'constructor'/'__proto__'/'toString' 等时
 *     会命中 Object.prototype，把「查不到」变成「查到一个函数/对象」。
 *     params.ts 的 windowFrom 就是这么中招的（详见下）。
 *
 *  B. `windowFrom`/`windowOf` —— 修复前用**对象字面量**做白名单查找，于是：
 *       /admin/api/metrics?window=constructor
 *         → windowLabel 把 "function Object() { [native code] }" 回显给客户端
 *       /admin/api/overview?window=__proto__
 *         → windowMs 序列化成 {}，summary.from=null、requests 全 0（24h 实际 729 请求）
 *       /admin/api/series?window=constructor
 *         → since 变 NaN，图表静默变空
 *     即一个拼错的 window 参数让看板「不能说谎」的承诺整个失效。
 *     现已改用 Map（键空间固定）——Map 不走原型链，天然安全。
 *
 * 这里锁的是**不变量**而不是具体返回值：任何输入下 windowMs 都必须是有限正数、
 * 标签都不得出现 JS 内部结构。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownLookup } from '../util/index.js';
import { windowFrom, windowLabel, windowOf } from '../admin/params.js';
import { createApp, memoryConfig, type App } from '../app.js';
import { MockUpstream } from '../mock/upstream.js';
import { Logger } from '../core/logger.js';
import type { RelayConfig, ProviderConfig } from '../core/types.js';

/* ------------------------------------------------------------------ *
 * A. ownLookup
 * ------------------------------------------------------------------ */

test('ownLookup：自有键正常取值', () => {
  const o = { a: 1, b: 'x' };
  assert.equal(ownLookup(o, 'a'), 1);
  assert.equal(ownLookup(o, 'b'), 'x');
});

test('ownLookup：原型链键一律返回 undefined（而不是函数/对象）', () => {
  const o: Record<string, number> = { a: 1 };
  for (const k of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__lookupGetter__']) {
    assert.equal(ownLookup(o, k), undefined, `key=${k} 必须取不到（拿到了原型链上的东西）`);
  }
  // 直接索引对照：证明这些键在裸对象上确实"有值"——正是这个差异构成了 bug
  assert.equal(typeof (o as unknown as Record<string, unknown>)['constructor'], 'function',
    '对照：裸对象索引 constructor 确实拿到函数（所以 ownLookup 的保护是必要的）');
});

test('ownLookup：不存在的键与 undefined 容器', () => {
  assert.equal(ownLookup({ a: 1 }, 'zzz'), undefined);
  assert.equal(ownLookup(undefined, 'a'), undefined);
  assert.equal(ownLookup({}, 'a'), undefined);
});

test('ownLookup：自有属性名叫 constructor 也能取到（只排继承，不排同名自有键）', () => {
  const o: Record<string, string> = { constructor: 'mine' };
  assert.equal(ownLookup(o, 'constructor'), 'mine', '自有同名键必须能取到');
});

test('ownLookup：值为 undefined/falsy 的自有键必须原样返回（不能与"取不到"混淆）', () => {
  const o: Record<string, unknown> = { a: undefined, b: 0, c: '', d: false, e: null };
  assert.ok(Object.hasOwn(o, 'a') && ownLookup(o, 'a') === undefined, '值为 undefined 的自有键');
  assert.equal(ownLookup(o, 'b'), 0);
  assert.equal(ownLookup(o, 'c'), '');
  assert.equal(ownLookup(o, 'd'), false);
  assert.equal(ownLookup(o, 'e'), null);
});

/* ------------------------------------------------------------------ *
 * B. 窗口参数不变量
 * ------------------------------------------------------------------ */

const PROTOTYPE_KEYS = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__'];
const WEIRD_INPUTS = [
  ...PROTOTYPE_KEYS,
  'NaN', 'Infinity', '-Infinity', '1e999', 'null', 'undefined', '[object Object]',
  ' 1h ', '1h\x00', '%', '{}', '[]', 'true', '0x10', '1_000',
];

test('窗口不变量：windowMs 恒为有限正数，标签必须是合规形状', () => {
  // 正向断言而非负向正则：标签只允许三种形状 —— 规范名 / `${ms}ms` /
  // `24h（未识别的 window=<用户原值>，已按 24h 处理）`。
  // 这样即使用户真的传了 'function' 或 '[object Object]'，也只会以**原值回显**的
  // 形式出现在第三种形状里，而绝不可能是实现漏出来的 "function Object() { [native code] }"。
  const CANON = new Map<number, string>([
    [300_000, '5m'], [3_600_000, '1h'], [86_400_000, '24h'],
    [604_800_000, '7d'], [2_592_000_000, '30d'],
  ]);
  for (const raw of WEIRD_INPUTS) {
    const url = new URL('http://x/?' + (raw === '' ? '' : 'window=' + encodeURIComponent(raw)));
    const windowMs = windowFrom(url);
    const label = windowLabel(url);

    assert.equal(typeof windowMs, 'number', `window=${raw} → windowMs 必须是 number，实际 ${typeof windowMs}`);
    assert.ok(Number.isFinite(windowMs) && windowMs > 0,
      `window=${raw} → windowMs 必须是有限正数，实际 ${windowMs}`);

    const expected =
      CANON.get(windowMs) ??
      `${windowMs}ms` ??
      `24h（未识别的 window=${raw}，已按 24h 处理）`;
    const wellFormed =
      label === expected ||
      label === `24h（未识别的 window=${raw}，已按 24h 处理）` ||
      // 未识别但生效窗口不是 24h 时（例：自定义毫秒数本就是合法值，不会走到这条）
      label === `${windowMs}ms`;
    assert.ok(wellFormed,
      `window=${JSON.stringify(raw)} → 标签必须是合规形状，实际 ${JSON.stringify(label)}`);
    assert.ok(!/native code/.test(label),
      `window=${JSON.stringify(raw)} → 标签不得含 JS 内部结构，实际 ${JSON.stringify(label)}`);
  }
});

test('窗口不变量：原型链键与普通未识别键待遇一致（都按 24h 兜底 + 提示未识别）', () => {
  for (const raw of PROTOTYPE_KEYS) {
    const url = new URL('http://x/?window=' + encodeURIComponent(raw));
    assert.equal(windowFrom(url), 86_400_000, `window=${raw} 应按 24h 兜底`);
    const label = windowLabel(url);
    assert.ok(label.startsWith('24h') && label.includes('未识别'),
      `window=${raw} 的标签应是「未识别」提示，实际 ${label}`);
    // 提示里必须回显**用户自己传的原值**，他才知道哪里写错了
    assert.ok(label.includes(raw), `window=${raw} 的标签应回显原值，实际 ${label}`);
  }
});

test('windowOf 与 windowFrom/windowLabel 逐字一致（同源）', () => {
  for (const raw of ['1h', '24h', '5m', '7d', '30d', '10m', 'abc', '0', '-5', '999999', '3600000', ...PROTOTYPE_KEYS]) {
    const url = new URL('http://x/' + (raw === '' ? '' : '?window=' + encodeURIComponent(raw)));
    const { windowMs, label } = windowOf(url);
    assert.equal(windowMs, windowFrom(url), `window=${raw} 的 ms 必须同源`);
    assert.equal(label, windowLabel(url), `window=${raw} 的 label 必须同源`);
  }
});

test('窗口白名单与边界值行为不变（防修复顺手改坏正常路径）', () => {
  const cases: [string, number, string][] = [
    ['5m', 300_000, '5m'],
    ['1h', 3_600_000, '1h'],
    ['24h', 86_400_000, '24h'],
    ['7d', 604_800_000, '7d'],
    ['30d', 2_592_000_000, '30d'],
    ['10m', 86_400_000, '24h（未识别的 window=10m，已按 24h 处理）'],
    ['abc', 86_400_000, '24h（未识别的 window=abc，已按 24h 处理）'],
    ['0', 86_400_000, '24h（未识别的 window=0，已按 24h 处理）'],
    ['-5', 86_400_000, '24h（未识写的 window=-5，已按 24h 处理）'.replace('未识写的', '未识别的')],
    ['', 86_400_000, '24h'],
    ['3600000', 3_600_000, '1h'],
    ['999999', 999_999, '999999ms'],
  ];
  for (const [raw, ms, label] of cases) {
    const url = new URL('http://x/' + (raw === '' ? '' : '?window=' + encodeURIComponent(raw)));
    assert.equal(windowFrom(url), ms, `window=${JSON.stringify(raw)} 的 ms`);
    assert.equal(windowLabel(url), label, `window=${JSON.stringify(raw)} 的 label`);
  }
});

/* ------------------------------------------------------------------ *
 * C. 模型名路径：公开 API 用 model=constructor 打过来会怎样
 *
 * 与 A/B 同一个 bug 类，但**更严重**：key 直接来自请求体，任何持 key 的客户端都能触发。
 * 修复前实测（2026-10-02）：
 *   model=constructor  → resolveLadder 里 modelLadders['constructor'] 命中 Object
 *     构造函数，`.length` 是 1（>0 成立），`[...configured]` 展开函数抛
 *     TypeError: configured is not iterable → 客户端拿到 **HTTP 500**
 *     （服务日志：http.unhandled error="configured is not iterable"）
 *   model=toString/valueOf → 404 报文把 "function toString() { [native code] }" 泄漏给客户端
 *   model=__proto__    → 404 报文泄漏 "[object Object]"
 * 期望行为：原型链模型名与普通未知模型名**待遇完全一致** —— 404 + 干净的报文。
 * ------------------------------------------------------------------ */

const silent = new Logger('error', () => undefined);

async function modelHarness(): Promise<{ app: App; close: () => Promise<void> }> {
  const mock = new MockUpstream({ port: 0, logger: silent });
  const bound = await mock.listen();
  const providers: ProviderConfig[] = [
    { id: 'p1', label: '一', protocol: 'openai', baseUrl: bound.url, apiKey: 'k', models: ['real-model'], priority: 10 },
  ];
  const config: RelayConfig = memoryConfig({
    providers,
    clients: [{ id: 'k', label: 'p', key: 'sk-t', tier: 'pro', tenantId: 't', enabled: true }],
    logLevel: 'error',
  });
  config.modelLadders = { 'tier-a': ['real-model', 'real-model-2'] };
  config.modelAliases = { 'alias-a': 'real-model' };
  const app = await createApp(config, silent);
  return { app, close: async () => { await app.shutdown(); await mock.close(); } };
}

async function postModel(app: App, model: string): Promise<{ status: number; body: string }> {
  const raw = Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }), 'utf8');
  const r = await app.engine.handle({
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { authorization: 'Bearer sk-t', 'content-type': 'application/json' },
    rawBody: new Uint8Array(raw),
    signal: new AbortController().signal,
    requestId: 'req_psl_' + Math.random().toString(36).slice(2),
  });
  if (r.kind !== 'json') return { status: 200, body: '' };
  return { status: r.status, body: r.body };
}

test('模型名走原型链键：必须是 4xx + 报文干净，而不是 500 或泄漏 JS 内部结构', async () => {
  const h = await modelHarness();
  try {
    for (const model of PROTOTYPE_KEYS) {
      const { status, body } = await postModel(h.app, model);
      // 400（预检 model_unknown）或 404（路由层 model_not_found）都算对 ——
      // 关键是**绝不能是 5xx**。修复前 model=constructor 是 500。
      assert.ok(status >= 400 && status < 500,
        `model=${model} → 期望 4xx（客户端错误），实际 ${status}: ${body.slice(0, 160)}`);
      assert.ok(!/native code|function\s+\w+\(\)|\[object/.test(body),
        `model=${model} → 报文不得含 JS 内部结构，实际 ${body.slice(0, 200)}`);
      // 报文里出现的模型名必须是用户传的那个原值，而不是别的什么东西
      const j = JSON.parse(body) as { error?: { message?: string } };
      assert.ok((j.error?.message ?? '').includes(model),
        `model=${model} → 报文应回显用户传的原值，实际 ${j.error?.message}`);
    }
  } finally {
    await h.close();
  }
});

test('模型名走原型链键：与普通未知模型名待遇完全一致', async () => {
  const h = await modelHarness();
  try {
    const control = await postModel(h.app, 'totally-unknown-model');
    for (const model of PROTOTYPE_KEYS) {
      const got = await postModel(h.app, model);
      assert.equal(got.status, control.status,
        `model=${model} 的状态码应与普通未知模型一致（${control.status}），实际 ${got.status}`);
      const cj = JSON.parse(control.body) as { error?: { code?: string; message?: string } };
      const gj = JSON.parse(got.body) as { error?: { code?: string; message?: string } };
      assert.equal(gj.error?.code, cj.error?.code, `model=${model} 的 error.code 应与普通未知模型一致`);
    }
  } finally {
    await h.close();
  }
});

test('真实模型名与别名不受影响（防止修复顺手改坏正常路径）', async () => {
  const h = await modelHarness();
  try {
    // 真实模型：路由应成功走到上游（mock 默认 200）
    const ok = await postModel(h.app, 'real-model');
    assert.equal(ok.status, 200, `real-model 应成功，实际 ${ok.status}: ${ok.body.slice(0, 160)}`);
    // 阶梯名：应能解析成多阶并走到上游
    const ladder = await postModel(h.app, 'tier-a');
    assert.equal(ladder.status, 200, `阶梯名 tier-a 应成功，实际 ${ladder.status}: ${ladder.body.slice(0, 160)}`);
    // 别名：应解析到 real-model 并成功
    const alias = await postModel(h.app, 'alias-a');
    assert.equal(alias.status, 200, `别名 alias-a 应成功，实际 ${alias.status}: ${alias.body.slice(0, 160)}`);
  } finally {
    await h.close();
  }
});
