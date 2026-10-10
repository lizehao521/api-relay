/**
 * "没有可用上游" 的分流测试。
 *
 * 这一类错误的**唯一**危险点是把原因说错：
 * 用户报的 bug 就是 `503 上游 agnes 正处于熔断冷却中` 配着 `type: model_not_found`，
 * 于是人手会去改模型名 —— 越改越错。这里把四种成因逐个钉死：
 *
 *   model_unsupported  真的没人声明这个模型   → 该换模型
 *   all_breaker_open   都熔断了               → 等冷却 / 去修上游
 *   all_disabled       被人工摘除             → 运营动作
 *   all_excluded       声明了但本请求内被排除 → 请求级排除
 *
 * 不变量：只要**有**上游声明支持该模型，就绝不可能是 `model_unsupported`。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderPool, Router, NoRouteError } from '../upstream/pool.js';
import { memoryConfig } from '../app.js';
import { Logger } from '../core/logger.js';
import type { ProviderConfig, RelayConfig } from '../core/types.js';

const silent = new Logger('error', () => undefined);

function build(providers: ProviderConfig[]): { pool: ProviderPool; router: Router; config: RelayConfig } {
  const config = memoryConfig({ providers, clients: [], logLevel: 'error' });
  const pool = new ProviderPool(config, silent);
  return { pool, router: new Router(pool, config), config };
}

function base(id: string, models: string[] = ['m']): ProviderConfig {
  return { id, label: id, protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', models, priority: 1 };
}

function opts(config: RelayConfig, extra: { exclude?: Set<string>; requestedModel?: string } = {}) {
  return {
    requestedModel: extra.requestedModel ?? 'm',
    exclude: extra.exclude ?? new Set<string>(),
    tier: config.tiers.pro!,
    clientKind: 'script' as const,
    complexity: { level: 'simple' as const, score: 0, signals: [] as string[] },
  };
}

function kindOf(fn: () => unknown): NoRouteError {
  try {
    fn();
  } catch (err) {
    if (err instanceof NoRouteError) return err;
    throw err;
  }
  throw new Error('预期抛出 NoRouteError，但没有抛');
}

test('真·模型没人声明 → model_unsupported（只有这一种才该换模型名）', () => {
  const { router, config } = build([base('a', ['other'])]);
  const err = kindOf(() => router.route(opts(config)));
  assert.equal(err.kind, 'model_unsupported');
  assert.deepEqual(err.declared, [], '没有任何上游声明支持它');
});

test('全在熔断 → all_breaker_open，并且能读出根本失败原因', () => {
  const { pool, router, config } = build([base('a')]);
  const entry = pool.get('a')!;
  // 连续 5 次限流 → 达到默认阈值 5，熔断打开
  for (let i = 0; i < 5; i++) pool.noteFailure(entry, 'rate_limited', false);
  const err = kindOf(() => router.route(opts(config)));
  assert.equal(err.kind, 'all_breaker_open');
  assert.deepEqual(err.declared, ['a'], 'a 声明支持 m —— 它只是暂时挂了');
  assert.equal(err.rootCause, 'rate_limited', '根本原因是限流，不是模型不存在');
  assert.equal(err.openBreakers[0]!.consecutiveFailures, 5);
});

test('被人工摘除 → all_disabled（运营动作，不是上游故障）', () => {
  const { pool, router, config } = build([base('a')]);
  pool.setDisabled('a', true);
  const err = kindOf(() => router.route(opts(config)));
  assert.equal(err.kind, 'all_disabled');
  assert.deepEqual(err.declared, ['a']);
  assert.equal(err.disabledCount, 1);
});

test('声明了但本请求内被排除 → all_excluded，绝不许说成模型不存在', () => {
  const { router, config } = build([base('a')]);
  // 模拟：a 已在本请求内被判为供应商级致命错误，后续阶不再选它
  const err = kindOf(() => router.route(opts(config, { exclude: new Set(['a']) })));
  assert.equal(err.kind, 'all_excluded');
  assert.deepEqual(err.declared, ['a'], '确实有上游声明支持这个模型');
  assert.notEqual(err.kind, 'model_unsupported');
  assert.equal(err.rejected[0]!.why, 'fatal_error_this_request');
});

test('禁用 + 熔断同时存在 → mixed，两种原因都不丢', () => {
  const { pool, router, config } = build([base('a'), base('b', ['m'])]);
  pool.setDisabled('a', true);
  const entryB = pool.get('b')!;
  for (let i = 0; i < 5; i++) pool.noteFailure(entryB, 'upstream_timeout', false);
  const err = kindOf(() => router.route(opts(config)));
  assert.equal(err.kind, 'mixed');
  assert.equal(err.disabledCount, 1, '禁用的那个要计数');
  assert.equal(err.openBreakers.length, 1, '熔断的那个要计数');
  assert.deepEqual(err.declared, ['a', 'b']);
});
