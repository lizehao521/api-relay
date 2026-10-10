/**
 * 日志脱敏 + 常数时间比较（r22，死代码扫描的收获）。
 *
 * 背景：全项目死代码扫描发现 `redact()` **从未被调用**，而
 * docs/DEPLOYMENT.md 与 docs/ARCHITECTURE.md 两处都承诺「日志经 redact() 脱敏」
 * 「敏感字段自动脱敏」。实测原样输出 —— 文档承诺了一道不存在的控制。
 * 同轮还发现 `timeSafeEqual`（util）与 `timingSafeEqual`（auth.ts 手写 XOR 版）
 * 是**两份实现**，前者零消费、后者在管管理令牌。
 *
 * 本轮修法：
 *   ① redact 接进 Logger.write()，并重写判据 —— 旧正则 /key|token|.../i 会把
 *      **keyId** 也掩成 `***`（含子串 key），而 keyId 是管理日志的唯一关联字段；
 *      且旧版只扫一层，`{nested:{apiKey}}` 原样穿透（实测泄漏）。现在递归 + 精确判据。
 *   ② 删掉 auth.ts 的手写实现，改用 util 里基于 node:crypto 原语的那份（去重）。
 *
 * 这里锁住三条：秘密必须掩、标识符必须留、嵌套必须覆盖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Logger, redact } from '../core/logger.js';
import { timeSafeEqual } from '../util/index.js';

/* ------------------------------------------------------------------ *
 * A. redact 判据
 * ------------------------------------------------------------------ */

test('redact：秘密字段必须掩码', () => {
  const r = redact({
    apiKey: 'sk-super-secret-123456',
    key: 'raw-key-value-abcdef',
    secret: 'shh-value-1234',
    token: 'tok-abcdefghij',
    password: 'p@ssw0rd-long',
    authorization: 'Bearer abcdefghijklmn',
    credential: 'cred-abcdefghij',
    api_key: 'sk-underscore-123456',
    'api-key': 'sk-dashed-123456',
  });
  for (const [k, v] of Object.entries(r)) {
    assert.equal(typeof v, 'string', `${k} 应为字符串`);
    assert.ok(!String(v).includes('super-secret') && !String(v).includes('abcdefghijklmn'),
      `${k} 必须掩码，实际 ${v}`);
    // 长值留头 6 尾 4，短值整体打码
    assert.ok(/^\.\.\.$|^.{0,6}\.\.\..{0,4}$|^\*{3}$/.test(String(v)) || String(v).includes('...') || v === '***',
      `${k} 的掩码形状异常: ${v}`);
  }
});

test('redact：标识符字段绝不能被误伤（否则管理日志失去关联能力）', () => {
  // 旧正则 /key|.../i 会把 keyId 掩成 *** —— 这正是重写要避开的坑
  const r = redact({
    keyId: 'free',
    keyLength: 42,
    kbId: 'kb-demo',
    keyCount: 3,
    tier: 'pro',
    fingerprint: 'fp_abc',
    path: '/v1/chat/completions',
    model: 'agnes-2.5-flash',
    providerId: 'agnes',
    traceId: 'tr_123',
    requestId: 'req_456',
    tenantId: 't',
    origin: 'config',
    normal: 'ok',
  });
  const expected: Record<string, unknown> = {
    keyId: 'free', keyLength: 42, kbId: 'kb-demo', keyCount: 3, tier: 'pro',
    fingerprint: 'fp_abc', path: '/v1/chat/completions', model: 'agnes-2.5-flash',
    providerId: 'agnes', traceId: 'tr_123', requestId: 'req_456', tenantId: 't',
    origin: 'config', normal: 'ok',
  };
  assert.deepEqual(r, expected, '标识符字段必须原样保留');
});

test('redact：必须递归（旧版只扫一层，嵌套秘密原样穿透）', () => {
  const r = redact({
    keyId: 'outer',
    nested: { apiKey: 'sk-nested-secret-123', keyId: 'inner-key', deeper: { token: 'tok-deep-12345678' } },
    arr: [{ secret: 'arr-secret-12345' }, 'plain'],
  }) as Record<string, any>;
  assert.equal(r.nested.keyId, 'inner-key', '嵌套的标识符仍要保留');
  assert.ok(!JSON.stringify(r).includes('sk-nested-secret-123'), '嵌套的 apiKey 必须掩码');
  assert.ok(!JSON.stringify(r).includes('tok-deep-12345678'), '深层嵌套的 token 必须掩码');
  assert.ok(!JSON.stringify(r).includes('arr-secret-12345'), '数组内的 secret 必须掩码');
  assert.ok(JSON.stringify(r).includes('plain'), '数组内的普通字符串不受影响');
});

test('redact：非字符串值原样通过，不因判据误改', () => {
  const r = redact({ apiKey: undefined, token: null, secret: 123, count: 0, flag: false, arr: [1, 2] }) as Record<string, any>;
  assert.equal(r.apiKey, undefined);
  assert.equal(r.token, null);
  assert.equal(r.secret, 123);
  assert.equal(r.count, 0);
  assert.equal(r.flag, false);
  assert.deepEqual(r.arr, [1, 2]);
});

/* ------------------------------------------------------------------ *
 * B. Logger 真的接上了脱敏（这是本轮修的核心，不是 redact 单测能证明的）
 * ------------------------------------------------------------------ */

test('Logger.write 必须脱敏：秘密不进日志，keyId 要进', () => {
  const lines: string[] = [];
  const lg = new Logger('info', (l) => lines.push(l));
  lg.info('admin.key_update', {
    keyId: 'free',
    tier: 'pro',
    apiKey: 'sk-should-never-appear-999',
    nested: { token: 'tok-should-never-appear-888' },
  });
  assert.equal(lines.length, 1, '应输出一行');
  const j = JSON.parse(lines[0]!) as Record<string, any>;
  assert.ok(!lines[0]!.includes('sk-should-never-appear-999'), 'apiKey 明文不得进日志');
  assert.ok(!lines[0]!.includes('tok-should-never-appear-888'), '嵌套 token 明文不得进日志');
  assert.equal(j.keyId, 'free', 'keyId 必须保留（管理日志的关联字段）');
  assert.equal(j.tier, 'pro');
});

test('Logger：低于级别的日志仍不输出（脱敏不得改变级别语义）', () => {
  const lines: string[] = [];
  const lg = new Logger('warn', (l) => lines.push(l));
  lg.info('should.not.appear', { apiKey: 'sk-xxxx-123456' });
  assert.equal(lines.length, 0);
});

/* ------------------------------------------------------------------ *
 * C. 常数时间比较（去重后由 util 单一实现提供）
 * ------------------------------------------------------------------ */

test('timeSafeEqual：相等返回 true', () => {
  assert.equal(timeSafeEqual('abc', 'abc'), true);
  assert.equal(timeSafeEqual('', ''), true);
  assert.equal(timeSafeEqual('79c761df98c506ee3155d5213f9b67bd6e6f804f26aa6904', '79c761df98c506ee3155d5213f9b67bd6e6f804f26aa6904'), true);
});

test('timeSafeEqual：不等/长度不同/前缀都返回 false', () => {
  assert.equal(timeSafeEqual('abc', 'abd'), false);
  assert.equal(timeSafeEqual('abc', 'ab'), false, '长度不同必须 false');
  assert.equal(timeSafeEqual('ab', 'abc'), false);
  assert.equal(timeSafeEqual('prefix-match', 'prefix'), false);
  assert.equal(timeSafeEqual('', 'x'), false);
  assert.equal(timeSafeEqual('x', ''), false);
});

test('timeSafeEqual：多字节字符按字节比较（不按 UTF-16 码元）', () => {
  // 手写版按 charCodeAt（UTF-16 码元）比，util 版转 utf8 Buffer 按字节比。
  // 这两个字符串 UTF-16 长度相同但字节不同 —— 必须判不等。
  assert.equal(timeSafeEqual('é', 'e'), false);
  assert.equal(timeSafeEqual('你好', '你号'), false);
  assert.equal(timeSafeEqual('你好', '你好'), true);
});
