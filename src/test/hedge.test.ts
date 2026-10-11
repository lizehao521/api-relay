/**
 * 双线路对冲（hedge）端到端测试。
 *
 * 目标特性：**任务完成率** —— 同一模型有两个上游时，主线路慢就并行备线路，
 * 谁先成功用谁；主线路在宽限内就成功/失败时行为与旧版一致（不多等、不冗余）。
 */
import { test } from 'node:test';
import { rmTmp } from './testcleanup.js';import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../app.js';
import { MockUpstream, type MockScenario } from '../mock/upstream.js';
import { Logger } from '../core/logger.js';
import { loadConfig } from '../core/config.js';

const silent = new Logger('error', () => undefined);

async function bootTwo(opts: { hedgeDelayMs: number; scenarioA?: MockScenario; scenarioB?: MockScenario; autoRetry?: number }): Promise<{ app: App; mockA: MockUpstream; mockB: MockUpstream; base: string; close: () => Promise<void> }> {
  const mockA = new MockUpstream({ port: 0, logger: silent, ...(opts.scenarioA ? { defaultScenario: opts.scenarioA } : {}) });
  const mockB = new MockUpstream({ port: 0, logger: silent, ...(opts.scenarioB ? { defaultScenario: opts.scenarioB } : {}) });
  const boundA = await mockA.listen();
  const boundB = await mockB.listen();
  const dir = mkdtempSync(join(tmpdir(), 'relay-hedge-'));
  const yaml = [
    'server:',
    '  host: 127.0.0.1',
    '  port: 0',
    '  adminToken: ""',
    '  hedgeDelayMs: ' + opts.hedgeDelayMs,
    'storage:',
    '  driver: sqlite',
    '  path: ' + JSON.stringify(join(dir, 'relay.db')),
    'logLevel: error',
    'providers:',
    '  - id: pa',
    '    label: primary',
    '    protocol: openai',
    '    baseUrl: ' + JSON.stringify(boundA.url),
    '    apiKey: "k"',
    '    models: [mock-small]',
    '    priority: 20',
    '    cost: { inputPerMTok: 1, outputPerMTok: 2 }',
    '  - id: pb',
    '    label: backup',
    '    protocol: openai',
    '    baseUrl: ' + JSON.stringify(boundB.url),
    '    apiKey: "k"',
    '    models: [mock-small]',
    '    priority: 10',
    '    cost: { inputPerMTok: 1, outputPerMTok: 2 }',
    'clients:',
    '  - id: pro',
    '    label: pro',
    '    key: "{ENV:RELAY_KEY_PRO}"',
    '    tier: pro',
    '    tenantId: t1',
    '    enabled: true',
    'lossReduction:',
    '  attribution:',
    '    autoRetry: ' + (opts.autoRetry ?? 0),
    '    backoffBaseMs: 5',
    '    backoffMaxMs: 30',
    '  meter:',
    '    batchSize: 1',
    '    flushIntervalMs: 20',
    ''
  ].join('\n');
  const configPath = join(dir, 'relay.yaml');
  writeFileSync(configPath, yaml, 'utf8');
  const config = loadConfig({ path: configPath, env: { RELAY_KEY_PRO: 'sk-pro-hedge' } as NodeJS.ProcessEnv });
  config.server.port = 0;
  const app = await createApp(config, silent);
  const bound = await app.start();
  return {
    app,
    mockA,
    mockB,
    base: bound.url,
    close: async () => {
      await app.shutdown();
      await mockA.close();
      await mockB.close();
      await rmTmp(dir);
    },
  };
}

const chatBody = (): string => JSON.stringify({ model: 'mock-small', messages: [{ role: 'user', content: '你好' }], stream: true });

test('hedge: 主线路慢 → 备线路先成功、请求提前完成、两条都被调用', async () => {
  const e = await bootTwo({ hedgeDelayMs: 300, scenarioA: { status: 200, ttfbDelayMs: 2000 } });
  try {
    const t0 = Date.now();
    const res = await fetch(e.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-hedge', 'content-type': 'application/json' },
      body: chatBody(),
    });
    const text = await res.text();
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 200);
    assert.ok(text.includes('data: [DONE]'), '成功流必须完整');
    assert.ok(e.mockA.received.length >= 1, '主线路应被发起');
    assert.ok(e.mockB.received.length >= 1, '宽限后应并发备线路（对冲生效）');
    assert.ok(elapsed < 1900, '备线路先成功应早于主线路 2000ms 的延迟（实际 ' + elapsed + 'ms）');
  } finally {
    await e.close();
  }
});

test('hedge: 主线路快 → 不发起备线路（不冗余调用）', async () => {
  const e = await bootTwo({ hedgeDelayMs: 2000 });
  try {
    const res = await fetch(e.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-hedge', 'content-type': 'application/json' },
      body: chatBody(),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.ok(text.includes('data: [DONE]'));
    assert.ok(e.mockA.received.length >= 1, '主线路应被发起');
    assert.equal(e.mockB.received.length, 0, '主线路够快时不应发起备线路');
  } finally {
    await e.close();
  }
});

test('hedge: 主线路宽限内快速失败 → 仍走旧的重试/换线（不是对冲）', async () => {
  const e = await bootTwo({
    hedgeDelayMs: 3000,
    autoRetry: 1,
    scenarioA: { status: 503, body: { error: { message: 'overloaded' } } },
  });
  try {
    const res = await fetch(e.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-hedge', 'content-type': 'application/json' },
      body: chatBody(),
    });
    const text = await res.text();
    assert.equal(res.status, 200, '快速失败应被旧的重试机制换到备线路救回');
    assert.ok(text.includes('data: [DONE]'));
    assert.ok(e.mockA.received.length >= 1);
    assert.ok(e.mockB.received.length >= 1, '应由重试（而非对冲）换到备线路');
  } finally {
    await e.close();
  }
});
test('hedge: 主线路后赢时，归属头指向真正服务的主线路（不是输家）', async () => {
  const e = await bootTwo({ hedgeDelayMs: 200, scenarioA: { status: 200, ttfbDelayMs: 600 }, scenarioB: { status: 200, ttfbDelayMs: 1500 } });
  try {
    const res = await fetch(e.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-hedge', 'content-type': 'application/json' },
      body: chatBody(),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.ok(e.mockA.received.length >= 1 && e.mockB.received.length >= 1, '两条都应被发起（对冲已开始）');
    assert.equal(res.headers.get('x-relay-upstream'), 'pa', '实际由主线路服务，归属头必须是 pa（审计 P1-1）');
    assert.ok(text.includes('data: [DONE]'));
  } finally {
    await e.close();
  }
});

test('hedge: 主线路宽限后真实失败 → 对冲接住，且主线路失败被记账', async () => {
  const e = await bootTwo({
    hedgeDelayMs: 200,
    autoRetry: 1,
    scenarioA: { status: 503, delayMs: 400, body: { error: { message: 'overloaded' } } },
    scenarioB: { status: 200, delayMs: 900 },
  });
  try {
    const res = await fetch(e.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-pro-hedge', 'content-type': 'application/json' },
      body: chatBody(),
    });
    const text = await res.text();
    assert.equal(res.status, 200, '备线路应接住主线路的失败');
    assert.ok(text.includes('data: [DONE]'));
    assert.equal(res.headers.get('x-relay-upstream'), 'pb');
    const prov = await fetch(e.base + '/admin/api/providers');
    assert.equal(prov.status, 200, 'admin providers 应可读（本机）');
    const pj = (await prov.json()) as { providers: { id: string; health: { totalFailures: number; consecutiveFailures: number } }[] };
    const pa = pj.providers.find((p) => p.id === 'pa')!;
    assert.ok(pa.health.totalFailures >= 1 || pa.health.consecutiveFailures >= 1, '主线路失败应被记录（审计 P2-3）');
  } finally {
    await e.close();
  }
});
