/**
 * 运营 Agent（平台规则 Agent）的 admin 子路由处理。
 *
 * 端点（全部在 /admin/api/ 前缀后）：
 *   POST   agent/chat                多轮对话入口 {message, session_id?, kb_id?}
 *   GET    agent/sessions            会话列表（摘要）
 *   GET    agent/sessions/{id}       单会话（含消息）
 *   GET    agent/tools               工具清单（内置 + 外部 HTTP）
 *   POST   agent/tools               注册外部 HTTP 工具 {name, method, url, headers?, description?}
 *   DELETE agent/tools/{name}        注销外部 HTTP 工具
 *   GET    agent/approvals?status=   审批单列表
 *   POST   agent/approvals/{id}      裁决 {action: approve|reject, actor?}（approve 后立即执行并回填会话）
 *   GET    agent/history             工具执行历史
 *
 * 安全：本 handler 只挂 admin 鉴权面；Agent 故障（LLM 不可达）只影响本端点，不影响网关主路径。
 */
import type { ServerResponse } from 'node:http';
import { json } from '../response.js';
import type { AgentOps } from '../../agent/ops.js';
import type { Logger } from '../../core/logger.js';

export interface AgentOpsHandlerDeps {
  /** 惰性取值：undefined = 未启用（AdminApi 构造顺序约束见 handlers/agent.ts 注释） */
  ops: () => AgentOps | undefined;
  logger: Logger;
}

export class AgentOpsHandlers {
  constructor(private readonly deps: AgentOpsHandlerDeps) {}

  /** 这些子路由归运营 Agent（旧 agent handler 管 last/runs，互不相扰） */
  handles(action: string): boolean {
    return action === 'agent/chat'
      || action === 'agent/sessions' || action.startsWith('agent/sessions/')
      || action === 'agent/tools' || action.startsWith('agent/tools/')
      || action === 'agent/approvals' || action.startsWith('agent/approvals/')
      || action === 'agent/history';
  }

  dispatch(method: string, action: string, url: URL, body: Record<string, unknown> | undefined, res: ServerResponse, actor: string): boolean {
    const ops = this.deps.ops();
    if (!ops || !ops.enabled) {
      return json(res, 503, { error: { message: '运营 Agent 未启用（config.agent.enabled 为 false）', type: 'agent_disabled', code: 'agent_disabled' } });
    }
    try {
      return this.route(method, action, url, body, res, ops, actor);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.includes('已处理') ? 409 : msg.includes('不存在') ? 404 : 400;
      this.deps.logger.error('agentops.dispatch_failed', { action, error: msg });
      return json(res, code, { error: { message: msg, type: 'invalid_request_error', code: 'agent_' + code } });
    }
  }

  private route(method: string, action: string, url: URL, body: Record<string, unknown> | undefined, res: ServerResponse, ops: AgentOps, actor: string): boolean {
    /* ---- 对话 ---- */
    if (action === 'agent/chat' && method === 'POST') {
      const message = String(body?.['message'] ?? '').trim();
      if (!message) return json(res, 400, { error: { message: 'message 必填', type: 'invalid_request_error', code: 'message_required' } });
      const sessionId = typeof body?.['session_id'] === 'string' ? (body['session_id'] as string) : undefined;
      const kbId = typeof body?.['kb_id'] === 'string' ? (body['kb_id'] as string) : ops.db.listSessions(1)[0]?.kbId;
      // 对话语义：runtime 工具循环完成后回（LLM 超时由 llm.ts AbortController 控制）
      void ops.chat({ message, ...(sessionId ? { sessionId } : {}), ...(kbId ? { kbId } : {}), actor })
        .then((r) => json(res, 200, { session_id: r.sessionId, reply: r.reply, tool_calls: r.toolCalls, approvals_pending: r.approvalsPending }))
        .catch((e) => json(res, 502, { error: { message: 'Agent 执行失败: ' + (e instanceof Error ? e.message : String(e)), type: 'agent_execution_error', code: 'agent_execution_failed' } }));
      return true;
    }
    /* ---- 会话 ---- */
    if (action === 'agent/sessions' && method === 'GET') {
      const sessions = ops.listSessions(50).map((s) => ({
        id: s.id, kb_id: s.kbId ?? null, message_count: s.messages.length,
        created_at: s.createdAt, updated_at: s.updatedAt,
        last_message: s.messages[s.messages.length - 1]?.content?.slice(0, 120) ?? '',
      }));
      return json(res, 200, { sessions });
    }
    if (action.startsWith('agent/sessions/') && method === 'GET') {
      const id = decodeURIComponent(action.slice('agent/sessions/'.length));
      const s = ops.getSession(id);
      if (!s) return json(res, 404, { error: { message: '会话不存在: ' + id, type: 'not_found_error', code: 'session_not_found' } });
      return json(res, 200, { session: s });
    }
    /* ---- 工具 ---- */
    if (action === 'agent/tools' && method === 'GET') {
      return json(res, 200, { tools: ops.listTools() });
    }
    if (action === 'agent/tools' && method === 'POST') {
      const name = String(body?.['name'] ?? '').trim();
      const methodU = String(body?.['method'] ?? 'GET').trim().toUpperCase();
      const urlRaw = String(body?.['url'] ?? '').trim();
      if (!name || !urlRaw) return json(res, 400, { error: { message: 'name 与 url 必填', type: 'invalid_request_error', code: 'invalid_tool' } });
      const headers = body?.['headers'] && typeof body['headers'] === 'object' ? (body['headers'] as Record<string, string>) : undefined;
      const description = typeof body?.['description'] === 'string' ? (body['description'] as string) : undefined;
      ops.registerHttpTool({ name, method: methodU, url: urlRaw, ...(headers ? { headers } : {}), ...(description ? { description } : {}), ...(typeof body?.['timeout_ms'] === 'number' ? { timeoutMs: body['timeout_ms'] as number } : {}) });
      return json(res, 201, { ok: true, name, note: methodU === 'GET' ? 'GET 工具免审批' : '写操作工具将在调用时挂起审批单' });
    }
    if (action.startsWith('agent/tools/') && method === 'DELETE') {
      const name = decodeURIComponent(action.slice('agent/tools/'.length));
      const removed = ops.removeHttpTool(name);
      if (!removed) return json(res, 404, { error: { message: '外部 HTTP 工具不存在: ' + name, type: 'not_found_error', code: 'tool_not_found' } });
      return json(res, 200, { ok: true, name });
    }
    /* ---- 审批 ---- */
    if (action === 'agent/approvals' && method === 'GET') {
      const status = url.searchParams.get('status') ?? undefined;
      const approvals = ops.approvals.list(status).map((a) => ({
        id: a.id, session_id: a.sessionId, tool: a.tool, status: a.status,
        payload: JSON.parse(a.payloadJson), created_at: a.createdAt,
        decided_at: a.decidedAt ?? null, actor: a.actor ?? null,
      }));
      return json(res, 200, { approvals });
    }
    if (action.startsWith('agent/approvals/') && method === 'POST') {
      const id = decodeURIComponent(action.slice('agent/approvals/'.length));
      const act = String(body?.['action'] ?? '') as 'approve' | 'reject';
      if (act !== 'approve' && act !== 'reject') return json(res, 400, { error: { message: 'action 必须为 approve|reject', type: 'invalid_request_error', code: 'invalid_action' } });
      const actorName = typeof body?.['actor'] === 'string' ? (body['actor'] as string) : actor;
      void ops.decideApproval(id, act, actorName)
        .then((r) => json(res, 200, { approval: { id: r.approval.id, status: r.approval.status }, ...(r.executed ? { executed: r.executed } : {}) }))
        .catch((e) => json(res, 400, { error: { message: e instanceof Error ? e.message : String(e), type: 'invalid_request_error', code: 'approval_failed' } }));
      return true;
    }
    /* ---- 历史 ---- */
    if (action === 'agent/history' && method === 'GET') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
      return json(res, 200, { runs: ops.listRuns(limit) });
    }
    return json(res, 405, { error: { message: 'agent 子路由 ' + method + ' ' + action + ' 不存在或方法不匹配', type: 'method_not_allowed', code: 'method_not_allowed' } });
  }
}
