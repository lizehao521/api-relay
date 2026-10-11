/**
 * 运营 Agent（平台规则 Agent）核心类型。
 *
 * 设计约束（见 docs/AGENT-OPS-DESIGN.md）：
 * - 工具 = 平台已有能力 + 可注册外部 HTTP 工具（受出口闸门约束）。
 * - 越界动作（外部写、平台变更）走异步审批流（fail-closed）。
 * - Agent 的 LLM 调用走本网关 /v1/chat/completions（自带计量/归因/熔断保护）。
 * - 主路径（鉴权/路由/透传）完全不碰 Agent；Agent 故障绝不影响网关转发。
 */

export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AgentMessage {
  role: AgentRole;
  /** 文本内容（assistant 的最终回复 / user 的输入） */
  content?: string;
  /** tool_calls（assistant 发起工具调用时） */
  tool_calls?: AgentToolCall[];
  /** tool 角色消息：回填某次工具执行结果 */
  tool_call_id?: string;
  /** 工具名称（tool 角色） */
  name?: string;
}

export interface AgentToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 工具执行结果：content 回灌 LLM；needApproval=true 时生成审批单而非立即执行 */
export interface ToolResult {
  ok: boolean;
  content: string;
  /** 危险动作标记：需走审批流 */
  needApproval?: boolean;
  /** needApproval 时携带本次要执行的"待审批载荷"（由审批通过后真正执行） */
  pendingPayload?: unknown;
}

export interface AgentToolContext {
  /** 当前会话 id（用于审计/审批关联） */
  sessionId: string;
  /** 可选绑定的 KB（检索/问答用） */
  kbId?: string;
  /** 触发来源 */
  actor?: string;
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema 风格的参数描述（给 LLM 看） */
  parameters: Record<string, unknown>;
  /**
   * 执行工具。返回 needApproval=true 时，runtime 不会立即干活，而是生成审批单，
   * 审批通过后用同样的 args 再调一次（此时 approved=true）。
   */
  run(args: Record<string, unknown>, ctx: AgentToolContext, approved: boolean): Promise<ToolResult>;
}

/** 一次工具调用的审计/执行记录 */
export interface AgentRunRecord {
  id: string;
  sessionId: string;
  tool: string;
  kind: 'builtin' | 'http';
  ok: boolean;
  summary: string;
  createdAt: number;
}
