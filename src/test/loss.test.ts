/** P8 度量 / P5 轨迹 / P6 缓存 / P4-lite 指纹 的单测。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { renderSummary, computeCost, normalizeUsage, transcriptFromSse } from '../loss/meter.js';
import { TraceBuilder, TraceStore, diffTraces, renderTrace } from '../loss/tracer.js';
import { computeFingerprint, isAgent, upgradeHint } from '../loss/fingerprint.js';
import { BoundedCache, RingBuffer, SlidingWindowCounter, estimateTokens, backoffDelay, percentile } from '../util/index.js';
import { MemoryStore } from '../store/index.js';
import { h2Fetch, closeH2Sessions, h2Feasible, h2ConnectOrigin, markH2BrokenForTest } from '../upstream/http2.js';
import { resolveTrusted, setTrustedServersForTest, seedTrustedCacheForTest, clearTrustedCache } from '../upstream/dns.js';
import { Meter } from '../loss/meter.js';
import type { MeterRecord, RelayRequestContext, TraceRecord, UsageBreakdown } from '../core/types.js';

/* ------------------------------------------------------------------ *
 * 计费与 usage 归一化
 * ------------------------------------------------------------------ */

test('normalizeUsage 兼容多上游字段（含 DeepSeek 的 prompt_cache_hit_tokens）', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });
  const ds = normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 80 });
  assert.equal(ds!.cachedPromptTokens, 80);
  const oai = normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 64 } });
  assert.equal(oai!.cachedPromptTokens, 64);
  assert.equal(normalizeUsage({}), undefined);
  assert.equal(normalizeUsage(null), undefined);
});

test('computeCost 对缓存命中输入按缓存价计费', () => {
  const usage: UsageBreakdown = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500, cachedPromptTokens: 800 };
  const cost = computeCost(usage, { inputPerMTok: 2, outputPerMTok: 8, cachedInputPerMTok: 0.5 });
  // 未缓存输入 200 → 200/1e6*2 = 0.0004；缓存 800 → 800/1e6*0.5 = 0.0004；输出 500 → 500/1e6*8 = 0.004
  assert.equal(cost, 0.0048);
  assert.equal(computeCost(usage, undefined), 0);
  assert.equal(computeCost(undefined, { inputPerMTok: 1, outputPerMTok: 1 }), 0);
});

/* ------------------------------------------------------------------ *
 * SSE → 符号态（P8 的输入面）
 * ------------------------------------------------------------------ */

test('transcriptFromSse 重建内容字符数、tool_calls 分片与 usage', () => {
  const frames = [
    JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { content: '世界' }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/a"}' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 } }),
    '[DONE]',
  ];
  const t = transcriptFromSse(frames);
  assert.equal(t.contentChars, 4);
  assert.equal(t.finishReason, 'tool_calls');
  assert.equal(t.sawDone, true);
  assert.equal(t.chunkCount, 7);
  assert.equal(t.toolCalls!.length, 1);
  assert.equal(t.toolCalls![0]!.name, 'read_file');
  assert.ok(t.toolCalls![0]!.argumentBytes > 10);
  assert.equal(t.usage!.totalTokens, 59);
});

test('transcriptFromSse 识别流中途的错误帧（HTTP 200 + data:{"error":...}）', () => {
  const t = transcriptFromSse([JSON.stringify({ error: { message: 'upstream blew up mid-stream', code: 500 } })]);
  assert.ok(t.streamError?.includes('blew up'));
});

test('transcriptFromSse 统计畸形帧而不是静默吞掉', () => {
  const t = transcriptFromSse(['{not json', JSON.stringify({ choices: [] })]);
  assert.equal(t.malformedFrames, 1);
});

/* ------------------------------------------------------------------ *
 * 度量聚合与降损收益口径
 * ------------------------------------------------------------------ */

function mkRecord(patch: Partial<MeterRecord> = {}): MeterRecord {
  return {
    traceId: 'tr_1',
    requestId: 'req_1',
    ts: Date.now(),
    keyId: 'k1',
    tenantId: 't1',
    tier: 'pro',
    clientKind: 'agent',
    agentScore: 0.7,
    model: 'm',
    providerId: 'p1',
    stream: false,
    toolCalling: true,
    outcome: 'success',
    httpStatus: 200,
    durationMs: 120,
    ttfbMs: 40,
    bytesIn: 1000,
    bytesOut: 2000,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    cachedPromptTokens: 0,
    costCny: 0.001,
    listCostCny: 0.001,
    attemptCount: 1,
    failureReason: null,
    quickAction: null,
    recoverable: null,
    precheckViolations: 0,
    precheckBlocked: false,
    precheckDegraded: false,
    precheckUs: 30,
    classifyUs: 0,
    attributionDelivered: false,
    duplicateInWindow: 1,
    ...patch,
  };
}

test('Meter.summarize 的降损收益口径可计算且自洽', () => {
  const store = new MemoryStore();
  const meter = new Meter({ store, enabled: true, hashPayloads: true });
  store.record(mkRecord({ outcome: 'success', attemptCount: 2, durationMs: 100 }));
  store.record(
    mkRecord({
      outcome: 'upstream_error',
      failureReason: 'rate_limited',
      quickAction: 'retry_with_backoff',
      recoverable: true,
      attributionDelivered: true,
      httpStatus: 429,
      durationMs: 200,
      duplicateInWindow: 2,
    }),
  );
  store.record(
    mkRecord({
      outcome: 'upstream_error',
      failureReason: 'auth_invalid',
      quickAction: 'fix_credentials',
      recoverable: false,
      attributionDelivered: true,
      httpStatus: 401,
      durationMs: 50,
      precheckBlocked: true,
      precheckViolations: 2,
    }),
  );

  const s = meter.summarize(3_600_000);
  assert.equal(s.overall.requests, 3);
  assert.equal(s.overall.errors, 2);
  assert.equal(s.overall.totalTokens, 450);
  // 归因投递率 = 2/2
  assert.equal(s.lossReduction.attributionCoverage, 1);
  // 自动恢复 = 重试后成功（attemptCount=2 且 success）
  assert.equal(s.lossReduction.autoRecovered, 1);
  assert.equal(s.lossReduction.duplicateRetries, 1);
  assert.equal(s.lossReduction.precheckBlocked, 1);
  assert.equal(s.lossReduction.precheckDegraded, 0);
  assert.ok(s.byFailureReason.find((r) => r.reason === 'rate_limited')?.count === 1);
  assert.ok(s.byQuickAction.find((a) => a.action === 'retry_with_backoff')?.count === 1);
  assert.equal(s.byProvider[0]!.key, 'p1');
});

test('Meter 的归因投递率为 0 时暴露「错误不可执行」的运营问题', () => {
  const store = new MemoryStore();
  const meter = new Meter({ store, enabled: true, hashPayloads: true });
  store.record(mkRecord({ outcome: 'upstream_error', failureReason: 'unknown', attributionDelivered: false }));
  const s = meter.summarize(3_600_000);
  assert.equal(s.lossReduction.attributionCoverage, 0);
});

test('renderSummary 输出包含所有可行动口径', () => {
  const store = new MemoryStore();
  const meter = new Meter({ store, enabled: true, hashPayloads: true });
  store.record(mkRecord());
  const text = renderSummary(meter.summarize(3_600_000), { windowLabel: '1h' });
  for (const keyword of ['归因投递率', '自动恢复', '重复请求', '预检拦截', '预检降级放行', '降损层开销占比']) {
    assert.ok(text.includes(keyword), `报告缺少 ${keyword}`);
  }
});

test('Meter 在 store 抛异常时 fail-open（度量挂了不影响转发）', () => {
  const broken = new MemoryStore();
  broken.record = () => {
    throw new Error('disk on fire');
  };
  const meter = new Meter({ store: broken, enabled: true, hashPayloads: true });
  const ctx = {
    requestId: 'r',
    startedAt: Date.now(),
    traceId: 't',
    method: 'POST',
    path: '/v1/chat/completions',
    client: { keyId: 'k', keyLabel: 'k', tier: 'pro', tenantId: 't' },
    fingerprint: { kind: 'agent', agentScore: 1, features: { hasToolCalls: true, hasTools: true, multiTurn: true, roleAlternation: 2, systemPromptHash: '', streamRequested: false, jsonMode: false }, ruleVersion: 1 },
    requestedModel: 'm',
    stream: false,
    payloadHash: 'h',
    payloadBytes: 1,
    isToolCalling: true,
    routes: [],
    bytesIn: 1,
    bytesOut: 1,
    durationMs: 1,
    overheadUs: { precheck: 0, classify: 0, meter: 0 },
    outcome: 'success',
  } as unknown as RelayRequestContext;
  assert.doesNotThrow(() => meter.record(ctx, ctx.fingerprint, 1));
  assert.ok(meter.snapshot().lastError?.includes('disk on fire'));
});

/* ------------------------------------------------------------------ *
 * P5 轨迹
 * ------------------------------------------------------------------ */

test('TraceBuilder 记录步骤、首次失败阶段与总耗时', () => {
  const builder = new TraceBuilder('tr_x', 'req_x', Date.now(), 32, true);
  builder.step('auth', true, 'ok');
  builder.fail('route', '没有可用上游', { candidates: 'a|b' });
  builder.step('respond', false, 'HTTP 503');
  const ctx = { outcome: 'client_error' } as RelayRequestContext;
  const trace = builder.finish(ctx);
  assert.equal(trace.steps.length, 3);
  assert.equal(trace.failedAtStage, 'route');
  assert.equal(trace.outcome, 'client_error');
  assert.ok(trace.durationMs >= 0);
});

test('TraceBuilder 遵守 maxSteps 上限（轨迹本身不能变成新的原始载荷）', () => {
  const builder = new TraceBuilder('tr', 'req', Date.now(), 3, true);
  for (let i = 0; i < 10; i++) builder.step('meter', true, `s${i}`);
  assert.equal(builder.finish({ outcome: 'success' } as RelayRequestContext).steps.length, 3);
});

test('TraceBuilder 在 disabled 时不记录任何步骤', () => {
  const builder = new TraceBuilder('tr', 'req', Date.now(), 32, false);
  builder.step('auth', true, 'ok');
  assert.equal(builder.stepCount, 0);
});

test('renderTrace 输出可读时间线', () => {
  const builder = new TraceBuilder('tr_abc', 'req_1', Date.now(), 32, true);
  builder.step('auth', true, 'key=k1 tier=pro');
  builder.fail('upstream_response', 'HTTP 429');
  const text = renderTrace(builder.finish({ outcome: 'upstream_error' } as RelayRequestContext));
  assert.ok(text.includes('tr_abc'));
  assert.ok(text.includes('upstream_response'));
  assert.ok(text.includes('FAIL'));
});

test('diffTraces 定位两次请求的分歧点（复盘两次失败）', () => {
  const a: TraceRecord = {
    traceId: 'a',
    requestId: 'r1',
    startedAt: 0,
    durationMs: 100,
    outcome: 'upstream_error',
    failedAtStage: 'upstream_response',
    steps: [
      { stage: 'auth', at: 0, offsetMs: 0, ok: true, summary: 'ok' },
      { stage: 'route', at: 1, offsetMs: 1, ok: true, summary: '→ p1' },
      { stage: 'upstream_response', at: 2, offsetMs: 2, ok: false, summary: 'HTTP 429' },
    ],
  };
  const b: TraceRecord = { ...a, traceId: 'b', durationMs: 40, outcome: 'success', failedAtStage: undefined, steps: [
    { stage: 'auth', at: 0, offsetMs: 0, ok: true, summary: 'ok' },
    { stage: 'route', at: 1, offsetMs: 1, ok: true, summary: '→ p2' },
    { stage: 'upstream_response', at: 2, offsetMs: 2, ok: true, summary: 'HTTP 200' },
  ] };
  const diff = diffTraces(a, b);
  assert.equal(diff.durationDeltaMs, -60);
  assert.equal(diff.sameOutcome, false);
  assert.ok(diff.diverged.some((d) => d.stage === 'route'));
  assert.ok(diff.diverged.some((d) => d.stage === 'upstream_response'));
});

test('TraceStore 环形缓冲保留最近 N 条且可持久化', () => {
  const saved: TraceRecord[] = [];
  // TraceStore 对环大小有 10 的下限保护（生产上小于 10 条轨迹没有排障价值）
  const store = new TraceStore(50, (t) => saved.push(t));
  for (let i = 0; i < 60; i++) {
    store.save({ traceId: `t${i}`, requestId: `r${i}`, startedAt: i, durationMs: 1, steps: [], outcome: 'success' });
  }
  assert.equal(store.size(), 50);
  const recent = store.recent(3).map((t) => t.traceId);
  assert.deepEqual(recent, ['t59', 't58', 't57']);
  assert.equal(saved.length, 60, '持久化不该被环形缓冲限制');
});

test('RingBuffer 未满时不会把空槽当成数据返回（number 场景）', () => {
  const r = new RingBuffer<number>(4);
  r.push(7);
  assert.deepEqual(r.toArray(), [7]);
  r.push(8);
  assert.deepEqual(r.toArray(), [8, 7]);
});

/* ------------------------------------------------------------------ *
 * P4-lite 无状态指纹
 * ------------------------------------------------------------------ */

test('指纹：带 tool_calls 历史的 Agent 请求得分显著高于普通聊天', () => {
  const agent = computeFingerprint({
    salt: 's',
    headers: { 'user-agent': 'openai-python/1.0' },
    body: {
      model: 'm',
      messages: [
        { role: 'system', content: 'You are a coding assistant with available tools.' },
        { role: 'user', content: '读文件' },
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '内容' },
        { role: 'assistant', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'write', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c2', content: 'ok' },
      ],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
      parallel_tool_calls: true,
    },
  });
  const chat = computeFingerprint({
    salt: 's',
    headers: { 'user-agent': 'curl/8' },
    body: { model: 'm', messages: [{ role: 'user', content: '你好' }] },
  });
  assert.ok(agent.agentScore > chat.agentScore);
  assert.equal(agent.kind, 'agent');
  assert.ok(isAgent(agent, 0.6));
  assert.equal(isAgent(chat, 0.6), false);
  assert.ok(upgradeHint(agent, 0.6)!.includes('Pro'));
});

test('指纹只输出 system prompt 的 HMAC 前缀，不泄漏正文', () => {
  const secret = '这是一段很长的系统提示词，包含业务机密';
  const fp = computeFingerprint({ salt: 'k', body: { messages: [{ role: 'system', content: secret }] } });
  assert.equal(fp.features.systemPromptHash.length, 16);
  assert.ok(!JSON.stringify(fp).includes(secret));
  // 同盐同输入稳定；换盐则变化（防字典反推）
  const again = computeFingerprint({ salt: 'k', body: { messages: [{ role: 'system', content: secret }] } });
  assert.equal(fp.features.systemPromptHash, again.features.systemPromptHash);
  const other = computeFingerprint({ salt: 'k2', body: { messages: [{ role: 'system', content: secret }] } });
  assert.notEqual(fp.features.systemPromptHash, other.features.systemPromptHash);
});

test('指纹规则版本号存在（指标口径可演进）', () => {
  const fp = computeFingerprint({ salt: 's', body: { messages: [] } });
  assert.ok(fp.ruleVersion >= 1);
});

/* ------------------------------------------------------------------ *
 * P6 缓存与工具类
 * ------------------------------------------------------------------ */

test('BoundedCache 有界、LRU、统计命中率', () => {
  const c = new BoundedCache<number>(2);
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.get('a'), 1);
  c.set('c', 3); // 淘汰 b（a 因刚被访问而保留）
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 1);
  const s = c.stats();
  assert.equal(s.size, 2);
  assert.ok(s.hits >= 2);
  assert.ok(s.misses >= 1);
});

test('RingBuffer 由新到旧返回且容量固定', () => {
  const r = new RingBuffer<number>(3);
  for (let i = 1; i <= 5; i++) r.push(i);
  assert.deepEqual(r.toArray(), [5, 4, 3]);
  assert.equal(r.size, 3);
});

test('SlidingWindowCounter 正确淘汰过期桶', () => {
  const c = new SlidingWindowCounter(1000);
  assert.equal(c.hit('k', 0), 1);
  assert.equal(c.hit('k', 10), 2);
  assert.equal(c.hit('k', 1500), 1, '窗口外的旧记录应被淘汰');
});

test('estimateTokens 对中英文给出量级正确的估算', () => {
  assert.ok(estimateTokens('hello world') >= 2 && estimateTokens('hello world') <= 5);
  const zh = estimateTokens('你好世界你好世界');
  assert.ok(zh >= 4 && zh <= 10, `中文估算异常: ${zh}`);
  assert.equal(estimateTokens(''), 0);
});

test('backoffDelay 有上界且随重试次数增长', () => {
  const d0 = backoffDelay(0, 100, 1000);
  const d3 = backoffDelay(3, 100, 1000);
  assert.ok(d0 <= 1000 && d3 <= 1000);
  assert.ok(d3 >= d0);
});

test('percentile 处理空数组与边界', () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
});

/* ------------------------------------------------------------------ *
 * 零 token 守卫：成功却没记到 token 必须自己冒出来
 * ------------------------------------------------------------------ */

/** 造一个最小的"成功但零 token"上下文 */
function zeroTokenCtx(over: Partial<RelayRequestContext> = {}): RelayRequestContext {
  return {
    requestId: 'req_zero_token',
    traceId: 'tr_zero_token',
    startedAt: Date.now(),
    durationMs: 12,
    ttfbMs: 6,
    httpStatus: 200,
    outcome: 'success',
    stream: true,
    bytesIn: 4096,
    bytesOut: 8192,
    requestedModel: 'mock-small',
    client: { keyId: 'k_zero', tenantId: 't', tier: 'pro' },
    routes: [{ providerId: 'p' }],
    overheadUs: { precheck: 0, classify: 0, meter: 0 },
    usage: undefined,
    ...over,
  } as unknown as RelayRequestContext;
}

const anyFingerprint = { kind: 'unknown', agentScore: 0, features: {} } as never;

test('零 token 守卫：成功请求却零 token 会写 meter.zero_token 事件（静默少记必须可见）', () => {
  const store = new MemoryStore();
  const meter = new Meter({ store, enabled: true, hashPayloads: false });
  meter.record(zeroTokenCtx(), anyFingerprint, 1);
  const kinds = store.listEvents(10).map((e) => String(e['kind']));
  assert.ok(kinds.includes('meter.zero_token'), '成功但零 token 必须留下事件，否则少记永远查不出来');
  assert.equal(meter.snapshot().zeroTokenCount, 1);
});

test('零 token 守卫：正常记到 token 时不误报；没产出内容时也不报', () => {
  const store = new MemoryStore();
  const meter = new Meter({ store, enabled: true, hashPayloads: false });
  // ① 有 usage → 不该报
  meter.record(zeroTokenCtx({ usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }), anyFingerprint, 1);
  // ② 零 token 但也没产出内容（空响应）→ 不该报
  meter.record(zeroTokenCtx({ bytesOut: 0 }), anyFingerprint, 1);
  const kinds = store.listEvents(10).map((e) => String(e['kind']));
  assert.ok(!kinds.includes('meter.zero_token'), '这两条都不该触发零 token 事件');
  assert.equal(meter.snapshot().zeroTokenCount, 0);
});

/* ------------------------------------------------------------------ *
 * 上游 HTTP/2 通道（Agnes 的 h1.1 路径实测慢且抖，靠 h2 绕开）
 * ------------------------------------------------------------------ */

test('h2Fetch：能用 HTTP/2 发请求、收到响应头与流式响应体', async () => {
  const server = createHttp2Server();
  server.on('stream', (stream, headers) => {
    assert.equal(headers[':method'], 'POST');
    assert.equal(headers[':path'], '/v1/chat/completions');
    stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
    stream.write('data: {"a":1}\n\n');
    stream.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await h2Fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"x":1}',
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const text = await res.text();
    assert.ok(text.includes('data: [DONE]'), '响应体必须是完整读完的');
    // 注意：不能用 headers.get(':status') 来验 —— Headers 对伪头会**抛异常**而不是返回 null。
    // 遍历更准确：伪头根本不该出现在普通头里。
    for (const [k] of res.headers) assert.ok(!k.startsWith(':'), `伪头不能混进普通响应头：${k}`);
  } finally {
    closeH2Sessions();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('h2Fetch：上游返回非 2xx 时状态码与头照样透出来（错误路径不能吞）', async () => {
  const server = createHttp2Server();
  server.on('stream', (stream) => {
    stream.respond({ ':status': 429, 'content-type': 'application/json', 'retry-after': '3' });
    stream.end(JSON.stringify({ error: { message: 'rate limited' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await h2Fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { headers: {}, body: '{}' });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '3');
    assert.ok((await res.text()).includes('rate limited'));
  } finally {
    closeH2Sessions();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('h2Fetch + connectIp：按给定 IP 建连（域名根本解析不了也能通）', async () => {
  const server = createHttp2Server();
  server.on('stream', (stream, headers) => {
    // :authority 仍应是**真域名**，不是 IP —— 否则上游的虚拟主机路由会走错
    assert.equal(headers[':authority'], 'agnes.test:' + (server.address() as AddressInfo).port);
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    stream.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    // 故意用一个解析不了的域名；端口用服务器真实端口，验证 connectIp 不会把端口丢掉
    const res = await h2Fetch(`http://agnes.test:${port}/v1/chat/completions`, {
      headers: {},
      body: '{}',
      connectIp: '127.0.0.1',
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"ok":true}');
  } finally {
    closeH2Sessions();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('h2 不可用标记：必须带 TTL，且键要含端口（否则非 443 永远打不中）', () => {
  const origin = 'https://203.0.113.9:8443';
  markH2BrokenForTest(origin);
  // 立刻：不可用（不去白试）
  assert.equal(h2Feasible(origin), false);
  // 5 分钟内仍然不可用
  assert.equal(h2Feasible(origin, undefined, Date.now() + 4 * 60_000), false);
  // 超过 TTL：放行，重新给 h2 一次机会。
  // （老实现是个只增不减的 Set → 一次瞬时握手失败会让这条上游在本进程余生永久降级到
  //   h1.1 慢路，而且降级后连 DNS 污染保护都没了 —— 审计 P1-4）
  assert.equal(h2Feasible(origin, undefined, Date.now() + 6 * 60_000), true);

  // 键必须含端口：标记 8443 不能让 9443 跟着不可用
  markH2BrokenForTest('https://203.0.113.9:9443');
  assert.equal(h2Feasible('https://203.0.113.9:9443'), false);
  assert.equal(h2Feasible('https://203.0.113.9:1234'), true, '不同端口是不同上游，不能连坐');

  // 带 servername（按 IP 建连）时键要区分
  markH2BrokenForTest('https://203.0.113.9', 'api.example.com');
  assert.equal(h2Feasible('https://203.0.113.9', 'api.example.com'), false);
  assert.equal(h2Feasible('https://203.0.113.9', 'other.example.com'), true, '不同域名不能连坐');

  // 构造点与 h2Fetch 内部必须一致
  assert.deepEqual(h2ConnectOrigin('https://api.example.com/v1/x', '203.0.113.9'), {
    origin: 'https://203.0.113.9',
    servername: 'api.example.com',
  });
  assert.deepEqual(h2ConnectOrigin('https://api.example.com:8443/v1/x', '203.0.113.9'), {
    origin: 'https://203.0.113.9:8443',
    servername: 'api.example.com',
  });
});

test('h2 会话池：并发冷启动只建一条会话（不能 10 并发建 10 条）', async () => {
  let sessionCount = 0;
  // 把会话对象都记下来：断言失败时 finally 里要能**销毁**它们。
  // 否则 server.close() 会一直等那些孤儿会话 → 测试不是失败而是**挂住**，
  // 整个测试套件被拖死（2026-09-14 验牙时踩到）。
  const seenSessions: unknown[] = [];
  const server = createHttp2Server();
  server.on('session', (s) => {
    sessionCount += 1;
    seenSessions.push(s);
  });
  server.on('stream', (stream) => {
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    stream.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    // 10 个并发（审计 P1-5 的探针形态）
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        h2Fetch(`http://127.0.0.1:${port}/v1/x`, { headers: {}, body: '{}' }).then((r) => r.status),
      ),
    );
    assert.deepEqual(results, Array(10).fill(200));
    assert.equal(sessionCount, 1, `10 个并发应当复用同一条会话，实际建了 ${sessionCount} 条`);
  } finally {
    closeH2Sessions();
    // 断言失败时也要能干净收场：把这条测试自己建的会话全销毁，
    // 否则 server.close() 会等那些孤儿会话 → 测试变成**挂住**而不是失败。
    for (const s of seenSessions) {
      try {
        (s as { destroy: () => void }).destroy();
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('可信 DNS：解析器抖动时用上次的好 IP（stale-if-error），不许掉回系统解析器', async () => {
  // 注意顺序：setTrustedServersForTest 会清空缓存，必须先切解析器、再种缓存
  setTrustedServersForTest(['127.0.0.1:1']);
  seedTrustedCacheForTest('api.example.test', '203.0.113.7');
  try {
    // 缓存新鲜时：直接命中
    assert.equal(await resolveTrusted('api.example.test'), '203.0.113.7');
    // 缓存过期 + 解析失败（61 秒后，TTL 60 秒）：
    // 老代码返回 undefined → client 掉回系统解析器（被 114 污染的那条路）；
    // 现在返回**上次的好 IP** —— 真实 IP 变了顶多错一小段时间，好过挂 90 秒。
    const t = Date.now() + 61_000;
    assert.equal(await resolveTrusted('api.example.test', t), '203.0.113.7', 'stale-if-error：失败时用旧 IP 续命');
    // 从没解析成功过的域名：失败就失败，不该有魔法
    assert.equal(await resolveTrusted('never-seen.test', t), undefined);
  } finally {
    clearTrustedCache();
  }
});

test('usage 变体：Anthropic 风格与"只有 total_tokens"都必须能计价（不能成本恒 0）', () => {
  // Anthropic 风格：input_tokens / output_tokens
  const anth = normalizeUsage({ input_tokens: 1000, output_tokens: 200 });
  assert.equal(anth?.promptTokens, 1000);
  assert.equal(anth?.completionTokens, 200);
  assert.equal(anth?.totalTokens, 1200);
  // OpenAI 风格照旧
  const oai = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 });
  assert.equal(oai?.promptTokens, 1000);
  // 只有 total_tokens：归一化照常，计价按"全输入价"保守估算，**不为 0**
  const tot = normalizeUsage({ total_tokens: 1000 });
  assert.equal(tot?.totalTokens, 1000);
  const cost = { inputPerMTok: 10, outputPerMTok: 20, cachedInputPerMTok: 1 };
  assert.ok(computeCost(tot, cost) > 0, '只有 total_tokens 时成本不能为 0（否则 ¥ 预算闸门静默失效）');
  assert.equal(computeCost(tot, cost), (1000 / 1_000_000) * 10);
  // 什么都不给 → undefined / 0
  assert.equal(normalizeUsage({}), undefined);
  assert.equal(computeCost(undefined, cost), 0);
});
