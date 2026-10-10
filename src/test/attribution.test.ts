/** P3 失败归因的单测：这是"错误对用户可执行"的核心承诺。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, parseRetryAfterMs, classifyCacheKey, createClassifier } from '../loss/attribution.js';
import { BoundedCache } from '../util/index.js';
import type { ClassifyInput } from '../core/types.js';

const base: ClassifyInput = { providerId: 'mock', model: 'mock-small', attempt: 1 };

function cls(patch: Partial<ClassifyInput>) {
  return classifyFailure({ ...base, ...patch });
}

test('429 + Retry-After 头 → 可恢复 + 退避重试 + 具体等待毫秒', () => {
  const c = cls({ httpStatus: 429, headers: { 'retry-after': '3' }, bodyText: '{"error":{"message":"Rate limit reached"}}' });
  assert.equal(c.failure_reason, 'rate_limited');
  assert.equal(c.recoverable, true);
  assert.equal(c.suggested_next.action, 'retry_with_backoff');
  assert.equal(c.suggested_next.retryAfterMs, 3000);
});

test('余额不足优先于限流：即使 HTTP 是 429，也必须判定为不可重试', () => {
  const c = cls({ httpStatus: 429, bodyText: '{"error":{"message":"Insufficient Balance","code":"insufficient_balance"}}' });
  assert.equal(c.failure_reason, 'quota_exhausted');
  assert.equal(c.recoverable, false);
  assert.equal(c.suggested_next.action, 'top_up_balance');
});

test('SiliconFlow 风格（无 error 包裹层）也能归因', () => {
  const c = cls({ httpStatus: 400, bodyText: '{"code":20012,"message":"balance is insufficient","data":null}' });
  assert.equal(c.failure_reason, 'quota_exhausted');
});

test('OpenRouter 风格（code 为数字 HTTP 状态码）也能命中限流', () => {
  const c = cls({ httpStatus: 429, bodyText: '{"error":{"code":429,"message":"rate limited","metadata":{"error_type":"rate_limit_exceeded"}}}' });
  assert.equal(c.failure_reason, 'rate_limited');
});

test('401 → 密钥问题（不可恢复，且不引导用户重试）', () => {
  const c = cls({ httpStatus: 401, bodyText: '{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}' });
  assert.equal(c.failure_reason, 'auth_invalid');
  assert.equal(c.recoverable, false);
  assert.equal(c.suggested_next.action, 'fix_credentials');
});

test('模型不存在 → 建议换模型，并指出这是上游不认识该名称', () => {
  const c = cls({ httpStatus: 404, bodyText: '{"error":{"message":"The model `x` does not exist","code":"model_not_found"}}' });
  assert.equal(c.failure_reason, 'model_not_found');
  assert.equal(c.suggested_next.action, 'switch_model');
});

test('上下文超限 → reduce_context（而不是让用户重试同一个请求）', () => {
  const c = cls({ httpStatus: 400, bodyText: '{"error":{"message":"This model maximum context length is 8192 tokens"}}' });
  assert.equal(c.failure_reason, 'context_length_exceeded');
  assert.equal(c.suggested_next.action, 'reduce_context');
});

test('内容过滤 → 必须改写输入（原样重试不可能成功）', () => {
  const c = cls({ httpStatus: 400, bodyText: '{"error":{"message":"Your request was flagged by our content filter","code":"content_filter"}}' });
  assert.equal(c.failure_reason, 'content_filtered');
  assert.equal(c.recoverable, false);
  assert.equal(c.suggested_next.action, 'rewrite_input');
});

test('HTTP 200 + content_filter 信号：只标记不改写响应', () => {
  const c = cls({ httpStatus: 200, bodyText: '{"choices":[{"finish_reason":"content_filter"}]}' });
  assert.equal(c.failure_reason, 'content_filtered');
});

test('网络层错误按错误码分类（ECONNREFUSED → 网络；ETIMEDOUT → 超时）', () => {
  const refused = cls({ networkError: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } });
  assert.equal(refused.failure_reason, 'network_error');
  assert.equal(refused.recoverable, true);

  const timeout = cls({ networkError: { code: 'UND_ERR_HEADERS_TIMEOUT', message: 'headers timeout' } });
  assert.equal(timeout.failure_reason, 'upstream_timeout');
  assert.equal(timeout.suggested_next.action, 'retry_with_backoff');
});

test('客户端断开不归因为上游故障（避免误导重试）', () => {
  const c = cls({ clientAborted: true, httpStatus: 499 });
  assert.equal(c.suggested_next.action, 'abort');
  assert.equal(c.recoverable, false);
});

test('relay 自身异常被显式标注为 relay 侧问题', () => {
  const c = cls({ relayError: { message: 'boom' } });
  assert.equal(c.failure_reason, 'relay_internal_error');
  assert.equal(c.upstream, 'relay');
});

test('未知错误兜底：不猜，按状态码给最小可信结论', () => {
  const c = cls({ httpStatus: 418, bodyText: '{"weird":true}' });
  assert.equal(c.failure_reason, 'invalid_request');
  const c2 = cls({});
  assert.equal(c2.failure_reason, 'unknown');
  assert.equal(c2.confidence < 0.5, true);
});

test('HTML 错误页（502 Bad Gateway）不会让归因崩，也不会外泄整页 HTML', () => {
  const c = cls({ httpStatus: 502, bodyText: '<html><body><h1>502 Bad Gateway</h1></body></html>' });
  assert.equal(c.failure_reason, 'upstream_unavailable');
  assert.ok(c.evidence!.every((e) => e.length < 400));
});

test('parseRetryAfterMs 支持秒、HTTP 日期、复合时长与响应体提示', () => {
  assert.equal(parseRetryAfterMs({ 'retry-after': '2' }), 2000);
  assert.equal(parseRetryAfterMs({ 'retry-after': '1.5s' }), 1500);
  assert.equal(parseRetryAfterMs({ 'retry-after': '1m30s' }), 90_000);
  const bodyHit = parseRetryAfterMs(undefined, 'Please try again in 2.5s');
  assert.equal(bodyHit, 2500);
  assert.equal(parseRetryAfterMs(undefined, 'no hint'), undefined);
});

test('归因卡片是纯函数：相同输入两次结果一致（可安全记忆化）', () => {
  const input: ClassifyInput = { ...base, httpStatus: 429, bodyText: 'rate limit', headers: { 'retry-after': '1' } };
  const a = classifyFailure(input, 1);
  const b = classifyFailure(input, 1);
  assert.deepEqual({ ...a, suggested_next: { ...a.suggested_next } }, { ...b, suggested_next: { ...b.suggested_next } });
});

test('缓存键覆盖全部会影响判定的输入（避免记忆化返回错误结论）', () => {
  const k1 = classifyCacheKey({ ...base, httpStatus: 429 });
  const k2 = classifyCacheKey({ ...base, httpStatus: 500 });
  const k3 = classifyCacheKey({ ...base, httpStatus: 429, attempt: 2 });
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
});

test('记忆化分类器：命中缓存时不再消耗耗时，且结论一致', () => {
  const cache = new BoundedCache<ReturnType<typeof classifyFailure>>(10);
  const classifier = createClassifier(cache);
  const input: ClassifyInput = { ...base, httpStatus: 429, bodyText: 'rate limit reached' };
  const first = classifier.classify(input);
  const second = classifier.classify(input);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.durationUs, 0);
  assert.equal(first.card.failure_reason, second.card.failure_reason);
  assert.equal(classifier.stats().hits, 1);
});

test('低置信度结果不进入缓存（避免把兜底结论固化成事实）', () => {
  const cache = new BoundedCache<ReturnType<typeof classifyFailure>>(10);
  const classifier = createClassifier(cache);
  classifier.classify({ ...base, httpStatus: 418, bodyText: '{"weird":true}' });
  assert.equal(cache.size, 0);
});

/* ------------------------------------------------------------------ *
 * 国内厂商的中文错误文案（纯英文正则会整类漏判）
 * ------------------------------------------------------------------ */

test('中文错误文案也能归因：无效的令牌 / 未提供令牌 / 余额不足 / 限流', () => {
  // Agnes 的真实响应体形状：非标准 OpenAI（error.code 为空串，type=AgnesAI_error）
  const agnes = cls({ httpStatus: 401, bodyText: '{"error":{"code":"","message":"无效的令牌 (request id: 20260911abc)","type":"AgnesAI_error"}}' });
  assert.equal(agnes.failure_reason, 'auth_invalid');
  assert.equal(agnes.suggested_next.action, 'fix_credentials');

  const noToken = cls({ httpStatus: 401, bodyText: '{"error":{"message":"未提供令牌","type":"AgnesAI_error"}}' });
  assert.equal(noToken.failure_reason, 'auth_invalid');

  const balance = cls({ httpStatus: 402, bodyText: '{"error":{"message":"账户余额不足，请充值"}}' });
  assert.equal(balance.failure_reason, 'quota_exhausted');
  assert.equal(balance.suggested_next.action, 'top_up_balance');

  const limited = cls({ httpStatus: 429, bodyText: '{"error":{"message":"请求过于频繁，请稍后再试"}}' });
  assert.equal(limited.failure_reason, 'rate_limited');
  assert.equal(limited.recoverable, true);
});

/* ------------------------------------------------------------------ *
 * 401 与 403 是两回事：别让客户端去折腾不该折腾的东西
 * ------------------------------------------------------------------ */

test('403 是模型级问题 → 建议换模型且可恢复；401 是凭据问题 → 建议修凭据', () => {
  // 实测背景：Agnes 的 key 调 agnes-2.5-pro 全系列 403，但 agnes-*.flash 正常。
  // 若把 403 说成"凭据问题"，客户端会去折腾 key，而正确动作是换模型。
  const perm = cls({ httpStatus: 403, bodyText: '{"error":{"message":"You do not have permission to access this model","code":"permission_denied"}}' });
  assert.equal(perm.failure_reason, 'permission_denied');
  assert.equal(perm.suggested_next.action, 'switch_model', '403 应建议换模型');
  assert.equal(perm.recoverable, true, '403 通常换个模型就能成');

  // 401 才是真正的凭据问题
  const auth = cls({ httpStatus: 401, bodyText: '{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}' });
  assert.equal(auth.failure_reason, 'auth_invalid');
  assert.equal(auth.suggested_next.action, 'fix_credentials');
  assert.equal(auth.recoverable, false);
});

test('403 的内容安全与权限两种语义必须分开归因（同一个状态码，处置完全不同）', () => {
  const filter = cls({ httpStatus: 403, bodyText: '{"error":{"message":"内容安全策略拦截：sensitive content detected","code":"content_policy_violation"}}' });
  assert.equal(filter.failure_reason, 'content_filtered', '带内容安全文案的 403 是请求级问题');
  assert.equal(filter.suggested_next.action, 'rewrite_input');

  const perm = cls({ httpStatus: 403, bodyText: '{"error":{"message":"forbidden: no access","code":"permission_denied"}}' });
  assert.equal(perm.failure_reason, 'permission_denied', '无权限文案才是模型级问题');
  assert.equal(perm.suggested_next.action, 'switch_model');
});
