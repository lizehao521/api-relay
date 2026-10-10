/**
 * 无状态客户端指纹（评估文档 P4 的"降级形态"）
 *
 * 目标：在不保存任何会话正文的前提下，从**单个请求（可选叠加短窗口计数）**识别
 * 「Agent 型客户」与「脚本/套壳 App 客户」，用于分层升级建议与运营看板。
 *
 * 与 P4 意图栈的区别：不存 goal、不存历史消息、不做硬门禁。
 * 它只是把请求自身已经携带的结构特征算成一个分数——因此不引入跨请求状态的隐私与串意图风险。
 */

import type { ClientFingerprint, ClientKind } from '../core/types.js';
import { hmacHex, clamp, round } from '../util/index.js';

/** 规则版本：指标口径变化时递增，保证历史数据可解释 */
export const FINGERPRINT_RULE_VERSION = 1;

/** 已知 Agent/IDE 框架的 User-Agent 特征 */
const AGENT_UA = /(cline|roo|cursor|windsurf|continue\.dev|aider|openhands|autogen|langchain|llamafuzz|dify|coze|n8n|flowise|langflow|hermes|browser-?use|openai-python|openai-node|anthropic|vercel\/ai|ai-sdk|litellm|one-?api|new-?api|relay-ops-agent)/i;

/** 已知 Agent 系统提示词特征（只取哈希特征与关键词，不落正文） */
const AGENT_SYSTEM_HINTS = /(you are (a|an) (coding )?(assistant|agent)|<tool_use|tool_calls|available tools|你可以使用以下工具|function.?calling)/i;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface FingerprintInput {
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  /** 短窗口计数（可选）：同一 key 在最近 5 分钟的独立 system prompt 数 —— 多会话 Agent 特征 */
  distinctSystemPrompts5m?: number;
  /** 短窗口计数（可选）：最近 60s 内该 key 的请求数 —— 高并发批处理特征 */
  requests60s?: number;
  /** 短窗口计数（可选）：最近 10 分钟内的失败重试次数 */
  retries10m?: number;
  salt: string;
}

/** 纯函数：相同输入 → 相同指纹 */
export function computeFingerprint(input: FingerprintInput): ClientFingerprint {
  const body = input.body;
  const headers = input.headers ?? {};
  const messages = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : [];

  const toolCallsInHistory = messages.some((m) => isObj(m) && Array.isArray(m['tool_calls']));
  const toolRoleInHistory = messages.some((m) => isObj(m) && m['role'] === 'tool');
  const toolsDeclared = Array.isArray(body['tools']) && (body['tools'] as unknown[]).length > 0;
  const legacyFunctions = Array.isArray(body['functions']) && (body['functions'] as unknown[]).length > 0;
  const toolChoiceObject = isObj(body['tool_choice']);
  const parallelToolCalls = body['parallel_tool_calls'] === true;
  const streamRequested = body['stream'] === true;
  const jsonMode = isObj(body['response_format']) && (body['response_format'] as Record<string, unknown>)['type'] === 'json_object';

  // assistant↔tool 交替次数：衡量"多步执行"程度
  let alternation = 0;
  let prevRole = '';
  for (const m of messages) {
    const role = isObj(m) && typeof m['role'] === 'string' ? (m['role'] as string) : '';
    if ((prevRole === 'assistant' && role === 'tool') || (prevRole === 'tool' && role === 'assistant')) alternation++;
    if (role) prevRole = role;
  }
  const multiTurn = messages.length > 1 && alternation > 0;

  // 系统提示词哈希（只留哈希，不留内容）
  const systemText = messages
    .filter((m) => isObj(m) && m['role'] === 'system')
    .map((m) => {
      const c = (m as Record<string, unknown>)['content'];
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((p) => (isObj(p) && typeof p['text'] === 'string' ? (p['text'] as string) : '')).join('');
      return '';
    })
    .join('\n');
  const systemPromptHash = systemText ? hmacHex(input.salt || 'relay-fingerprint', systemText).slice(0, 16) : '';

  const ua = headers['user-agent'];
  const agentUa = !!ua && AGENT_UA.test(ua);
  const agentSystemHint = !!systemText && AGENT_SYSTEM_HINTS.test(systemText);

  /* ---------------- 加权打分（可解释、可单测） ---------------- */
  const signals: { name: string; weight: number; hit: boolean }[] = [
    { name: 'tool_calls_in_history', weight: 0.3, hit: toolCallsInHistory || toolRoleInHistory },
    { name: 'tools_declared', weight: 0.18, hit: toolsDeclared || legacyFunctions },
    { name: 'multi_turn_tool_alternation', weight: 0.18, hit: multiTurn && alternation >= 2 },
    { name: 'agent_system_prompt', weight: 0.14, hit: agentSystemHint },
    { name: 'agent_user_agent', weight: 0.14, hit: agentUa },
    { name: 'parallel_tool_calls', weight: 0.06, hit: parallelToolCalls },
    { name: 'tool_choice_object', weight: 0.05, hit: toolChoiceObject },
    { name: 'distinct_system_prompts_5m', weight: 0.08, hit: (input.distinctSystemPrompts5m ?? 0) >= 5 },
    { name: 'high_concurrency', weight: 0.05, hit: (input.requests60s ?? 0) >= 10 },
    { name: 'retry_loop', weight: 0.07, hit: (input.retries10m ?? 0) >= 2 },
  ];
  let score = 0;
  for (const s of signals) if (s.hit) score += s.weight;
  score = clamp(round(score, 3), 0, 1);

  const kind: ClientKind = score >= 0.45 ? 'agent' : toolCallsInHistory || toolsDeclared ? 'app' : openaiSdkLike(ua) ? 'script' : 'unknown';

  return {
    kind,
    agentScore: score,
    features: {
      hasToolCalls: toolCallsInHistory,
      hasTools: toolsDeclared || legacyFunctions,
      multiTurn,
      roleAlternation: alternation,
      systemPromptHash,
      streamRequested,
      jsonMode,
      ...(ua ? { userAgent: ua.slice(0, 200) } : {}),
    },
    ruleVersion: FINGERPRINT_RULE_VERSION,
  };
}

function openaiSdkLike(ua?: string): boolean {
  if (!ua) return false;
  return /(python-requests|okhttp|axios|node-fetch|undici|curl|go-http-client|java|httpx|requests)/i.test(ua);
}

/** Agent 判定（按配置阈值） */
export function isAgent(fingerprint: ClientFingerprint, threshold: number): boolean {
  return fingerprint.agentScore >= threshold;
}

/** 用于运营提示的升级建议（不自动改分层，只给运营决策依据） */
export function upgradeHint(fingerprint: ClientFingerprint, threshold: number): string | null {
  if (fingerprint.agentScore >= threshold) {
    return '疑似 Agent 型客户：建议推送 Pro 层（降损全开）';
  }
  if (fingerprint.agentScore >= threshold * 0.6) {
    return '弱 Agent 特征：建议继续观察，或用免费试用钩子引导';
  }
  return null;
}
