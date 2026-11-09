/**
 * 图片生成端点（/v1/images/generations）测试。
 *
 * 守三件事：
 *   1. 转发路径与请求体不被改写（成功响应零改写契约同样适用于图片）；
 *   2. 按"张"计费：costCny = 响应 data 实际条数 × perImageCny；
 *   3. 按张扣的那笔钱直接进额度闸 —— 预算用尽后同一把 key 收到 402。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, memoryConfig, type App } from '../app.js';
import { MockUpstream } from '../mock/upstream.js';
import { Logger } from '../core/logger.js';
import type { ClientKeyConfig, ProviderConfig } from '../core/types.js';

const silent = new Logger('error', () => undefined);

interface Harness {
  app: App;
  mock: MockUpstream;
  close: () => Promise<void>;
}

async function harness(opts: { perImageCny?: number; quotaCny?: number } = {}): Promise<Harness> {
  const mock = new MockUpstream({ port: 0, logger: silent });
  const bound = await mock.listen();
  const providers: ProviderConfig[] = [
    {
      id: 'img',
      label: '图片上游',
      protocol: 'openai',
      baseUrl: bound.url,
      apiKey: 'mock',
      models: ['mock-image'],
      priority: 10,
      weight: 1,
      modelCosts: {
        'mock-image': { inputPerMTok: 0, outputPerMTok: 0, perImageCny: opts.perImageCny ?? 0.25 },
      },
    },
  ];
  const clients: ClientKeyConfig[] = [
    {
      id: 'img-key',
      label: 'img',
      key: 'sk-img-test',
      tier: 'pro',
      tenantId: 't',
      enabled: true,
      ...(opts.quotaCny !== undefined ? { quotaCny: opts.quotaCny } : {}),
    },
  ];
  const app = await createApp(memoryConfig({ providers, clients, logLevel: 'error' }), silent);
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
  path = '/v1/images/generations',
): Promise<{ status: number; json: any; text: string }> {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const result = await app.engine.handle({
    method: 'POST',
    path,
    headers: { authorization: 'Bearer sk-img-test', 'content-type': 'application/json' },
    rawBody: new Uint8Array(raw),
    signal: new AbortController().signal,
    requestId: `req_img${++seq}`,
  });
  if (result.kind !== 'json') throw new Error('期望非流式结果');
  let json: unknown;
  try {
    json = JSON.parse(result.body);
  } catch {
    json = undefined;
  }
  return { status: result.status, json, text: result.body };
}

test('图片端点：拼出 baseUrl+/images/generations，成功响应字节级透传且不注入 stream_options', async () => {
  const h = await harness();
  const fixed = JSON.stringify({ created: 1, data: [{ url: 'https://cdn.local/a.png' }] });
  h.mock.queueScenarios('mock-image', [{ status: 200, body: fixed }]);
  try {
    const r = await call(h.app, { model: 'mock-image', prompt: '一只在窗台晒太阳的猫', n: 1, size: '1024x1024' });
    assert.equal(r.status, 200);
    assert.equal(r.text, fixed);
    const seen = h.mock.received[0];
    assert.ok(seen, '上游必须收到请求');
    assert.equal(seen.path, '/v1/images/generations');
    const sent = seen.body as Record<string, unknown>;
    assert.equal(sent['prompt'], '一只在窗台晒太阳的猫');
    assert.equal(sent['size'], '1024x1024');
    assert.equal(sent['stream_options'], undefined, '图片端点不能注入 stream_options');
  } finally {
    await h.close();
  }
});

test('图片按张计费：costCny = 响应 data 条数 × perImageCny（不看请求里的 n）', async () => {
  const h = await harness({ perImageCny: 0.25 });
  h.mock.queueScenarios('mock-image', [
    { status: 200, body: { created: 1, data: [{ url: 'a' }, { url: 'b' }, { url: 'c' }] } },
  ]);
  try {
    const r = await call(h.app, { model: 'mock-image', prompt: 'x', n: 5 });
    assert.equal(r.status, 200);
    const rec = h.app.store.recordsSince(0).find((x) => x.model === 'mock-image');
    assert.ok(rec, '必须有一条度量记录');
    assert.equal(rec.costCny, 0.75);
    assert.equal(rec.totalTokens, 0);
  } finally {
    await h.close();
  }
});

test('图片按张扣预算：预算用尽后同一把 key 收到 402 quota_exhausted', async () => {
  const h = await harness({ perImageCny: 0.3, quotaCny: 0.5 });
  try {
    const first = await call(h.app, { model: 'mock-image', prompt: 'x', n: 2 });
    assert.equal(first.status, 200);
    assert.equal((first.json as { data: unknown[] }).data.length, 2);

    const second = await call(h.app, { model: 'mock-image', prompt: 'y', n: 1 });
    assert.equal(second.status, 402);
    assert.equal((second.json as { error: { code: string } }).error.code, 'quota_exhausted');
    assert.equal(h.mock.count, 1, '超额请求不能打到上游');
  } finally {
    await h.close();
  }
});

test('HTTP 层：根路由列出图片端点，未支持端点仍 404', async () => {
  const h = await harness();
  try {
    const bound = await h.app.start();
    const root = (await (await fetch(`${bound.url}/`)).json()) as { endpoints: Record<string, string> };
    assert.equal(root.endpoints['images'], 'POST /v1/images/generations');

    const ok = await fetch(`${bound.url}/v1/images/generations`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-img-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-image', prompt: 'x', n: 2 }),
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { data: unknown[] };
    assert.equal(body.data.length, 2);

    const edits = await fetch(`${bound.url}/v1/images/edits`, { method: 'POST' });
    assert.equal(edits.status, 404);
    const ej = (await edits.json()) as { error: { message: string } };
    assert.match(ej.error.message, /\/v1\/images\/generations/);
  } finally {
    await h.close();
  }
});
