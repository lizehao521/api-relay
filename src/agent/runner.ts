/**
 * 内部 Agent 系统：自托管运维/迭代决策环。
 *
 * 核心设计 ——「网关调用自己」的闭环：
 *   1. Agent 读本网关的运营上下文（admin overview / events / provider 状态 / KB 检索结果）
 *   2. 把上下文组装成结构化 prompt，调本网关的 /v1/chat/completions（用自己的 agent client key）
 *   3. LLM 返回结构化决策（JSON），Agent 校验后：
 *      - 写一条 KB 文档（迭代知识，下次巡检可被检索复用）
 *      - 记审计事件（store.logEvent）
 *      - 给出"配置变更建议"（只展示不自动执行 —— 保持安全边界）
 *   4. LLM 调用本身走网关完整链路 → 被计量/归因/熔断自然保护（自托管自证）
 *
 * 安全不变量（与 ADR-KB 一致）：
 *   - 主路径（鉴权/路由/透传）完全不碰 Agent；Agent 故障绝不影响网关转发
 *   - Agent 不直接改运行中的配置/数据库，只产出"建议"，执行由人/部署流程做
 *   - 所有 LLM 调用带 agent 指纹（client_kind=agent），在计量里可识别、可归因
 */

import type { Logger } from '../core/logger.js';
import type { AgentConfig } from '../core/types.js';
import type { KbStore } from '../kb/store.js';
import type { Store } from '../store/index.js';

/* ------------------------------------------------------------------ *
 * 决策结构（LLM 输出契约）
 * ------------------------------------------------------------------ */

export type AgentDecisionKind = 'ops' | 'iteration' | 'kb' | 'none';

export interface AgentDecision {
  /** 决策类型：ops=运维动作建议 / iteration=平台迭代建议 / kb=知识沉淀 / none=无需行动 */
  kind: AgentDecisionKind;
  /** 一句话结论 */
  summary: string;
  /** 面向运维的可执行建议（不自动执行） */
  recommendation: string;
  /** 可选：要写入 KB 的迭代知识（kind=kb/iteration 时给） */
  kbNote?: { title: string; content: string } | undefined;
  /** 置信度 0-1 */
  confidence: number;
  /** 证据引用（来自哪条事件/哪个 provider） */
  evidence: string[];
}

export interface AgentRunContext {
  /** 触发来源：'auto'=周期巡检 / 'manual'=面板手动 */
  trigger: 'auto' | 'manual';
  startedAt: number;
  durationMs: number;
  model: string;
  clientId: string;
  promptTokens: number;
  completionTokens: number;
  decision: AgentDecision;
  ok: boolean;
  error?: string;
}

export interface AgentLlmCall {
  /** 调 LLM：走网关自身 /v1/chat/completions。实现方负责鉴权 key */
  chat(messages: { role: string; content: string }[], opts: { model: string; timeoutMs: number }): Promise<{
    content: string;
    promptTokens: number;
    completionTokens: number;
  }>;
}

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

export interface AgentRunnerDeps {
  config: AgentConfig;
  logger: Logger;
  /** 网关自身的 LLM 入口（实现里是「调本网关 /v1/chat/completions」的 fetch 封装） */
  llm: AgentLlmCall;
  /** 运营上下文提供（admin api + store） */
  context: AgentContextProvider;
  /** KB 回写（未启用则 undefined，Agent 退化为只产建议不沉淀） */
  kb?: KbStore | undefined;
  /** 审计事件（store.logEvent） */
  store?: Store | undefined;
  /** 决策历史环（内存，面板展示；上限防止无界增长） */
  history?: { run?: AgentRunContext; set(r: AgentRunContext): void; get(): AgentRunContext[] } | undefined;
  /** 用于 KB 检索的库 id（迭代知识沉淀到哪） */
  kbId?: string;
}

/** 运营上下文：Runner 不直接依赖 AdminApi，解耦便于测试 */
export interface AgentContextProvider {
  /** 收集当前运营快照（面板同源数据） */
  collect(): Promise<AgentOpsSnapshot>;
}

export interface AgentOpsSnapshot {
  overview: Record<string, unknown>;
  recentEvents: Record<string, unknown>[];
  providers: Record<string, unknown>[];
  kbHits?: Record<string, unknown>[]; // 上次沉淀的迭代知识（检索复用）
}

const SYSTEM_PROMPT = [
  '你是 api-relay 平台内置的运维/迭代 Agent。你的职责是：',
  '1. 基于平台运营数据（错误率、上游可用性、失败归因、用量）判断当前是否有需要运维介入的异常；',
  '2. 基于平台自身能力（知识库、降损层、路由阶梯）提出可落地的迭代/优化建议；',
  '3. 把有价值的发现沉淀成"迭代知识"（后续巡检可检索复用）。',
  '',
  '严格约束（必须遵守）：',
  '- 你只做分析与建议，不执行任何配置变更、不删改数据；执行由运维人员确认后进行。',
  '- 输出必须是单个 JSON 对象，不要任何 markdown 围栏或多余文字。',
  '- 若当前一切正常且无可沉淀建议，输出 {"kind":"none","summary":"...","recommendation":"无需行动","confidence":0.5,"evidence":[]}。',
  '- JSON 字段：kind(ops|iteration|kb|none), summary(字符串), recommendation(字符串),',
  '  kbNote(可选, 形如 {"title","content"}), confidence(0-1 数字), evidence(字符串数组, 引用具体证据)。',
].join('\n');

function buildUserPrompt(snap: AgentOpsSnapshot): string {
  const lines: string[] = [];
  lines.push('【运营快照】');
  lines.push(JSON.stringify(snap.overview, null, 2).slice(0, 6000));
  if (snap.providers.length) {
    lines.push('\n【上游状态】');
    lines.push(JSON.stringify(snap.providers.map((p) => ({
      id: p['id'], label: p['label'], disabled: p['disabled'],
      breakerOpen: p['breakerOpen'], totalRequests: p['totalRequests'], totalFailures: p['totalFailures'],
    })), null, 2).slice(0, 3000));
  }
  if (snap.recentEvents.length) {
    lines.push('\n【最近事件】');
    lines.push(JSON.stringify(snap.recentEvents.map((e) => ({ ts: e['ts'], level: e['level'], kind: e['kind'], detail: e['detail'] })), null, 2).slice(0, 3000));
  }
  if (snap.kbHits && snap.kbHits.length) {
    lines.push('\n【可复用的迭代知识（上次沉淀）】');
    lines.push(JSON.stringify(snap.kbHits).slice(0, 2000));
  }
  lines.push('\n请分析上述数据，按系统提示的 JSON 契约输出决策。');
  return lines.join('\n');
}

export function parseDecision(raw: string): AgentDecision {
  // 容错：LLM 偶尔带 markdown 围栏或前后杂字。先整体 parse，失败则抠出首个 {...} 再 parse。
  let obj: unknown;
  try {
    obj = JSON.parse(raw.trim());
  } catch {
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) throw new Error('LLM 输出不是合法 JSON: ' + raw.slice(0, 120));
    obj = JSON.parse(m[0]);
  }
  if (typeof obj !== 'object' || obj === null) throw new Error('LLM 输出不是对象');
  const o = obj as Record<string, unknown>;
  const kind: AgentDecisionKind = (['ops', 'iteration', 'kb', 'none'].includes(String(o['kind']))
    ? String(o['kind']) : 'none') as AgentDecisionKind;
  const conf = Number(o['confidence']);
  const decision: AgentDecision = {
    kind,
    summary: String(o['summary'] ?? '(未给)'),
    recommendation: String(o['recommendation'] ?? ''),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
    evidence: Array.isArray(o['evidence']) ? (o['evidence'] as unknown[]).map((x) => String(x)).slice(0, 12) : [],
  };
  if (o['kbNote'] && typeof o['kbNote'] === 'object') {
    const n = o['kbNote'] as Record<string, unknown>;
    if (typeof n['title'] === 'string' && typeof n['content'] === 'string') {
      decision.kbNote = { title: n['title'], content: n['content'] };
    }
  }
  return decision;
}

const HISTORY_CAP = 50;

class InMemoryHistory {
  private runs: AgentRunContext[] = [];
  set(r: AgentRunContext): void {
    this.runs.push(r);
    if (this.runs.length > HISTORY_CAP) this.runs.splice(0, this.runs.length - HISTORY_CAP);
  }
  get(): AgentRunContext[] {
    return [...this.runs].reverse(); // 新在前
  }
}

export class AgentRunner {
  private readonly deps: AgentRunnerDeps;
  private readonly history = new InMemoryHistory();
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  /** 网关 base URL（listen 后回填） */
  private baseUrl = '';

  constructor(deps: AgentRunnerDeps) {
    // 内置历史环（若外部未提供则用内部实现，保证面板总能查）
    this.deps = { ...deps, history: deps.history ?? this.history };
  }

  /** 回填网关 base URL（Agent 调 LLM 走本网关） */
  setBaseUrl(url: string): void {
    this.baseUrl = url;
    // 若 llm 支持动态 base URL，则注入（createAgentLlm 的实现支持 setBaseUrl）
    const llm = this.deps.llm as unknown as { setBaseUrl?: (u: string) => void };
    llm.setBaseUrl?.(url);
  }

  get enabled(): boolean {
    return this.deps.config.enabled === true;
  }

  /** 启动周期巡检（intervalMs>0 才真正定时；否则只靠手动触发） */
  start(): void {
    if (!this.enabled) return;
    const ms = this.deps.config.intervalMs ?? 0;
    if (ms <= 0) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.run('auto').catch((e) => this.deps.logger.error('agent.auto_run_failed', { error: String(e) }));
    }, ms);
    this.timer.unref?.();
    this.deps.logger.info('agent.started', { intervalMs: ms, model: this.model() });
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  private model(): string {
    return this.deps.config.model ?? 'default';
  }

  /* ---------------- 面板/管理 API 用的只读接口 ---------------- */

  get baseUrl_(): string { return this.baseUrl; }
  get isRunning(): boolean { return this.running; }
  lastRun(): AgentRunContext | undefined { return this.deps.history!.get()[0]; }
  runs(): AgentRunContext[] { return this.deps.history!.get(); }
  status(): Record<string, unknown> {
    const last = this.lastRun();
    return {
      enabled: this.enabled,
      model: this.model(),
      clientId: this.deps.config.clientId ?? '',
      intervalMs: this.deps.config.intervalMs ?? 0,
      autoWriteKb: this.deps.config.autoWriteKb ?? true,
      kbId: this.deps.config.kbId ?? 'kb_demo',
      running: this.running,
      baseUrl: this.baseUrl || '(尚未 listen)',
      lastRun: last ?? null,
      runCount: this.deps.history!.get().length,
    };
  }

  async run(trigger: 'auto' | 'manual'): Promise<AgentRunContext> {
    const started = Date.now();
    if (this.running) {
      const r: AgentRunContext = {
        trigger, startedAt: started, durationMs: 0, model: this.model(),
        clientId: this.deps.config.clientId ?? '', promptTokens: 0, completionTokens: 0,
        decision: { kind: 'none', summary: '上一轮仍在运行，跳过', recommendation: '稍后再触发', confidence: 0, evidence: [] },
        ok: false, error: 'already_running',
      };
      this.deps.history?.set(r);
      return r;
    }
    this.running = true;
    try {
      const snap = await this.deps.context.collect();
      // 若 KB 可用，检索上次沉淀的迭代知识做复用
      if (this.deps.kb && this.deps.kb.ok && this.deps.config.kbId) {
        const hits = this.deps.kb.search(this.deps.config.kbId, '迭代 优化 运维', 5);
        snap.kbHits = hits.map((h) => ({ title: h.docTitle, text: h.text.slice(0, 200), score: h.score }));
      }
      const prompt = buildUserPrompt(snap);
      const llm = await this.deps.llm.chat(
        [ { role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt } ],
        { model: this.model(), timeoutMs: this.deps.config.llmTimeoutMs ?? 60_000 },
      );
      let decision: AgentDecision;
      let ok = true;
      let error: string | undefined;
      try {
        decision = parseDecision(llm.content);
      } catch (e) {
        ok = false;
        error = 'llm_parse_failed: ' + (e instanceof Error ? e.message : String(e));
        decision = { kind: 'none', summary: '(LLM 输出解析失败)', recommendation: '查看 agent 事件日志', confidence: 0, evidence: [String(llm.content).slice(0, 200)] };
      }

      // KB 回写：kind=kb/iteration 且 autoWriteKb 时沉淀
      if (ok && decision.kbNote && this.deps.kb && this.deps.kb.ok && this.deps.config.kbId
          && (decision.kind === 'kb' || decision.kind === 'iteration')
          && (this.deps.config.autoWriteKb !== false)) {
        // upsertDoc 而非 addDoc（manual#392·签字授权）：同题迭代笔记原地更新——
        // addDoc 无判重，agent 每 30 分钟重写同一主题曾把 KB 堆到 159 篇/54 标题（#368）。
        const r2 = this.deps.kb.upsertDoc(this.deps.config.kbId, decision.kbNote.title, decision.kbNote.content, 'agent');
        if ('error' in r2) {
          error = 'kb_write_failed: ' + r2.error;
          ok = false;
        } else {
          this.deps.logger.info('agent.kb_written', { kbId: this.deps.config.kbId, title: decision.kbNote.title, docId: r2.id, mode: 'upsert' });
        }
      }

      // 审计事件（所有决策，含 none，都留痕；运维可回溯 Agent 想什么）
      this.deps.store?.logEvent(ok ? 'info' : 'warn', 'agent.decision', {
        trigger, kind: decision.kind, summary: decision.summary, confidence: decision.confidence,
        evidence: decision.evidence, ok, ...(error ? { error } : {}),
      });

      const run: AgentRunContext = {
        trigger, startedAt: started, durationMs: Date.now() - started, model: this.model(),
        clientId: this.deps.config.clientId ?? '', promptTokens: llm.promptTokens, completionTokens: llm.completionTokens,
        decision, ok, ...(!ok && error ? { error } : {}),
      };
      this.deps.history?.set(run);
      return run;
    } finally {
      this.running = false;
    }
  }
}
