/**
 * P8 损耗量化基线（pattern-011 / 042）
 *
 * 「没有度量就没有下一步优化」。本模块只做三件事：
 *   1. 把一次请求的全部降损相关事实压缩成一条 MeterRecord（零侵入：绝不改请求语义）；
 *   2. 从 SSE 增量里重建符号态（stream transcript），用于审计 + 度量"回传体积"；
 *   3. 聚合出可指导决策的摘要（成功/失败、上游错误分布、归因覆盖、无效重试、降损层自身开销）。
 *
 * fail-open：本模块任何异常都必须被吞掉，度量挂了也不能影响转发。
 */

import type {
  ClientFingerprint,
  FailureReason,
  MeterRecord,
  MeterSummary,
  MeterSummaryRow,
  ProviderCost,
  QuickAction,
  RelayRequestContext,
  StreamTranscript,
  TierId,
  UsageBreakdown,
} from '../core/types.js';
import { condenseErrorText, round, safeJsonParse } from '../util/index.js';
import type { Store, DimStats, MeterDimension } from '../store/index.js';

/** 内存回落路径用的维度取键 */
function keyOfDimension(dimension: MeterDimension): (r: MeterRecord) => string {
  switch (dimension) {
    case 'model':
      return (r) => r.model || 'unknown';
    case 'provider_id':
      return (r) => r.providerId || 'unknown';
    case 'tier':
      return (r) => r.tier;
    case 'client_kind':
      return (r) => r.clientKind;
    default:
      return () => 'unknown';
  }
}

/* ------------------------------------------------------------------ *
 * usage 解析与计价
 * ------------------------------------------------------------------ */

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Anthropic 风格 */
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
  cache_read_input_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number; text_tokens?: number };
  reasoning_tokens?: number;
}

/** 归一化不同上游的 usage 字段（OpenAI / DeepSeek / Anthropic 风格）。
 *
 * ⚠️ 2026-09-14 审计 C-6：老实现只认 prompt_tokens/completion_tokens，
 * 注释却写支持 Anthropic —— 实际上 Anthropic 的 input_tokens/output_tokens
 * 没有任何分支 → normalizeUsage 返回 undefined → 全记 0（token 和成本一起没）。
 * 这里把 Anthropic 字段补上；"只有 total_tokens、没有拆分"也照常归一化，
 * 拆分缺失由 computeCost 用"全按输入价"的保守口径兜底，至少不为 0。 */
export function normalizeUsage(raw: unknown): UsageBreakdown | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as RawUsage;
  const prompt = toPositiveNumber(u.prompt_tokens) || toPositiveNumber(u.input_tokens);
  const completion = toPositiveNumber(u.completion_tokens) || toPositiveNumber(u.output_tokens);
  const total = toPositiveNumber(u.total_tokens) || prompt + completion;
  if (total === 0 && prompt === 0 && completion === 0) return undefined;
  const cached = toPositiveNumber(u.prompt_tokens_details?.cached_tokens) || toPositiveNumber(u.prompt_cache_hit_tokens) || toPositiveNumber(u.cache_read_input_tokens);
  const reasoning = toPositiveNumber(u.completion_tokens_details?.reasoning_tokens) || toPositiveNumber(u.reasoning_tokens);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total || prompt + completion,
    ...(cached ? { cachedPromptTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
  };
}

function toPositiveNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 计价：人民币元。cached 部分按 cachedInputPerMTok（缺省则按输入价）计。
 *
 * ⚠️ 2026-09-14 审计 C-6：老实现只按 prompt/completion 计价 —— 上游只回 total_tokens
 * 时成本恒为 0，¥ 预算闸门静默失效（token 额度扣、¥ 额度不扣）。
 * 现在：拆分缺失（prompt+completion 都 0 但 total>0）时按"全部算输入价"保守估算，
 * 至少不为 0。这是估算，方向保守（少算），不是精确值。 */
export function computeCost(usage: UsageBreakdown | undefined, cost: ProviderCost | undefined): number {
  if (!usage || !cost) return 0;
  const cached = usage.cachedPromptTokens ?? 0;
  const uncachedInput = Math.max(0, usage.promptTokens - cached);
  const cachedPrice = cost.cachedInputPerMTok ?? cost.inputPerMTok;
  const inputCost = (uncachedInput / 1_000_000) * cost.inputPerMTok + (cached / 1_000_000) * cachedPrice;
  const outputCost = (usage.completionTokens / 1_000_000) * cost.outputPerMTok;
  if (inputCost + outputCost === 0 && (usage.totalTokens ?? 0) > 0) {
    // 只有 total_tokens、没有拆分：全部按输入价（保守下界），至少让 ¥ 闸门有反应
    return round(((usage.totalTokens ?? 0) / 1_000_000) * cost.inputPerMTok, 8);
  }
  return round(inputCost + outputCost, 8);
}

/* ------------------------------------------------------------------ *
 * SSE 增量 → 符号态（P1 在本层的只读副本：只用于审计与度量，绝不回写给用户）
 * ------------------------------------------------------------------ */

interface DeltaShape {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
}

export function transcriptFromSse(dataLines: string[], malformed = 0): StreamTranscript {
  const t: StreamTranscript = {
    chunkCount: 0,
    contentChars: 0,
    reasoningChars: 0,
    malformedFrames: malformed,
    sawDone: false,
  };
  const toolIndex = new Map<number, { index: number; id?: string; name?: string; argumentBytes: number }>();

  for (const line of dataLines) {
    if (line === '[DONE]') {
      t.sawDone = true;
      continue;
    }
    const obj = safeJsonParse<Record<string, unknown>>(line);
    if (!obj) {
      t.malformedFrames++;
      continue;
    }
    // 流中途的错误帧（OpenRouter 等：HTTP 200 + data:{"error":{...}}）
    if (obj['error'] !== undefined && obj['choices'] === undefined) {
      t.streamError = condenseErrorText(JSON.stringify(obj['error']), 200);
      t.chunkCount++;
      continue;
    }
    t.chunkCount++;
    if (typeof obj['model'] === 'string') t.model = obj['model'] as string;
    if (typeof obj['id'] === 'string') t.responseId = obj['id'] as string;
    const usage = normalizeUsage(obj['usage']);
    if (usage) t.usage = usage;

    const choices = obj['choices'];
    if (!Array.isArray(choices)) continue;
    for (const c of choices) {
      if (!c || typeof c !== 'object') continue;
      const choice = c as Record<string, unknown>;
      if (typeof choice['finish_reason'] === 'string' && choice['finish_reason']) {
        t.finishReason = choice['finish_reason'] as string;
      }
      const delta = (choice['delta'] ?? choice['message']) as DeltaShape | undefined;
      if (!delta || typeof delta !== 'object') continue;
      const content = delta.content;
      if (typeof content === 'string') t.contentChars += content.length;
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string') t.reasoningChars += reasoning.length;
      const calls = delta.tool_calls;
      if (Array.isArray(calls)) {
        for (const call of calls) {
          if (!call || typeof call !== 'object') continue;
          const idx = typeof call.index === 'number' ? call.index : 0;
          const entry = toolIndex.get(idx) ?? { index: idx, argumentBytes: 0 };
          if (typeof call.id === 'string' && call.id) entry.id = call.id;
          const fn = call.function;
          if (fn) {
            if (typeof fn.name === 'string' && fn.name) entry.name = fn.name;
            if (typeof fn.arguments === 'string') entry.argumentBytes += Buffer.byteLength(fn.arguments, 'utf8');
          }
          toolIndex.set(idx, entry);
        }
      }
    }
  }

  if (toolIndex.size > 0) {
    t.toolCalls = [...toolIndex.values()].sort((a, b) => a.index - b.index);
  }
  return t;
}

/* ------------------------------------------------------------------ *
 * 度量器
 * ------------------------------------------------------------------ */

export interface MeterDeps {
  store: Store;
  enabled: boolean;
  hashPayloads: boolean;
}

export interface MeterSnapshot {
  /** 进程生命周期内的累计计数（重启清零，用于实时看板与健康检查） */
  counters: {
    requests: number;
    success: number;
    clientErrors: number;
    upstreamErrors: number;
    relayErrors: number;
    aborted: number;
    precheckBlocked: number;
    precheckDegraded: number;
    attributionCards: number;
    autoRetries: number;
    autoRecovered: number;
    duplicates: number;
  };
  /** 降损层自身耗时累计（微秒） */
  overheadUs: { precheck: number; classify: number; meter: number };
}

export class Meter {
  /**
   * "成功但零 token"的累计条数（进程内计数，重启清零）。
   * 见 record() 里的零 token 守卫 —— 这是"静默少记"的体温计，>0 就必须去看「排障」页。
   */
  private zeroTokenCount = 0;

  private readonly counters: MeterSnapshot['counters'] = {
    requests: 0,
    success: 0,
    clientErrors: 0,
    upstreamErrors: 0,
    relayErrors: 0,
    aborted: 0,
    precheckBlocked: 0,
    precheckDegraded: 0,
    attributionCards: 0,
    autoRetries: 0,
    autoRecovered: 0,
    duplicates: 0,
  };
  private readonly overheadUs = { precheck: 0, classify: 0, meter: 0 };
  private lastError: string | undefined;

  constructor(private readonly deps: MeterDeps) {}

  get enabled(): boolean {
    return this.deps.enabled;
  }

  /** 主路径调用：构造 MeterRecord 并交给 Store（Store 内部只做内存入队） */
  record(ctx: RelayRequestContext, fingerprint: ClientFingerprint, duplicates: number): void {
    if (!this.deps.enabled) return;
    try {
      // 累计计数
      this.counters.requests++;
      if (ctx.outcome === 'success') this.counters.success++;
      else if (ctx.outcome === 'client_error') this.counters.clientErrors++;
      else if (ctx.outcome === 'upstream_error') this.counters.upstreamErrors++;
      else if (ctx.outcome === 'relay_error') this.counters.relayErrors++;
      else this.counters.aborted++;
      if (ctx.precheck?.disposition === 'reject') this.counters.precheckBlocked++;
      if (ctx.precheck?.result.degraded) this.counters.precheckDegraded++;
      if (ctx.attribution) this.counters.attributionCards++;
      if (ctx.routes.length > 1) this.counters.autoRetries += ctx.routes.length - 1;
      if (ctx.routes.length > 1 && ctx.outcome === 'success') this.counters.autoRecovered++;
      if (duplicates > 1) this.counters.duplicates++;
      this.overheadUs.precheck += ctx.overheadUs.precheck;
      this.overheadUs.classify += ctx.overheadUs.classify;

      const usage = ctx.usage;
      const rec: MeterRecord = {
        traceId: ctx.traceId,
        requestId: ctx.requestId,
        ts: ctx.startedAt,
        keyId: ctx.client.keyId,
        tenantId: ctx.client.tenantId,
        tier: ctx.client.tier,
        clientKind: fingerprint.kind,
        agentScore: fingerprint.agentScore,
        model: ctx.requestedModel,
        providerId: ctx.routes.at(-1)?.providerId ?? '',
        stream: ctx.stream,
        toolCalling: ctx.isToolCalling,
        outcome: ctx.outcome,
        httpStatus: ctx.httpStatus ?? 0,
        durationMs: ctx.durationMs,
        ttfbMs: ctx.ttfbMs ?? null,
        bytesIn: ctx.bytesIn,
        bytesOut: ctx.bytesOut,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        cachedPromptTokens: usage?.cachedPromptTokens ?? 0,
        costCny: usage?.costCny ?? 0,
        listCostCny: usage?.listCostCny ?? 0,
        attemptCount: ctx.routes.length,
        failureReason: ctx.attribution?.failure_reason ?? null,
        quickAction: ctx.attribution?.suggested_next.action ?? null,
        recoverable: ctx.attribution ? ctx.attribution.recoverable : null,
        precheckViolations: ctx.precheck?.result.violations.filter((v) => v.severity === 'block').length ?? 0,
        precheckBlocked: ctx.precheck?.disposition === 'reject',
        precheckDegraded: !!ctx.precheck?.result.degraded,
        precheckUs: ctx.overheadUs.precheck,
        classifyUs: ctx.overheadUs.classify,
        attributionDelivered: !!ctx.attribution,
        duplicateInWindow: duplicates,
      };
      this.deps.store.record(rec);

      /*
       * 零 token 守卫：**成功请求却一个 token 都没记上**，是"静默少记"的特征。
       *
       * 2026-09-14 实测过一次代价：375 个流式请求全部记 0，面板显示 11 万 token，
       * 客户实际已消耗上千万 —— 而且它不报错、不告警，面板数字看着还挺正常。
       * 不报错的账比错账更危险，所以这里主动留一条事件，面板「排障 → 事件日志」看得见。
       *
       * 只在"确实产出了内容"时才报（bytesOut>0），避免把空响应也算成异常。
       */
      if (ctx.outcome === 'success' && (rec.totalTokens ?? 0) === 0 && (ctx.bytesOut ?? 0) > 0) {
        this.zeroTokenCount++;
        this.deps.store.logEvent('warn', 'meter.zero_token', {
          requestId: ctx.requestId,
          keyId: ctx.client.keyId,
          model: ctx.requestedModel,
          providerId: rec.providerId,
          stream: ctx.stream,
          bytesOut: ctx.bytesOut,
          hint: '成功但没记到 token：上游没回 usage，或 usage 没被解析到',
        });
      }
    } catch (err) {
      // fail-open
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  snapshot(): MeterSnapshot & { lastError?: string; store: ReturnType<Store['health']>; zeroTokenCount: number } {
    return {
      counters: { ...this.counters },
      overheadUs: { ...this.overheadUs },
      zeroTokenCount: this.zeroTokenCount,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      store: this.deps.store.health(),
    };
  }

  /* ---------------- 汇总（管理看板 / CLI report 共用） ---------------- */

  summarize(windowMs = 24 * 3600 * 1000): MeterSummary {
    const to = Date.now();
    const from = to - windowMs;
    const store = this.deps.store;

    const mkRow = (key: string, since: number): MeterSummaryRow => {
      const s = store.windowStatsPreferPersistent(since);
      return {
        key,
        requests: s.requests,
        errors: s.errors,
        errorRate: s.requests ? round(s.errors / s.requests, 4) : 0,
        totalTokens: s.tokens,
        costCny: s.costCny,
        listCostCny: s.listCostCny,
        p50Ms: 0,
        p95Ms: s.p95DurationMs,
        avgTtfbMs: s.avgDurationMs,
      };
    };

    const overall = mkRow('all', from);

    // 维度拆分：走内存镜像（避免 N 次 SQL），窗口内条数在上限内足够准确
    const dims = this.groupRows(from);
    const attribution = store.attributionStats(from);
    // 开销比必须**两边同口径**：分子分母都用"每次请求的平均值"。
    // 原实现把"平均开销(µs)"乘上总请求数当总量，分母却只统计内存镜像里的耗时 ——
    // 一边是持久化全量、一边是内存残量，于是这个比例会算出 3452% 这种数字，
    // 而看板上紧挨着它的说明还写着"治理层不该超过千分之一"（自相矛盾）。
    // 平均值之比与样本数无关，天然免疫这种口径错配。
    const avgOverheadUs = attribution.overhead.precheckUsAvg + attribution.overhead.classifyUsAvg;
    const avgDurationMs = overall.avgTtfbMs; // 字段名历史遗留，实际是"平均总耗时" 

    const lossReduction: MeterSummary['lossReduction'] = {
      attributionCoverage: attribution.coverage.total ? round(attribution.coverage.delivered / attribution.coverage.total, 4) : 0,
      autoRecovered: attribution.coverage.autoRecovered,
      duplicateRetries: attribution.duplicates,
      precheckBlocked: attribution.precheck.blocked,
      precheckDegraded: attribution.precheck.degraded,
      overheadRatio: avgDurationMs > 0 ? round(avgOverheadUs / 1000 / avgDurationMs, 6) : 0,
    };

    return {
      from,
      to,
      overall,
      byModel: dims.byModel,
      byProvider: dims.byProvider,
      byTier: dims.byTier,
      byClientKind: dims.byClientKind,
      byFailureReason: attribution.byReason.map((r) => ({
        reason: r.reason,
        count: r.count,
        recoverablePct: r.count ? round(r.recoverable / r.count, 4) : 0,
      })),
      byQuickAction: attribution.byAction,
      clientAuthFailures: attribution.clientAuth,
      lossReduction,
    };
  }

  private groupRows(from: number): Pick<MeterSummary, 'byModel' | 'byProvider' | 'byTier' | 'byClientKind'> {
    const empty = { byModel: [], byProvider: [], byTier: [], byClientKind: [] } as Pick<
      MeterSummary,
      'byModel' | 'byProvider' | 'byTier' | 'byClientKind'
    >;
    try {
      // 维度聚合优先走存储层（SQLite 走 SQL），这样进程重启后看板仍有历史数据；
      // 存储层没有持久数据时回落到内存镜像。
      const agg = (dimension: MeterDimension): MeterSummaryRow[] => {
        const stats = this.deps.store.dimensionStats(from, dimension) ?? this.dimStats(from, keyOfDimension(dimension));
        return [...stats.entries()]
          .map(([key, v]) => ({
            key,
            requests: v.requests,
            errors: v.errors,
            errorRate: v.requests ? round(v.errors / v.requests, 4) : 0,
            totalTokens: v.tokens,
            costCny: round(v.cost, 6),
            listCostCny: round(v.listCost, 6),
            p50Ms: 0,
            p95Ms: v.p95,
            avgTtfbMs: v.durationCount ? Math.round(v.durationSum / v.durationCount) : 0,
          }))
          .sort((a, b) => b.requests - a.requests);
      };
      return {
        byModel: agg('model'),
        byProvider: agg('provider_id'),
        byTier: agg('tier'),
        byClientKind: agg('client_kind'),
      };
    } catch {
      return empty;
    }
  }

  /** 维度统计：允许 Store 实现提供更高效的 SQL 版本 */
  private dimStats(
    from: number,
    keyOf: (r: MeterRecord) => string,
  ): Map<string, DimStats> {
    const out = new Map<string, { requests: number; errors: number; tokens: number; cost: number; listCost: number; cachedTokens: number; durations: number[] }>();
    for (const r of this.deps.store.recordsSince(from)) {
      const k = keyOf(r);
      const cur = out.get(k) ?? { requests: 0, errors: 0, tokens: 0, cost: 0, listCost: 0, cachedTokens: 0, durations: [] };
      cur.requests++;
      if (r.outcome !== 'success') cur.errors++;
      cur.tokens += r.totalTokens;
      cur.cost += r.costCny;
      cur.listCost += r.listCostCny ?? 0;
      cur.cachedTokens += r.cachedPromptTokens;
      cur.durations.push(r.durationMs);
      out.set(k, cur);
    }
    const result = new Map<string, DimStats>();
    for (const [k, v] of out) {
      const sorted = [...v.durations].sort((a, b) => a - b);
      result.set(k, {
        requests: v.requests,
        errors: v.errors,
        tokens: v.tokens,
        cost: v.cost,
        listCost: v.listCost,
        cachedTokens: v.cachedTokens,
        durationSum: v.durations.reduce((s, d) => s + d, 0),
        durationCount: v.durations.length,
        p95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! : 0,
      });
    }
    return result;
  }

}

/* ------------------------------------------------------------------ *
 * 降损收益报告（人类可读）：CLI `relay report` 输出
 * ------------------------------------------------------------------ */

export function renderSummary(summary: MeterSummary, opts: { windowLabel?: string } = {}): string {
  const lines: string[] = [];
  const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
  const label = opts.windowLabel ?? '窗口';
  lines.push(`== 中转站损耗度量（${label}） ==`);
  lines.push(
    `请求 ${summary.overall.requests}｜错误 ${summary.overall.errors}（${pct(summary.overall.errorRate)}）｜token ${summary.overall.totalTokens}｜实付成本 ¥${summary.overall.costCny.toFixed(4)}（牌面价 ¥${(summary.overall.listCostCny ?? 0).toFixed(4)}）｜p95 ${summary.overall.p95Ms}ms`,
  );
  lines.push('');
  lines.push('-- 分层 --');
  for (const r of summary.byTier) {
    lines.push(`  ${r.key.padEnd(10)} 请求 ${String(r.requests).padStart(6)}  错误率 ${pct(r.errorRate).padStart(7)}  token ${String(r.totalTokens).padStart(9)}  成本 ¥${r.costCny.toFixed(4)}`);
  }
  lines.push('');
  lines.push('-- 客户端类型（无状态指纹） --');
  for (const r of summary.byClientKind) {
    lines.push(`  ${r.key.padEnd(10)} 请求 ${String(r.requests).padStart(6)}  错误率 ${pct(r.errorRate).padStart(7)}  p95 ${r.p95Ms}ms`);
  }
  lines.push('');
  lines.push('-- 上游 --');
  for (const r of summary.byProvider) {
    lines.push(`  ${r.key.padEnd(14)} 请求 ${String(r.requests).padStart(6)}  错误率 ${pct(r.errorRate).padStart(7)}  token ${String(r.totalTokens).padStart(9)}  成本 ¥${r.costCny.toFixed(4)}`);
  }
  lines.push('');
  lines.push('-- 失败归因（P3） --');
  if (summary.byFailureReason.length === 0) lines.push('  （窗口内无失败）');
  for (const r of summary.byFailureReason) {
    lines.push(`  ${r.reason.padEnd(26)} ${String(r.count).padStart(6)}  可恢复占比 ${pct(r.recoverablePct)}`);
  }
  if (summary.clientAuthFailures.count > 0) {
    lines.push(`  客户端 key 被拒    ${String(summary.clientAuthFailures.count).padStart(6)}  网关 401（key 不是这里签发的/已轮换）`);
  }
  lines.push('');
  lines.push('-- 建议动作分布 --');
  for (const r of summary.byQuickAction) lines.push(`  ${r.action.padEnd(22)} ${String(r.count).padStart(6)}`);
  lines.push('');
  lines.push('-- 降损层收益口径 --');
  lines.push(`  归因投递率        ${pct(summary.lossReduction.attributionCoverage)}（错误被翻译成可执行下一步的比例）`);
  lines.push(`  自动恢复成功      ${summary.lossReduction.autoRecovered}（重试后成功 = 用户少一次人工介入）`);
  lines.push(`  重复请求(60s 窗口) ${summary.lossReduction.duplicateRetries}（疑似无效重试，可引导用户加 turn 缓存）`);
  lines.push(`  预检拦截          ${summary.lossReduction.precheckBlocked}（畸形调用在上游之前被拦下）`);
  lines.push(`  预检降级放行      ${summary.lossReduction.precheckDegraded}（治理层 fail-open 次数，应为 0 或极少）`);
  lines.push(`  降损层开销占比    ${(summary.lossReduction.overheadRatio * 100).toFixed(4)}%（治理层耗时 / 总耗时）`);
  return lines.join('\n');
}
