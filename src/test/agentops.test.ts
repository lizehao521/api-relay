/**
 * 运营 Agent（平台规则 Agent）台架测试：
 * - runtime：tool_calls 执行循环、未知工具容错、needApproval 挂起（fail-closed）
 * - 出口闸门：内网/保留/元数据/绕过形态拒绝，公网放行
 * - httpTool：GET 免审执行、写操作未批不执行、批准后执行
 * - AgentDb / ApprovalCenter：持久化往返、裁决、超时置 expired
 * - AgentOps 组合层：chat 编排（假 LLM 假 fetch，零真实网络）、审批执行回填
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime, type AgentPendingApproval } from '../agent/runtime.js';
import type { AgentTool, AgentToolCall } from '../agent/types.js';
import type { AgentLlmCall } from '../agent/llm.js';
import { gateEgress, isBlockedAddress, normalizeIpv4, createHttpTool } from '../agent/tools/httpTool.js';
import { AgentDb, type StoredApproval } from '../agent/session.js';
import { ApprovalCenter } from '../agent/approval.js';
import { AgentOps } from '../agent/ops.js';
import { Logger } from '../core/logger.js';

/** 假 LLM：按脚本顺序返回 content（支持 <function_call> 包裹） */
function fakeLlm(scripts: string[]): AgentLlmCall {
  let i = 0;
  return {
    async chat() {
      const content = scripts[Math.min(i, scripts.length - 1)] ?? '';
      i++;
      return { content, promptTokens: 10, completionTokens: 5 };
    },
  };
}

function toolCallJson(name: string, args: Record<string, unknown>): string {
  return '<function_call>' + JSON.stringify([{ name, arguments: JSON.stringify(args) }]) + '</function_call>';
}

/* ---------------- runtime ---------------- */

test('agentops: runtime 工具循环——调用→回填→最终答复', async () => {
  const executed: Record<string, unknown>[] = [];
  const tools: AgentTool[] = [{
    name: 'echo_tool',
    description: '回显',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    async run(args) { executed.push(args); return { ok: true, content: 'echo:' + String(args['q'] ?? '') }; },
  }];
  const rt = new AgentRuntime({ llm: fakeLlm([toolCallJson('echo_tool', { q: 'hi' }), '最终答复']), tools });
  const r = await rt.chat({ sessionId: 's1', messages: [{ role: 'user', content: '测' }] });
  assert.equal(r.reply, '最终答复');
  assert.equal(r.toolCalls.length, 1, '应有一次工具调用');
  assert.equal(executed.length, 1, '工具应执行一次');
  assert.equal(executed[0]!['q'], 'hi', '参数应正确传递');
  const toolMsg = r.messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg?.content, 'echo:hi', '工具结果应回填会话');
  assert.equal(r.pending.length, 0, '无审批挂起');
});

test('agentops: runtime 未知工具容错（不炸循环）', async () => {
  const rt = new AgentRuntime({ llm: fakeLlm([toolCallJson('nope', {}), '兜底答复']), tools: [] });
  const r = await rt.chat({ sessionId: 's2', messages: [{ role: 'user', content: '测' }] });
  const toolMsg = r.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg?.content ?? '', /unknown tool: nope/);
  assert.equal(r.reply, '兜底答复');
});

test('agentops: needApproval 挂起——pending 结构化且不放行', async () => {
  let executedWithApproval = false;
  const tools: AgentTool[] = [{
    name: 'danger_write',
    description: '危险写操作',
    parameters: { type: 'object', properties: {} },
    async run(_args, _ctx, approved) {
      if (!approved) return { ok: false, needApproval: true, content: '需审批', pendingPayload: { x: 1 } };
      executedWithApproval = true;
      return { ok: true, content: 'done' };
    },
  }];
  const rt = new AgentRuntime({ llm: fakeLlm([toolCallJson('danger_write', {}), '已挂起']), tools });
  const r = await rt.chat({ sessionId: 's3', messages: [{ role: 'user', content: '执行危险操作' }] });
  assert.equal(r.pending.length, 1, '应生成 pending');
  assert.equal(r.pending[0]!.tool, 'danger_write');
  assert.ok(!executedWithApproval, '未批准绝不执行（fail-closed）');
});

/* ---------------- 出口闸门 ---------------- */

test('agentops: 闸门拒绝内网/保留/元数据/绕过形态', async () => {
  assert.equal(normalizeIpv4('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIpv4('0177.0.0.1'), '127.0.0.1', '八进制归一化');
  assert.equal(normalizeIpv4('0x7f.0.0.1'), '127.0.0.1', '十六进制归一化');
  assert.ok(isBlockedAddress('127.0.0.1'));
  assert.ok(isBlockedAddress('10.1.2.3'));
  assert.ok(isBlockedAddress('172.16.0.1'));
  assert.ok(isBlockedAddress('192.168.0.1'));
  assert.ok(isBlockedAddress('169.254.169.254'), '云元数据');
  assert.ok(isBlockedAddress('100.64.0.1'), 'CGNAT');
  assert.ok(isBlockedAddress('0177.0.0.1'), '八进制绕过');
  assert.ok(isBlockedAddress('0x7f.0.0.1'), '十六进制绕过');
  assert.ok(isBlockedAddress('::1'));
  assert.ok(isBlockedAddress('fd00::1'));
  assert.ok(isBlockedAddress('::ffff:192.168.0.1'), 'v4 映射');
  assert.ok(!isBlockedAddress('93.184.216.34'), '公网 v4 放行');
  assert.ok(!isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946'), '公网 v6 放行');
});

test('agentops: gateEgress——协议/内网/元数据/localhost 全拒，公网放行', async () => {
  assert.equal((await gateEgress('ftp://example.com')).ok, false, '非 http(s) 拒');
  assert.equal((await gateEgress('http://127.0.0.1:8787/admin')).ok, false, '回环拒');
  assert.equal((await gateEgress('http://169.254.169.254/latest/meta-data')).ok, false, '元数据拒');
  assert.equal((await gateEgress('http://[::1]/x')).ok, false, 'v6 回环拒');
  assert.equal((await gateEgress('http://0177.0.0.1/')).ok, false, '八进制绕过拒');
  assert.equal((await gateEgress('http://localhost:9/')).ok, false, 'localhost 解析回环拒');
  const pub = await gateEgress('http://93.184.216.34/api');
  assert.equal(pub.ok, true, '公网 v4 放行');
});

/* ---------------- httpTool ---------------- */

test('agentops: HTTP GET 工具免审批直接执行', async () => {
  let called = 0;
  const fakeFetch = (async () => {
    called++;
    return { status: 200, statusText: 'OK', text: async () => '{"v":1}' } as unknown as Response;
  }) as typeof fetch;
  const tool = createHttpTool({ name: 'ext_get', method: 'GET', url: 'http://93.184.216.34/api' }, { fetchImpl: fakeFetch });
  const r = await tool.run({}, { sessionId: 's' }, false);
  assert.equal(r.ok, true);
  assert.match(r.content, /HTTP 200/);
  assert.equal(called, 1);
  assert.ok(!r.needApproval, 'GET 免审');
});

test('agentops: HTTP 写操作未批不执行、批准后执行', async () => {
  let called = 0;
  const fakeFetch = (async () => {
    called++;
    return { status: 201, statusText: 'Created', text: async () => 'ok' } as unknown as Response;
  }) as typeof fetch;
  const tool = createHttpTool({ name: 'ext_post', method: 'POST', url: 'http://93.184.216.34/write' }, { fetchImpl: fakeFetch });
  const r1 = await tool.run({}, { sessionId: 's' }, false);
  assert.ok(r1.needApproval, '写操作需审批');
  assert.equal(called, 0, '未批准绝不外呼（fail-closed）');
  const r2 = await tool.run({}, { sessionId: 's' }, true);
  assert.equal(r2.ok, true);
  assert.equal(called, 1, '批准后执行一次');
});

/* ---------------- 持久化与审批 ---------------- */

test('agentops: AgentDb 会话/工具/审批/运行往返', () => {
  const db = new AgentDb(':memory:');
  db.init();
  db.saveSession({ id: 'sess1', kbId: 'kb1', messages: [{ role: 'user', content: 'hi' }], createdAt: 1, updatedAt: 2 });
  const s = db.getSession('sess1');
  assert.equal(s?.kbId, 'kb1');
  assert.equal(s?.messages.length, 1);
  assert.equal(db.getSession('nope'), undefined, '不存在返回 undefined（兼容 22.5 占位对象坑）');
  db.saveTool({ name: 't1', kind: 'http', configJson: '{}', enabled: true, createdAt: 1 });
  assert.equal(db.getTool('t1')?.enabled, true);
  db.deleteTool('t1');
  assert.equal(db.getTool('t1'), undefined);
  db.saveRun({ id: 'r1', sessionId: 'sess1', tool: 't1', kind: 'builtin', ok: true, summary: 'ok', createdAt: 3 });
  assert.equal(db.listRuns(10).length, 1);
  db.close();
});

test('agentops: 审批中心——裁决与超时置 expired（fail-closed）', async () => {
  const db = new AgentDb(':memory:');
  db.init();
  const center = new ApprovalCenter(db, 5); // 5ms 超时
  const a = center.create('sess1', 'ext_post', { args: {} });
  assert.equal(a.status, 'pending');
  const decided = center.decide(a.id, 'approve', 'op1');
  assert.equal(decided?.status, 'approved');
  assert.equal(decided?.actor, 'op1');
  const b = center.create('sess1', 'ext_post', { args: {} });
  await new Promise((r) => setTimeout(r, 20));
  const expired = center.sweepExpired();
  assert.deepEqual(expired, [b.id], '超时单应被清扫');
  assert.equal(center.get(b.id)?.status, 'expired', '超时=拒绝（fail-closed）');
  db.close();
});

/* ---------------- AgentOps 组合层端到端（假 LLM + 假 fetch，零网络） ---------------- */

test('agentops: 组合层 chat——注册 GET 工具→对话调用→结果回填→运行留痕', async () => {
  const llmScript = [
    toolCallJson('ext_get', {}),
    '平台数据显示 v=1，处理完成',
  ];
  let llmIdx = 0;
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL | Request, _init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/v1/chat/completions')) {
      const content = llmScript[Math.min(llmIdx, llmScript.length - 1)] ?? '';
      llmIdx++;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } as unknown as Response;
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => '{"v":1}' } as unknown as Response;
  }) as typeof fetch;
  const ops = new AgentOps({
    agentConfig: { enabled: true, model: 'test-model' },
    storagePath: ':memory:',
    logger: new Logger('error'),
    fetchImpl: fakeFetch,
  });
  ops.registerHttpTool({ name: 'ext_get', method: 'GET', url: 'http://93.184.216.34/api' });
  const r = await ops.chat({ message: '看下平台数据', actor: 'tester' });
  assert.equal(r.reply, '平台数据显示 v=1，处理完成');
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.approvalsPending.length, 0, 'GET 不挂审批');
  assert.ok(calls.some((u) => u.includes('93.184.216.34')), '外呼应发生');
  const s = ops.getSession(r.sessionId);
  assert.ok(s && s.messages.length >= 4, '会话应含 system/user/assistant/tool');
  assert.equal(ops.listRuns(10).length, 1, '工具执行应留痕');
  ops.stop();
});

test('agentops: 组合层——写工具挂审批单，批准后执行并回填会话', async () => {
  const llmScript = [toolCallJson('ext_post', {}), '已执行写入'];
  let llmIdx = 0;
  let apiCalls = 0;
  const fakeFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/v1/chat/completions')) {
      const content = llmScript[Math.min(llmIdx, llmScript.length - 1)] ?? '';
      llmIdx++;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: {} }) } as unknown as Response;
    }
    apiCalls++;
    return { ok: true, status: 200, statusText: 'OK', text: async () => 'written' } as unknown as Response;
  }) as typeof fetch;
  const ops = new AgentOps({
    agentConfig: { enabled: true, model: 'test-model' },
    storagePath: ':memory:',
    logger: new Logger('error'),
    fetchImpl: fakeFetch,
  });
  ops.registerHttpTool({ name: 'ext_post', method: 'POST', url: 'http://93.184.216.34/write' });
  const r = await ops.chat({ message: '写入配置', actor: 'tester' });
  assert.equal(r.approvalsPending.length, 1, '写操作应挂审批单');
  assert.equal(apiCalls, 0, '未批准绝不外呼');
  const id = r.approvalsPending[0]!;
  const result = await ops.decideApproval(id, 'approve', 'op1');
  assert.equal(result.approval.status, 'approved');
  assert.equal(result.executed?.ok, true, '批准后应执行');
  assert.equal(apiCalls, 1, '批准后外呼一次');
  const s = ops.getSession(r.sessionId);
  assert.ok(s?.messages.some((m) => (m.content ?? '').includes('审批通过')), '审批结果应回填会话');
  ops.stop();
});

test('agentops: 拒绝后的审批不可再裁决（409 语义）', async () => {
  const fakeFetch = (async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }) } as unknown as Response)) as typeof fetch;
  const ops = new AgentOps({ agentConfig: { enabled: true }, storagePath: ':memory:', logger: new Logger('error'), fetchImpl: fakeFetch });
  const a = ops.approvals.create('sess', 'ext_post', { args: {} });
  ops.approvals.decide(a.id, 'reject', 'op1');
  await assert.rejects(() => ops.decideApproval(a.id, 'approve', 'op2'), /已处理/, '已裁决的单再裁决应报错');
  ops.stop();
});
