/**
 * P5 执行轨迹（pattern-009/015）在中转站层的降级形态。
 *
 * 中转站看不到客户端 Agent 的多步编排，但**看得到一次请求内部的全部步骤**：
 * auth → precheck → fingerprint → route → upstream_request → upstream_response
 * → classify → retry → stream → meter → respond。
 *
 * 这个 request-level trace 的价值：
 * - 排障：一次失败请求"卡在哪一步"不再靠猜，用户报障可以直接给 traceId。
 * - 复盘：diff 两次失败请求的轨迹，定位是上游抖动还是我们自己的策略问题。
 * - 可视化：管理看板把它当时间线渲染。
 *
 * 写入策略：内存环（同步，零阻塞）+ 可选落库（异步批量，走 Store）。
 */

import type { RelayRequestContext, TraceRecord, TraceStage, TraceStep } from '../core/types.js';
import { RingBuffer, monotonicMs, truncate } from '../util/index.js';

export class TraceBuilder {
  private readonly steps: TraceStep[] = [];
  private readonly startMs: number;
  private failedAtStage: TraceStage | undefined;
  /** 每一步的明细超过这个长度就截断，避免轨迹本身变成新的"原始载荷" */
  private static readonly SUMMARY_MAX = 240;

  constructor(
    readonly traceId: string,
    readonly requestId: string,
    private readonly startedAt: number,
    private readonly maxSteps: number,
    private readonly enabled: boolean,
  ) {
    this.startMs = monotonicMs();
  }

  step(stage: TraceStage, ok: boolean, summary: string, detail?: Record<string, string | number | boolean>, error?: string): void {
    if (!this.enabled) return;
    if (this.steps.length >= this.maxSteps) return;
    const offsetMs = monotonicMs() - this.startMs;
    const s: TraceStep = {
      stage,
      at: this.startedAt + offsetMs,
      offsetMs,
      ok,
      summary: truncate(summary, TraceBuilder.SUMMARY_MAX),
      ...(detail ? { detail } : {}),
      ...(error ? { error: truncate(error, TraceBuilder.SUMMARY_MAX) } : {}),
    };
    this.steps.push(s);
    if (!ok && this.failedAtStage === undefined) this.failedAtStage = stage;
  }

  fail(stage: TraceStage, summary: string, detail?: Record<string, string | number | boolean>, error?: string): void {
    this.step(stage, false, summary, detail, error);
  }

  finish(ctx: RelayRequestContext): TraceRecord {
    return {
      traceId: this.traceId,
      requestId: this.requestId,
      startedAt: this.startedAt,
      durationMs: Math.max(0, Math.round(monotonicMs() - this.startMs)),
      steps: this.steps,
      ...(this.failedAtStage ? { failedAtStage: this.failedAtStage } : {}),
      outcome: ctx.outcome,
    };
  }

  get stepCount(): number {
    return this.steps.length;
  }
}

/** 轨迹仓库：内存环 + 可选持久化 */
export class TraceStore {
  private readonly ring: RingBuffer<TraceRecord>;

  constructor(
    ringSize: number,
    private readonly persist: (t: TraceRecord) => void,
    private readonly enabled = true,
  ) {
    this.ring = new RingBuffer<TraceRecord>(Math.max(10, ringSize));
  }

  save(trace: TraceRecord): void {
    if (!this.enabled) return;
    this.ring.push(trace);
    try {
      this.persist(trace);
    } catch {
      // fail-open：轨迹落盘失败不影响请求
    }
  }

  recent(limit: number): TraceRecord[] {
    return this.ring.toArray().slice(0, limit);
  }

  find(traceId: string): TraceRecord | undefined {
    return this.ring.toArray().find((t) => t.traceId === traceId);
  }

  size(): number {
    return this.ring.size;
  }
}

/* ------------------------------------------------------------------ *
 * 轨迹 diff（P5 的 diff_trails 能力，用于复盘两次请求）
 * ------------------------------------------------------------------ */

export interface TraceDiff {
  traceA: string;
  traceB: string;
  durationDeltaMs: number;
  /** 只在 A 出现的阶段 */
  onlyInA: TraceStage[];
  onlyInB: TraceStage[];
  /** 同阶段但结果不同的（含首次失败阶段不同） */
  diverged: { stage: TraceStage; a?: string; b?: string; aOk?: boolean; bOk?: boolean }[];
  sameOutcome: boolean;
}

export function diffTraces(a: TraceRecord, b: TraceRecord): TraceDiff {
  const stagesA = a.steps.map((s) => s.stage);
  const stagesB = b.steps.map((s) => s.stage);
  const setA = new Set(stagesA);
  const setB = new Set(stagesB);
  const diverged: TraceDiff['diverged'] = [];
  for (const stage of new Set([...stagesA, ...stagesB])) {
    const sa = a.steps.find((s) => s.stage === stage);
    const sb = b.steps.find((s) => s.stage === stage);
    if (!sa || !sb) continue;
    if (sa.ok !== sb.ok || sa.summary !== sb.summary) {
      diverged.push({ stage, a: sa.summary, b: sb.summary, aOk: sa.ok, bOk: sb.ok });
    }
  }
  return {
    traceA: a.traceId,
    traceB: b.traceId,
    durationDeltaMs: b.durationMs - a.durationMs,
    onlyInA: [...setA].filter((s) => !setB.has(s)),
    onlyInB: [...setB].filter((s) => !setA.has(s)),
    diverged,
    sameOutcome: a.outcome === b.outcome,
  };
}

/** 把轨迹渲染成人类可读的时间线（管理看板与 CLI 都用它） */
export function renderTrace(trace: TraceRecord, opts: { color?: boolean } = {}): string {
  const lines: string[] = [];
  const color = opts.color ?? false;
  const dim = (s: string): string => (color ? `\u001b[2m${s}\u001b[0m` : s);
  const red = (s: string): string => (color ? `\u001b[31m${s}\u001b[0m` : s);
  const green = (s: string): string => (color ? `\u001b[32m${s}\u001b[0m` : s);
  lines.push(`trace ${trace.traceId}  request ${trace.requestId}`);
  lines.push(`outcome=${trace.outcome} duration=${trace.durationMs}ms${trace.failedAtStage ? ` failed_at=${trace.failedAtStage}` : ''}`);
  for (const s of trace.steps) {
    const mark = s.ok ? green('ok  ') : red('FAIL');
    const detail = s.detail ? ` ${dim(JSON.stringify(s.detail))}` : '';
    const err = s.error ? ` ${red(s.error)}` : '';
    lines.push(`  +${String(s.offsetMs).padStart(6)}ms ${mark} ${s.stage.padEnd(17)} ${s.summary}${detail}${err}`);
  }
  return lines.join('\n');
}
