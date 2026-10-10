/**
 * 内部 Agent 系统单测：决策解析、KB 回写、并发保护。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KbStore } from '../kb/store.js';
import { AgentRunner, parseDecision, type AgentLlmCall } from '../agent/runner.js';

function tempKb(t: string): { store: KbStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), t));
  const store = new KbStore({ path: join(dir, 'kb.db'), chunkSize: 128, chunkOverlap: 16 });
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const quietLogger = { info() {}, warn() {}, error() {} } as never;

test('agent: parseDecision 解析标准 JSON', () => {
  const d = parseDecision(JSON.stringify({
    kind: 'iteration', summary: '建议加对冲', recommendation: '把 agnes 对冲阈值降到 12s',
    confidence: 0.8, evidence: ['agnes-cn 24h 失败率 32%'],
    kbNote: { title: 'agnes 对冲优化', content: 'agnes-cn 失败率高，对冲阈值 20s 偏保守，建议 12s' },
  }));
  assert.equal(d.kind, 'iteration');
  assert.equal(d.confidence, 0.8);
  assert.equal(d.kbNote?.title, 'agnes 对冲优化');
});

test('agent: parseDecision 容错前后杂字', () => {
  const raw = '分析结果如下：' + JSON.stringify({ kind: 'ops', summary: '上游熔断', recommendation: '检查 agnes', confidence: 0.9, evidence: ['breaker open'] }) + ' 以上';
  const d = parseDecision(raw);
  assert.equal(d.kind, 'ops');
  assert.deepEqual(d.evidence, ['breaker open']);
});

test('agent: 非法 JSON 抛错', () => {
  assert.throws(() => parseDecision('这不是 JSON'), /LLM 输出/);
});

test('agent: kind 非法时回退 none + confidence 夹紧', () => {
  const d = parseDecision(JSON.stringify({ kind: 'weird', summary: 'x', recommendation: '', confidence: 2, evidence: [] }));
  assert.equal(d.kind, 'none');
  assert.equal(d.confidence, 1);
});

test('agent: run 全链路（mock LLM + 真 KB 回写）', async () => {
  const { store, cleanup } = tempKb('agent-run');
  try {
    await store.init();
    store.createKb('kb-iter', '迭代知识');
    const llmCalls: unknown[] = [];
    const fakeLlm: AgentLlmCall = {
      async chat(messages, opts) {
        llmCalls.push({ n: messages.length, model: opts.model });
        return {
          content: JSON.stringify({
            kind: 'iteration', summary: '自动巡检发现：agnes 国际慢', recommendation: '考虑提高对冲阈值',
            confidence: 0.7, evidence: ['provider agnes avg 18s'],
            kbNote: { title: 'agnes 慢', content: 'agnes 国际线路平均 18s，建议对冲阈值 12s 而非 20s' },
          }),
          promptTokens: 500, completionTokens: 120,
        };
      },
    };
    const runner = new AgentRunner({
      config: { enabled: true, clientId: 'agent', model: 'agnes-2.0-flash', intervalMs: 0, autoWriteKb: true, kbId: 'kb-iter' },
      logger: quietLogger,
      llm: fakeLlm,
      context: { async collect() { return { overview: { total: 1 }, providers: [], recentEvents: [] }; } },
      kb: store,
    });
    const run = await runner.run('manual');
    assert.ok(run.ok, 'run 应成功');
    assert.equal(run.decision.kind, 'iteration');
    assert.equal(llmCalls.length, 1, 'LLM 被调一次');
    const docs = store.listDocs('kb-iter');
    assert.equal(docs.length, 1, 'KB 回写 1 篇');
    assert.equal(docs[0]!.title, 'agnes 慢');
    assert.equal(runner.runs().length, 1);
  } finally {
    store.close();
    cleanup();
  }
});

test('agent: LLM 输出坏 JSON 时 ok=false 且不写 KB', async () => {
  const { store, cleanup } = tempKb('agent-bad');
  try {
    await store.init();
    store.createKb('kb-bad', '迭代知识');
    const fakeLlm: AgentLlmCall = {
      async chat() {
        return { content: '这是一段散文，不是 JSON', promptTokens: 100, completionTokens: 50 };
      },
    };
    const runner = new AgentRunner({
      config: { enabled: true, clientId: 'agent', model: 'x', intervalMs: 0, autoWriteKb: true, kbId: 'kb-bad' },
      logger: quietLogger,
      llm: fakeLlm,
      context: { async collect() { return { overview: {}, providers: [], recentEvents: [] }; } },
      kb: store,
    });
    const run = await runner.run('manual');
    assert.equal(run.ok, false, '坏 JSON → ok=false');
    assert.ok(run.error?.includes('llm_parse_failed'));
    assert.equal(store.listDocs('kb-bad').length, 0, '解析失败不写 KB');
  } finally {
    store.close();
    cleanup();
  }
});

test('agent: 并发保护（第二轮回 already_running）', async () => {
  let slowResolve: (() => void) | undefined;
  const gate = new Promise<void>((r) => { slowResolve = r; });
  const fakeLlm: AgentLlmCall = {
    async chat() {
      await gate;
      return { content: JSON.stringify({ kind: 'none', summary: 'x', recommendation: '', confidence: 0.5, evidence: [] }), promptTokens: 1, completionTokens: 1 };
    },
  };
  const runner = new AgentRunner({
    config: { enabled: true, clientId: 'a', model: 'x', intervalMs: 0 },
    logger: quietLogger,
    llm: fakeLlm,
    context: { async collect() { return { overview: {}, providers: [], recentEvents: [] }; } },
  });
  const p1 = runner.run('manual');
  const p2 = runner.run('manual'); // 第一轮还在跑（LLM 被 gate 卡住）→ 第二轮 already_running
  // 先等第二轮（它同步快速返回 already_running），再放开 gate 让第一轮完成
  const r2 = await p2;
  assert.equal(r2.error, 'already_running', '第二轮应被拒');
  slowResolve?.();
  const r1 = await p1;
  assert.ok(r1.ok, '第一轮正常完成');
});
