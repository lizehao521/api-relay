/**
 * 运营 Agent 组合层：把 runtime / 持久化 / 审批 / 内置工具 / 外部 HTTP 工具粘成一体。
 *
 * 职责：
 * - chat 编排：加载/新建会话 -> 注入系统提示词 -> runtime 执行循环 -> 持久化消息与运行记录
 *   -> 为 needApproval 动作生成审批单（异步，fail-closed）。
 * - 审批执行：approve 后以 approved=true 重跑工具，把结果回填会话。
 * - 工具注册：外部 HTTP 工具的注册/注销（受出口闸门约束），持久化到 agent.db。
 * - 生命周期：setBaseUrl（listen 后回填）、sweep 超时审批、stop 关库。
 */
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgentLlm } from './llm.js';
import { AgentRuntime, type AgentPendingApproval } from './runtime.js';
import { AgentDb, type StoredApproval, type StoredRun, type StoredSession } from './session.js';
import { ApprovalCenter } from './approval.js';
import { createBuiltinTools } from './tools/builtin.js';
import { createHttpTool, type HttpToolConfig } from './tools/httpTool.js';
import type { AgentMessage, AgentToolCall } from './types.js';
import type { AgentConfig, RelayConfig } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { KbStore } from '../kb/store.js';
import type { Store } from '../store/index.js';
import type { Router } from '../upstream/pool.js';

const SYSTEM_PROMPT = [
  '你是 api-relay 聚合中转平台的运营 Agent，为运营人员服务。',
  '你的能力边界=平台规则：只能通过已注册的工具访问世界；内网地址出口一律被闸门拒绝。',
  '只读工具（检索/查询/列表）直接执行；写操作工具会自动挂起审批单，由运营人员批准后你再得到执行结果。',
  '回答用中文，先给结论再给证据；引用工具返回的原始数字，不编造。',
].join('\n');

export interface AgentOpsDeps {
  agentConfig: AgentConfig;
  /** config.storage.path —— 用于推导 agent.db 位置（':memory:' 透传） */
  storagePath: string;
  /** Agent 专用客户端 key 明文（config.clients 按 agent.clientId 查得；用于 /v1/kb ask） */
  agentKey?: string;
  logger: Logger;
  kb?: KbStore | undefined;
  store?: Store | undefined;
  router?: Router | undefined;
  fetchImpl?: typeof fetch;
}

export interface ChatResult {
  sessionId: string;
  reply: string;
  toolCalls: AgentToolCall[];
  /** 本轮挂起的审批单 id */
  approvalsPending: string[];
}

export class AgentOps {
  readonly db: AgentDb;
  readonly approvals: ApprovalCenter;
  readonly runtime: AgentRuntime;
  private readonly llm: ReturnType<typeof createAgentLlm>;
  private readonly deps: AgentOpsDeps;
  private readonly agentKey: string;
  private baseUrl = 'http://127.0.0.1';
  private sweepTimer?: NodeJS.Timeout;

  constructor(deps: AgentOpsDeps) {
    this.deps = deps;
    this.agentKey = deps.agentKey ?? '';
    const cfg = deps.agentConfig;
    const dbPath = deps.storagePath === ':memory:' ? ':memory:' : join(dirname(deps.storagePath), 'agent.db');
    this.db = new AgentDb(dbPath);
    this.db.init();
    this.approvals = new ApprovalCenter(this.db);
    // Agent 调 LLM 走本网关（自证闭环：计量/归因/熔断保护，client_kind=agent）
    this.llm = createAgentLlm({
      baseUrl: 'http://127.0.0.1',
      key: '',
      model: cfg.model ?? 'default',
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    const builtin = createBuiltinTools({
      kb: deps.kb,
      store: deps.store,
      router: deps.router,
      kbAsk: (kbId: string, question: string) => this.kbAsk(kbId, question),
    });
    // 恢复已注册的外部 HTTP 工具
    const httpTools: AgentToolLike[] = [];
    for (const t of this.db.listTools()) {
      if (!t.enabled) continue;
      try {
        httpTools.push(createHttpTool(JSON.parse(t.configJson) as HttpToolConfig, { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }));
      } catch (e) { deps.logger.error('agentops.tool_restore_failed', { name: t.name, error: String(e) }); }
    }
    this.runtime = new AgentRuntime({
      llm: this.llm,
      tools: [...builtin, ...httpTools],
      ...(cfg.model ? { model: cfg.model } : {}),
      onToolRun: (rec) => this.recordRun(rec),
    });
  }

  get enabled(): boolean { return this.deps.agentConfig.enabled !== false; }

  /** listen 之后回填真实网关地址（llm 与 kbAsk 共用） */
  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, '');
    (this.llm as { setBaseUrl?: (u: string) => void }).setBaseUrl?.(this.baseUrl);
  }

  /** 启动审批超时清扫（unref，不拖退出） */
  start(): void {
    const t = setInterval(() => {
      const expired = this.approvals.sweepExpired();
      if (expired.length) this.deps.store?.logEvent('warn', 'agent.approval_expired', { ids: expired.length });
    }, 60_000);
    if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
    this.sweepTimer = t;
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.db.close();
  }

  async chat(opts: { message: string; sessionId?: string; kbId?: string; actor?: string }): Promise<ChatResult> {
    const now = Date.now();
    let session: StoredSession;
    if (opts.sessionId) {
      const existing = this.db.getSession(opts.sessionId);
      if (!existing) throw new Error('会话不存在: ' + opts.sessionId);
      session = existing;
    } else {
      session = { id: randomUUID(), messages: [{ role: 'system', content: SYSTEM_PROMPT }], createdAt: now, updatedAt: now };
      if (opts.kbId) session.kbId = opts.kbId;
    }
    const kbId = opts.kbId ?? session.kbId;
    session.messages.push({ role: 'user', content: opts.message });
    const res = await this.runtime.chat({ sessionId: session.id, messages: session.messages, ...(kbId ? { kbId } : {}), ...(opts.actor ? { actor: opts.actor } : {}) });
    session.messages = res.messages;
    session.updatedAt = Date.now();
    this.db.saveSession(session);
    // needApproval 动作 -> 审批单（fail-closed：未批准不执行）
    const approvalsPending: string[] = [];
    for (const p of res.pending) {
      const a = this.approvals.create(session.id, p.tool, { args: p.args, replyHint: p.content });
      approvalsPending.push(a.id);
    }
    if (res.pending.length) {
      this.deps.store?.logEvent('info', 'agent.approval_created', { sessionId: session.id, tools: res.pending.map((p) => p.tool) });
    }
    return { sessionId: session.id, reply: res.reply, toolCalls: res.toolCalls, approvalsPending };
  }

  /** 审批裁决；approve 后立即以 approved=true 执行工具并把结果回填会话 */
  async decideApproval(id: string, action: 'approve' | 'reject', actor?: string): Promise<{ approval: StoredApproval; executed?: { ok: boolean; content: string } }> {
    const a = this.db.getApproval(id);
    if (!a) throw new Error('审批单不存在: ' + id);
    if (a.status !== 'pending') throw new Error('审批单已处理: ' + a.status);
    const decided = this.approvals.decide(id, action, actor) ?? a;
    this.deps.store?.logEvent(action === 'approve' ? 'info' : 'warn', 'agent.approval_' + action, { id, tool: a.tool, actor });
    if (action !== 'approve') return { approval: decided };
    const payload = JSON.parse(a.payloadJson) as { args: Record<string, unknown> };
    const session = this.db.getSession(a.sessionId);
    const exec = await this.runApprovedTool(a.tool, payload.args, { sessionId: a.sessionId, ...(session?.kbId ? { kbId: session.kbId } : {}), ...(actor ? { actor } : {}), approved: true });
    if (session) {
      session.messages.push({ role: 'assistant', content: '审批' + (exec.ok ? '通过' : '执行失败') + '，工具 ' + a.tool + ' 执行结果：\n' + exec.content });
      session.updatedAt = Date.now();
      this.db.saveSession(session);
    }
    return { approval: decided, executed: exec };
  }

  /** 以 approved=true 执行工具（runtime.addTool 注册的实例） */
  private async runApprovedTool(name: string, args: Record<string, unknown>, ctx: { sessionId: string; kbId?: string; actor?: string; approved: boolean }): Promise<{ ok: boolean; content: string }> {
    const tool = this.runtime.getTool(name);
    if (!tool) return { ok: false, content: '工具不存在: ' + name };
    const r = await tool.run(args, { sessionId: ctx.sessionId, ...(ctx.kbId ? { kbId: ctx.kbId } : {}), ...(ctx.actor ? { actor: ctx.actor } : {}) }, ctx.approved);
    this.recordRun({ sessionId: ctx.sessionId, tool: name, ok: r.ok, summary: r.content.slice(0, 120) });
    return { ok: r.ok, content: r.content };
  }

  registerHttpTool(cfg: HttpToolConfig): void {
    if (!/^[a-z][a-z0-9_-]{1,63}$/i.test(cfg.name)) throw new Error('工具名非法（字母开头，1-64 位字母数字_-）');
    if (this.runtime.hasTool(cfg.name)) throw new Error('工具已存在: ' + cfg.name);
    const tool = createHttpTool(cfg, { ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}) });
    this.runtime.addTool(tool);
    this.db.saveTool({ name: cfg.name, kind: 'http', configJson: JSON.stringify(cfg), enabled: true, createdAt: Date.now() });
    this.deps.store?.logEvent('info', 'agent.tool_registered', { name: cfg.name, method: cfg.method, url: cfg.url });
  }

  removeHttpTool(name: string): boolean {
    const rec = this.db.getTool(name);
    if (!rec) return false;
    this.db.deleteTool(name);
    this.runtime.removeTool(name);
    this.deps.store?.logEvent('info', 'agent.tool_removed', { name });
    return true;
  }

  listRuns(limit = 50): StoredRun[] { return this.db.listRuns(limit); }
  listSessions(limit = 50): StoredSession[] { return this.db.listSessions(limit); }

  /**
   * GET /admin/api/agent：状态视图（总览页「平台能力」区消费；旧 agentView 的取代面）。
   * 形状保持 {enabled, status.*} 兼容旧面板消费口径：model/enabled 在 status 里。
   */
  statusView(): Record<string, unknown> {
    const cfg = this.deps.agentConfig;
    return {
      enabled: true,
      status: {
        enabled: true,
        model: cfg.model ?? 'default',
        clientId: cfg.clientId ?? '',
        kbId: cfg.kbId ?? '',
        httpTools: this.db.listTools().filter((t) => t.enabled).length,
        pendingApprovals: this.approvals.list('pending').length,
        sessions: this.db.listSessions(1000).length,
        baseUrl: this.baseUrl,
        running: false,
      },
    };
  }
  getSession(id: string): StoredSession | undefined { return this.db.getSession(id); }

  /** GET /admin/api/agent/tools：内置 + 外部 HTTP */
  listTools(): { name: string; kind: 'builtin' | 'http'; description: string; config?: Record<string, unknown> }[] {
    const http = new Map(this.db.listTools().map((t) => [t.name, t]));
    return this.runtime.toolDefs.map((d) => {
      const rec = http.get(d.function.name);
      return {
        name: d.function.name,
        kind: rec ? 'http' as const : 'builtin' as const,
        description: d.function.description,
        ...(rec ? { config: JSON.parse(rec.configJson) as Record<string, unknown> } : {}),
      };
    });
  }

  private recordRun(rec: { sessionId: string; tool: string; ok: boolean; summary: string }): void {
    const run: StoredRun = { id: randomUUID(), sessionId: rec.sessionId, tool: rec.tool, kind: 'builtin', ok: rec.ok, summary: rec.summary, createdAt: Date.now() };
    this.db.saveRun(run);
  }

  /** kb 问答：走本网关 /v1/kb/{id}/ask（同一把 agent key） */
  private async kbAsk(kbId: string, question: string): Promise<{ answer: string }> {
    const fetchImpl = this.deps.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetchImpl(this.baseUrl + '/v1/kb/' + encodeURIComponent(kbId) + '/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.agentKey },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('kb ask HTTP ' + res.status);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return { answer: data.choices?.[0]?.message?.content ?? '' };
    } finally { clearTimeout(timer); }
  }
}

type AgentToolLike = Parameters<AgentRuntime['addTool']>[0];
