/**
 * 运营 Agent 运行时（平台规则 Agent）。
 *
 * 取代旧 src/agent/runner（只产建议不执行）。本运行时是真正的 tool_calls 执行循环：
 * 多轮会话 -> 调 LLM（带工具定义）-> 执行工具 -> 回填结果 -> 再调 LLM -> 产出最终回复。
 *
 * 安全不变量（沿用旧 runner）：
 * - LLM 调用走本网关 /v1/chat/completions（自带计量/归因/熔断保护），client_kind=agent 可识别。
 * - 主路径（鉴权/路由/透传）完全不碰本模块；本模块故障不抛出到转发主路径。
 * - 危险动作（needApproval）不立即执行，生成审批单，审批通过后才真正执行（异步）。
 */
import { randomUUID } from 'node:crypto';
import type { AgentLlmCall } from './llm.js';
import type { AgentMessage, AgentTool, AgentToolCall, AgentToolContext } from './types.js';

/** 需审批的挂起动作（由上层生成审批单，批准后再以 approved=true 执行） */
export interface AgentPendingApproval {
  tool: string;
  args: Record<string, unknown>;
  content: string;
}

export interface AgentRuntimeDeps {
  llm: AgentLlmCall;
  tools: AgentTool[];
  maxToolRounds?: number;
  model?: string;
  onToolRun?: (rec: { sessionId: string; tool: string; ok: boolean; summary: string }) => void;
}

export class AgentRuntime {
  private readonly deps: AgentRuntimeDeps;
  private readonly toolMap = new Map<string, AgentTool>();
  constructor(deps: AgentRuntimeDeps) {
    this.deps = deps;
    for (const t of deps.tools) this.toolMap.set(t.name, t);
  }
  /** 注册新工具（外部 HTTP 工具注册时调用） */
  addTool(t: AgentTool): void { this.toolMap.set(t.name, t); }
  hasTool(name: string): boolean { return this.toolMap.has(name); }
  removeTool(name: string): boolean { return this.toolMap.delete(name); }
  getTool(name: string): AgentTool | undefined { return this.toolMap.get(name); }
  get toolDefs() {
    return [...this.toolMap.values()].map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  async chat(opts: { sessionId: string; messages: AgentMessage[]; kbId?: string; actor?: string; }): Promise<{ reply: string; toolCalls: AgentToolCall[]; pending: AgentPendingApproval[]; messages: AgentMessage[] }> {
    const msgs: AgentMessage[] = opts.messages.map((m) => ({ ...m }));
    const pending: AgentPendingApproval[] = [];
    const toolCalls: AgentToolCall[] = [];
    const maxRounds = this.deps.maxToolRounds ?? 6;
    const ctx: AgentToolContext = { sessionId: opts.sessionId, kbId: opts.kbId, actor: opts.actor };
    for (let round = 0; round < maxRounds; round++) {
      const res = await this.deps.llm.chat(msgs as any, { model: this.deps.model ?? 'default', timeoutMs: 60000 });
      const parsed = parseContent(res.content);
      if (!parsed.toolCalls || parsed.toolCalls.length === 0) {
        const reply = parsed.content || '';
        msgs.push({ role: 'assistant', content: reply });
        return { reply, toolCalls, pending, messages: msgs };
      }
      const assistantMsg: AgentMessage = { role: 'assistant', content: parsed.content, tool_calls: parsed.toolCalls };
      msgs.push(assistantMsg);
      toolCalls.push(...parsed.toolCalls);
      for (const tc of parsed.toolCalls) {
        const fn = tc.function;
        const tool = this.toolMap.get(fn.name);
        let result: { ok: boolean; content: string; needApproval?: boolean };
        if (!tool) {
          result = { ok: false, content: 'unknown tool: ' + fn.name };
        } else {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(fn.arguments || '{}'); } catch { args = {}; }
          result = await tool.run(args, ctx, false);
          this.deps.onToolRun?.({ sessionId: opts.sessionId, tool: fn.name, ok: result.ok, summary: result.content.slice(0, 120) });
          if (result.needApproval) pending.push({ tool: fn.name, args, content: result.content });
        }
        msgs.push({ role: 'tool', tool_call_id: tc.id, name: fn.name, content: result.content });
      }
      if (pending.length > 0) break;
    }
    const last = msgs[msgs.length - 1];
    const reply = last && last.role === 'assistant' && last.content ? last.content : '(max tool rounds reached, no final reply)';
    return { reply, toolCalls, pending, messages: msgs };
  }
}

function parseContent(content: string): { content: string; toolCalls?: AgentToolCall[] } {
  if (!content) return { content: '' };
  const fc = content.match(/<function_call>([\s\S]*?)<\/function_call>/);
  if (fc) {
    try { const obj = JSON.parse((fc[1] ?? '').trim()); return { content, toolCalls: normalizeToolCalls(obj) }; } catch { /* noop */ }
  }
  const arr = content.match(/\[\{"[^{}]*"name"\s*:\s*"[\w-]+"[\s\S]*?\}\]/);
  if (arr) {
    try { const list = JSON.parse(arr[0]); return { content, toolCalls: normalizeToolCalls(list) }; } catch { /* noop */ }
  }
  return { content };
}

function normalizeToolCalls(raw: unknown): AgentToolCall[] {
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((item: any, i: number) => ({
    id: item?.id ?? 'call_' + i + '_' + randomUUID().slice(0, 8),
    type: 'function',
    function: { name: String(item?.name ?? ''), arguments: typeof item?.arguments === 'string' ? item.arguments : JSON.stringify(item?.arguments ?? {}) },
  }));
}
