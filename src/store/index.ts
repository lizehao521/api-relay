/**
 * 存储层：SQLite（默认，node:sqlite）与内存实现，二者共用同一接口。
 *
 * 设计约束（来自评估文档 §3.2 / §8）：
 * - 网关主路径（鉴权、预检、路由、透传）**不依赖数据库**；数据库只承担度量、轨迹、
 *   key/额度/限流的持久化。数据库故障必须能降级为内存，绝不拖垮转发。
 * - 不落盘 prompt / completion 正文，只落哈希、计数、字节数与 token 数。
 * - 写入走批量缓冲，读取只服务管理看板。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FailureReason, MeterRecord, QuickAction, TraceRecord, TierId } from '../core/types.js';
import { percentile, round, safeJsonParse } from '../util/index.js';
import { Logger } from '../core/logger.js';

/* ------------------------------------------------------------------ *
 * 接口
 * ------------------------------------------------------------------ */

export type MeterDimension = 'model' | 'provider_id' | 'tier' | 'client_kind';

/** 未通过鉴权的请求在度量里使用的占位 keyId（不是真的存在这个 key） */
export const UNATTRIBUTED_KEY_ID = 'anonymous';
/**
 * 看板/报表中给"没归属"的请求统一使用的桶名。
 * 曾经它们被记成 model="" / provider="" / tier=free，读起来像"免费层全挂了"，
 * 实际是"根本没人通过鉴权"。口径必须说人话（ADR-016）。
 */
export const UNATTRIBUTED = '(未鉴权)';

export interface DimStats {
  requests: number;
  errors: number;
  tokens: number;
  /** 实付成本 */
  cost: number;
  /** 按刊例价折算的金额（牌面价） */
  listCost: number;
  /** 命中 prompt 缓存的输入 token（成本优化看得见） */
  cachedTokens: number;
  durationSum: number;
  durationCount: number;
  /** 近似 p95（存储层无完整样本时返回 0） */
  p95: number;
}

/** 持久化的客户 key 元数据（不含明文 key，只保留 sha256 哈希） */
export interface StoredKeyMeta {
  keyId: string;
  label: string;
  tier: TierId;
  tenantId: string;
  enabled: boolean;
  allowedModels?: string[];
  expiresAt?: number;
  quotaOverride?: number;
  /** 按钱计的额度（人民币元） */
  costQuotaOverride?: number;
  keyHash: string;
  /** 'config' = 来自配置文件；'panel' = 面板创建（持久化，重启仍在） */
  origin: 'config' | 'panel';
  createdAt: number;
}

/** 额度快照缓存的桶宽（毫秒）。额度是 30 天量级的账，5 秒滞后无关紧要。 */
const QUOTA_BUCKET_MS = 5_000;

export interface WindowStats {
  requests: number;
  errors: number;
  tokens: number;
  /** 实付成本（人民币元） */
  costCny: number;
  /** 按刊例价折算的金额（牌面价，不是实付） */
  listCostCny: number;
  avgDurationMs: number;
  p95DurationMs: number;
}

export interface SeriesPoint {
  ts: number;
  requests: number;
  errors: number;
  tokens: number;
  costCny: number;
  avgDurationMs: number;
}

export interface KeyUsage {
  keyId: string;
  tenantId: string;
  tier: TierId;
  totalTokens: number;
  costCny: number;
  requests: number;
}

export interface AttributionStats {
  byReason: { reason: FailureReason; count: number; recoverable: number }[];
  byAction: { action: QuickAction; count: number }[];
  coverage: { total: number; delivered: number; autoRecovered: number };
  duplicates: number;
  precheck: { violations: number; blocked: number; degraded: number };
  overhead: { precheckUsAvg: number; classifyUsAvg: number; overheadRatioAvg: number };
  /**
   * 客户端 key 鉴权失败（网关 401），与"上游拒绝密钥"是两件事：
   * 前者要用户换 key，后者要运维换上游密钥。混在一个 auth_invalid 里会指错方向。
   * `lastAt` 为窗口内最后一次发生时间（0 = 窗口内没有）。
   */
  clientAuth: { count: number; lastAt: number };
}

export interface StoreHealth {
  driver: 'sqlite' | 'memory';
  ok: boolean;
  path?: string;
  pendingWrites: number;
  lastFlushAt: number | null;
  lastError?: string;
  /** 数据库不可用而静默降级为内存的次数 */
  degradedEvents: number;
}

export interface Store {
  init(): Promise<void>;
  /** 主路径调用：只入内存缓冲，绝不阻塞（fail-open） */
  record(rec: MeterRecord): void;
  recordTrace(trace: TraceRecord): void;
  /** 强制落盘 */
  flush(): Promise<void>;
  close(): Promise<void>;

  windowStats(sinceMs: number): WindowStats;
  /** 窗口总量统计：优先读持久层（重启后仍准确），无持久数据时回落内存镜像 */
  windowStatsPreferPersistent(sinceMs: number): WindowStats;
  /** 窗口内的原始明细（内存镜像，最多最近 5 万条），供维度聚合使用 */
  recordsSince(sinceMs: number): MeterRecord[];
  /**
   * 窗口内最早一条记录的时间（0 = 窗口内没有记录）。
   * 滚动窗口的"下一次释放时刻" = 这个时间 + 窗口长度；
   * 缺了它消费方只能拿窗口左边界去算，结果永远是"刚好一个窗口长度"。
   */
  oldestInWindow(sinceMs: number): number;
  series(sinceMs: number, bucketMs: number): SeriesPoint[];
  keyUsage(keyId: string, sinceMs: number): KeyUsage;
  usageByTier(sinceMs: number): { tier: TierId; tokens: number; costCny: number; requests: number }[];
  attributionStats(sinceMs: number): AttributionStats;
  topErrors(sinceMs: number, limit: number): { reason: FailureReason; count: number; example: string }[];
  /**
   * 直接读持久层的维度聚合（重启后内存镜像为空时也必须能回答"历史用量是多少"）。
   * 返回空 Map 表示该实现没有持久化数据可用，调用方回落到内存镜像。
   */
  dimensionStats(sinceMs: number, dimension: MeterDimension): Map<string, DimStats> | undefined;
  recentPersistedTraces(limit: number): TraceRecord[];
  recentTraces(limit: number): TraceRecord[];
  findTrace(traceId: string): TraceRecord | undefined;
  health(): StoreHealth;
  /** 从数据库恢复的额度快照（进程重启后仍生效） */
  quotaSnapshot(keyId: string, sinceMs: number): { tokens: number; costCny: number; requests: number };
  /** 批量额度快照（P2 修复：消除 N+1 查询，每个 key 使用各自的 windowStart） */
  quotaSnapshotForAll(keyIds: string[], windowStarts: Map<string, number>): Map<string, { tokens: number; costCny: number; requests: number }>;
  /** 限流用：固定窗口计数（内存实现，重启即重置，符合"限流无状态"取向） */
  rateCount(keyId: string, windowStartMs: number): number;
  incrRate(keyId: string, windowStartMs: number): number;
  /** 清理过期明细 */
  prune(retentionDays: number): Promise<number>;

  /* ---------------- 管理面板所需的事件与元数据 ---------------- */

  /** 记录一条运维事件（面板上的每一次写操作都要留痕） */
  logEvent(level: string, kind: string, detail: Record<string, unknown>): void;
  /** 最近运维事件（倒序） */
  listEvents(limit: number): Record<string, unknown>[];
  /** key 元数据（含动态创建的 key），供面板展示与重启后恢复 */
  listKeyMeta(): StoredKeyMeta[];
  /** 软删除 key（保留历史度量，只标记不可用） */
  setKeyMetaEnabled(keyId: string, enabled: boolean): void;
  /** 最近一次额度重置时间（0 = 从未重置），额度周期从这里重新起算 */
  lastQuotaResetAt(keyId: string): number;
  /**
   * 批量版：一次取回多个 key 的重置时间（v410）。
   *
   * 原 `usageForAll` 在循环里逐 key 调 `lastQuotaResetAt`，而后者是
   * `SELECT ts, detail FROM relay_event WHERE kind='quota.reset' ORDER BY id DESC LIMIT 500`
   * + 最多 500 行 JSON 解析。332 个 key 实测 **72ms/请求**——这是 /keys 吞吐被锁在
   * ~46 req/s（与并发度无关）的真正原因（不是 SQL 聚合，聚合只要 7ms）。
   * 语义与逐 key 版**逐字对齐**（同样的 LIMIT 500、同样取最新一条），只是查询次数 N→1。
   */
  lastQuotaResetForAll(keyIds: string[]): Map<string, number>;
  /** 更新 key 元数据（墓碑等场景使用） */
  upsertKeyMeta?(meta: Record<string, unknown>): void;
}

/* ------------------------------------------------------------------ *
 * 内存实现
 * ------------------------------------------------------------------ */

export class MemoryStore implements Store {
  protected readonly records: MeterRecord[] = [];
  protected readonly traces: TraceRecord[] = [];
  protected readonly rate = new Map<string, number>();
  protected pending = 0;
  protected lastFlushAt: number | null = null;
  protected lastError: string | undefined;
  protected degraded = 0;

  async init(): Promise<void> {}

  record(rec: MeterRecord): void {
    this.records.push(rec);
    this.pending++;
  }

  recordTrace(trace: TraceRecord): void {
    this.traces.push(trace);
    if (this.traces.length > 2000) this.traces.splice(0, this.traces.length - 2000);
  }

  async flush(): Promise<void> {
    this.pending = 0;
    this.lastFlushAt = Date.now();
  }

  async close(): Promise<void> {
    await this.flush();
  }

  protected slice(sinceMs: number): MeterRecord[] {
    return this.records.filter((r) => r.ts >= sinceMs);
  }

  recordsSince(sinceMs: number): MeterRecord[] {
    return this.slice(sinceMs);
  }

  oldestInWindow(sinceMs: number): number {
    let oldest = 0;
    for (const r of this.records) {
      if (r.ts < sinceMs) continue;
      if (oldest === 0 || r.ts < oldest) oldest = r.ts;
    }
    return oldest;
  }

  windowStatsPreferPersistent(sinceMs: number): WindowStats {
    return this.windowStats(sinceMs);
  }

  windowStats(sinceMs: number): WindowStats {
    const rows = this.slice(sinceMs);
    const durations = rows.map((r) => r.durationMs).sort((a, b) => a - b);
    return {
      requests: rows.length,
      errors: rows.filter((r) => r.outcome !== 'success').length,
      tokens: rows.reduce((s, r) => s + r.totalTokens, 0),
      costCny: round(rows.reduce((s, r) => s + r.costCny, 0), 6),
      listCostCny: round(rows.reduce((s, r) => s + (r.listCostCny ?? 0), 0), 6),
      avgDurationMs: rows.length ? Math.round(durations.reduce((a, b) => a + b, 0) / rows.length) : 0,
      p95DurationMs: Math.round(percentile(durations, 95)),
    };
  }

  series(sinceMs: number, bucketMs: number): SeriesPoint[] {
    const rows = this.slice(sinceMs);
    const buckets = new Map<number, MeterRecord[]>();
    for (const r of rows) {
      const b = Math.floor(r.ts / bucketMs) * bucketMs;
      const arr = buckets.get(b);
      if (arr) arr.push(r);
      else buckets.set(b, [r]);
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ts, arr]) => ({
        ts,
        requests: arr.length,
        errors: arr.filter((r) => r.outcome !== 'success').length,
        tokens: arr.reduce((s, r) => s + r.totalTokens, 0),
        costCny: round(arr.reduce((s, r) => s + r.costCny, 0), 6),
        avgDurationMs: Math.round(arr.reduce((s, r) => s + r.durationMs, 0) / arr.length),
      }));
  }

  keyUsage(keyId: string, sinceMs: number): KeyUsage {
    const rows = this.slice(sinceMs).filter((r) => r.keyId === keyId);
    const first = rows[0];
    return {
      keyId,
      tenantId: first?.tenantId ?? '',
      tier: first?.tier ?? 'free',
      totalTokens: rows.reduce((s, r) => s + r.totalTokens, 0),
      costCny: round(rows.reduce((s, r) => s + r.costCny, 0), 6),
      requests: rows.length,
    };
  }

  usageByTier(sinceMs: number): { tier: TierId; tokens: number; costCny: number; requests: number }[] {
    const rows = this.slice(sinceMs);
    const map = new Map<TierId, { tokens: number; costCny: number; requests: number }>();
    for (const r of rows) {
      const cur = map.get(r.tier) ?? { tokens: 0, costCny: 0, requests: 0 };
      cur.tokens += r.totalTokens;
      cur.costCny += r.costCny;
      cur.requests++;
      map.set(r.tier, cur);
    }
    return [...map.entries()].map(([tier, v]) => ({ tier, ...v, costCny: round(v.costCny, 6) }));
  }

  attributionStats(sinceMs: number): AttributionStats {
    // 单趟聚合（manual#393·性能第一位）：原实现对窗口做 14 趟 filter/reduce
    // （errors→clientAuth→upstream→delivered→durationSum→overheadUs→autoRecovered→
    // duplicates→violations→blocked→degraded→两个 UsAvg→lastAt），内存镜像越大越亏。
    // 输出字段与取值与原版等价（同一批谓词同一批聚合），已用真实数据双跑比对。
    // 「客户端 key 不对」（网关 401，无上游参与）与「上游拒绝密钥」是两件事——
    // 前者只进 clientAuth，绝不混进 byReason 冒充上游故障（总览横幅指错方向）。
    const rows = this.slice(sinceMs);
    const byReason = new Map<FailureReason, { count: number; recoverable: number }>();
    const byAction = new Map<QuickAction, number>();
    let errors = 0, clientAuth = 0, clientAuthLastAt = 0, delivered = 0;
    let durationSum = 0, overheadUs = 0, precheckUsSum = 0, classifyUsSum = 0;
    let autoRecovered = 0, duplicates = 0, violations = 0, blocked = 0, degraded = 0;
    for (const r of rows) {
      durationSum += r.durationMs;
      precheckUsSum += r.precheckUs;
      classifyUsSum += r.classifyUs;
      overheadUs += r.precheckUs + r.classifyUs;
      if (r.outcome === 'success') {
        if (r.attemptCount > 1) autoRecovered++;
      } else {
        errors++;
        if (r.attributionDelivered) delivered++;
        if (r.failureReason === 'auth_invalid' && !r.providerId) {
          clientAuth++;
          if (r.ts > clientAuthLastAt) clientAuthLastAt = r.ts;
        } else {
          if (r.failureReason) {
            const cur = byReason.get(r.failureReason) ?? { count: 0, recoverable: 0 };
            cur.count++;
            if (r.recoverable) cur.recoverable++;
            byReason.set(r.failureReason, cur);
          }
          if (r.quickAction) byAction.set(r.quickAction, (byAction.get(r.quickAction) ?? 0) + 1);
        }
      }
      if (r.duplicateInWindow > 1) duplicates++;
      violations += r.precheckViolations;
      if (r.precheckBlocked) blocked++;
      if (r.precheckDegraded) degraded++;
    }
    return {
      byReason: [...byReason.entries()]
        .map(([reason, v]) => ({ reason, ...v }))
        .sort((a, b) => b.count - a.count),
      byAction: [...byAction.entries()].map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count),
      coverage: { total: errors, delivered, autoRecovered },
      duplicates,
      precheck: { violations, blocked, degraded },
      overhead: {
        precheckUsAvg: rows.length ? round(precheckUsSum / rows.length, 2) : 0,
        classifyUsAvg: rows.length ? round(classifyUsSum / rows.length, 2) : 0,
        overheadRatioAvg: durationSum ? round(overheadUs / 1000 / durationSum, 6) : 0,
      },
      clientAuth: { count: clientAuth, lastAt: clientAuthLastAt },
    };
  }

  topErrors(sinceMs: number, limit: number): { reason: FailureReason; count: number; example: string }[] {
    const rows = this.slice(sinceMs).filter((r) => r.failureReason);
    const map = new Map<FailureReason, { count: number; example: string }>();
    for (const r of rows) {
      const key = r.failureReason!;
      const cur = map.get(key);
      if (cur) cur.count++;
      else map.set(key, { count: 1, example: `${r.model}@${r.providerId} HTTP ${r.httpStatus}` });
    }
    return [...map.entries()]
      .map(([reason, v]) => ({ reason, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  recentTraces(limit: number): TraceRecord[] {
    return this.traces.slice(-limit).reverse();
  }

  /** 内存实现：直接由内存镜像聚合（等价于 dimensionStats 的默认语义） */
  recentPersistedTraces(limit: number): TraceRecord[] {
    return this.recentTraces(limit);
  }

  dimensionStats(sinceMs: number, dimension: MeterDimension): Map<string, DimStats> | undefined {
    const rows = this.slice(sinceMs);
    if (rows.length === 0) return undefined;
    const out = new Map<string, DimStats & { durations: number[] }>();
    for (const r of rows) {
      const key = dimensionKey(r, dimension);
      const cur = out.get(key) ?? { requests: 0, errors: 0, tokens: 0, cost: 0, listCost: 0, cachedTokens: 0, durationSum: 0, durationCount: 0, p95: 0, durations: [] };
      cur.requests++;
      if (r.outcome !== 'success') cur.errors++;
      cur.tokens += r.totalTokens;
      cur.cost += r.costCny;
      cur.listCost += r.listCostCny ?? 0;
      cur.cachedTokens += r.cachedPromptTokens;
      cur.durationSum += r.durationMs;
      cur.durationCount++;
      cur.durations.push(r.durationMs);
      out.set(key, cur);
    }
    const result = new Map<string, DimStats>();
    for (const [k, v] of out) {
      v.durations.sort((a, b) => a - b);
      result.set(k, {
        requests: v.requests,
        errors: v.errors,
        tokens: v.tokens,
        cost: v.cost,
        listCost: v.listCost,
        cachedTokens: v.cachedTokens,
        durationSum: v.durationSum,
        durationCount: v.durationCount,
        p95: v.durations.length ? v.durations[Math.min(v.durations.length - 1, Math.floor(v.durations.length * 0.95))]! : 0,
      });
    }
    return result;
  }

  findTrace(traceId: string): TraceRecord | undefined {
    return this.traces.find((t) => t.traceId === traceId);
  }

  health(): StoreHealth {
    return {
      driver: 'memory',
      ok: true,
      pendingWrites: this.pending,
      lastFlushAt: this.lastFlushAt,
      degradedEvents: this.degraded,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  quotaSnapshot(keyId: string, sinceMs: number): { tokens: number; costCny: number; requests: number } {
    const u = this.keyUsage(keyId, sinceMs);
    return { tokens: u.totalTokens, costCny: u.costCny, requests: u.requests };
  }

  /**
   * 批量额度快照（内存实现，每个 key 使用各自的 windowStart）。
   *
   * v410 优化：改为**单次遍历** records 聚合。此前是逐 key 调 `quotaSnapshot` →
   * `keyUsage` → `slice()`（`records.filter` 每次都新建数组）+ 再一次 `filter`，
   * 复杂度 O(N_key × M_records) 且伴随 N 次大数组分配。332 key × ~1 万条实测 6.5ms，
   * 是 /keys 修掉重置 N+1 之后的下一个瓶颈（吞吐仍被压在 ~100 req/s）。
   * 单遍后同口径、无分配。
   */
  quotaSnapshotForAll(keyIds: string[], windowStarts: Map<string, number>): Map<string, { tokens: number; costCny: number; requests: number }> {
    const result = new Map<string, { tokens: number; costCny: number; requests: number }>();
    if (keyIds.length === 0) return result;
    const need = new Set(keyIds);
    // 注意：内存镜像用**原始 sinceMs**，不做 5 秒取整——`MemoryStore.quotaSnapshot`
    // 走 `keyUsage` → `slice(sinceMs)`，用的就是原始值。取整只发生在 SQLite 的 DB 侧。
    // （口径必须与逐 key 版逐字一致，否则"批量=逐key"的等价性断言会红。）
    const since = new Map<string, number>();
    for (const keyId of keyIds) since.set(keyId, windowStarts.get(keyId) ?? 0);
    const agg = new Map<string, { tokens: number; costCny: number; requests: number }>();
    for (const r of this.records) {
      if (!need.has(r.keyId)) continue;
      if (r.ts < (since.get(r.keyId) ?? 0)) continue;
      let a = agg.get(r.keyId);
      if (!a) { a = { tokens: 0, costCny: 0, requests: 0 }; agg.set(r.keyId, a); }
      a.tokens += r.totalTokens;
      a.costCny += r.costCny;
      a.requests += 1;
    }
    for (const keyId of keyIds) {
      const a = agg.get(keyId);
      // 与 keyUsage 同口径：costCny 累加后 round(…, 6)
      result.set(keyId, a ? { tokens: a.tokens, costCny: round(a.costCny, 6), requests: a.requests } : { tokens: 0, costCny: 0, requests: 0 });
    }
    return result;
  }

  rateCount(keyId: string, windowStartMs: number): number {
    return this.rate.get(`${keyId}:${windowStartMs}`) ?? 0;
  }

  incrRate(keyId: string, windowStartMs: number): number {
    const k = `${keyId}:${windowStartMs}`;
    const next = (this.rate.get(k) ?? 0) + 1;
    this.rate.set(k, next);
    if (this.rate.size > 20_000) {
      // 清掉过期窗口
      for (const key of this.rate.keys()) {
        const ts = Number(key.slice(key.lastIndexOf(':') + 1));
        if (ts < windowStartMs - 120_000) this.rate.delete(key);
      }
    }
    return next;
  }

  async prune(_retentionDays: number): Promise<number> {
    return 0;
  }

  /* ---------------- 事件与元数据（内存实现） ---------------- */

  protected readonly events: { ts: number; level: string; kind: string; detail: string }[] = [];
  private readonly keyMeta = new Map<string, StoredKeyMeta>();

  /** 供子类（SqliteStore）写入内存镜像：类字段不能通过 super 访问，所以包一层 */
  protected writeKeyMeta(meta: StoredKeyMeta): void {
    this.keyMeta.set(meta.keyId, meta);
  }

  logEvent(level: string, kind: string, detail: Record<string, unknown>): void {
    this.events.push({ ts: Date.now(), level, kind, detail: JSON.stringify(detail) });
    if (this.events.length > 5000) this.events.splice(0, this.events.length - 5000);
  }

  listEvents(limit: number): Record<string, unknown>[] {
    // 与 SQLite 实现保持一致：`detail` 一律返回**对象**（内存实现内部存的是 JSON 字符串）。
    // 两个实现返回不同形态，会让面板不得不在前端写两套解析 —— 2026-09-14 统一掉。
    return this.events
      .slice(-limit)
      .reverse()
      .map((e) => ({
        ts: e.ts,
        level: e.level,
        kind: e.kind,
        detail: safeJsonParse<Record<string, unknown>>(String(e.detail)) ?? {},
      }));
  }

  listKeyMeta(): StoredKeyMeta[] {
    return [...this.keyMeta.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  setKeyMetaEnabled(keyId: string, enabled: boolean): void {
    const meta = this.keyMeta.get(keyId);
    if (meta) meta.enabled = enabled;
  }

  lastQuotaResetAt(keyId: string): number {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!;
      if (e.kind !== 'quota.reset') continue;
      try {
        const detail = JSON.parse(e.detail) as Record<string, unknown>;
        if (detail['keyId'] === keyId) return e.ts;
      } catch {
        /* ignore */
      }
    }
    return 0;
  }

  /**
   * 批量版（v410）：倒序扫一遍事件环，每个 key 只记**首次**遇到（= 最新一条）。
   * 与逐 key 版同语义：都是从最新往回找第一条匹配。
   */
  lastQuotaResetForAll(keyIds: string[]): Map<string, number> {
    const want = new Set(keyIds);
    const out = new Map<string, number>();
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!;
      if (e.kind !== 'quota.reset') continue;
      try {
        const detail = JSON.parse(e.detail) as Record<string, unknown>;
        const kid = detail['keyId'];
        if (typeof kid === 'string' && want.has(kid) && !out.has(kid)) out.set(kid, e.ts);
      } catch {
        /* ignore */
      }
    }
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * SQLite 实现
 * ------------------------------------------------------------------ */

interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  trace_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  client_kind TEXT NOT NULL,
  agent_score REAL NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  stream INTEGER NOT NULL DEFAULT 0,
  tool_calling INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  http_status INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ttfb_ms INTEGER,
  bytes_in INTEGER NOT NULL DEFAULT 0,
  bytes_out INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_prompt_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cny REAL NOT NULL DEFAULT 0,
  list_cost_cny REAL NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  quick_action TEXT,
  recoverable INTEGER,
  precheck_violations INTEGER NOT NULL DEFAULT 0,
  precheck_blocked INTEGER NOT NULL DEFAULT 0,
  precheck_degraded INTEGER NOT NULL DEFAULT 0,
  precheck_us REAL NOT NULL DEFAULT 0,
  classify_us REAL NOT NULL DEFAULT 0,
  attribution_delivered INTEGER NOT NULL DEFAULT 0,
  duplicate_in_window INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_meter_ts ON meter(ts);
CREATE INDEX IF NOT EXISTS idx_meter_key_ts ON meter(key_id, ts);
CREATE INDEX IF NOT EXISTS idx_meter_reason ON meter(failure_reason, ts);
CREATE INDEX IF NOT EXISTS idx_meter_provider ON meter(provider_id, ts);

CREATE TABLE IF NOT EXISTS trace (
  trace_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_ts ON trace(ts);

CREATE TABLE IF NOT EXISTS key_meta (
  key_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  tier TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  allowed_models TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  monthly_quota_override INTEGER,
  cost_quota_override REAL,
  key_hash TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'config'
);
CREATE INDEX IF NOT EXISTS idx_key_meta_hash ON key_meta(key_hash);

CREATE TABLE IF NOT EXISTS key_day_usage (
  -- 历史兼容：**本实现已不再写入/读取**（额度快照走 meter 明细的精确聚合，见 quotaSnapshot）。
  -- 留在 schema 里是为了旧库能打开；不要再照它写"按天分桶"的额度判定（那套已被删除）。
  key_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_cny REAL NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);

CREATE TABLE IF NOT EXISTS breaker_state (
  provider_id TEXT PRIMARY KEY,
  open_until INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_reason TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
`;

const INSERT_METER = `
INSERT INTO meter (
  ts, trace_id, request_id, key_id, tenant_id, tier, client_kind, agent_score, model, provider_id,
  stream, tool_calling, outcome, http_status, duration_ms, ttfb_ms, bytes_in, bytes_out,
  prompt_tokens, completion_tokens, total_tokens, cached_prompt_tokens, cost_cny, list_cost_cny, attempt_count,
  failure_reason, quick_action, recoverable, precheck_violations, precheck_blocked, precheck_degraded,
  precheck_us, classify_us, attribution_delivered, duplicate_in_window
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

export interface SqliteStoreOptions {
  path: string;
  batchSize: number;
  flushIntervalMs: number;
  logger?: Logger;
}

export class SqliteStore extends MemoryStore implements Store {
  private db: SqliteDatabase | undefined;
  private buffer: MeterRecord[] = [];
  private traceBuffer: TraceRecord[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;
  // （已删除：key_day_usage 曾是"按 UTC 天分桶"的额度依据，2026-09-14 改为 meter 明细
  //  精确聚合后它只剩历史意义，写入路径一并删除，见 CREATE TABLE 的注释）
  /** 额度快照的 5 秒桶缓存（见 quotaSnapshot 的说明） */
  private readonly quotaCache = new Map<string, { value: { tokens: number; costCny: number; requests: number }; at: number }>();
  private pendingRate = new Map<string, number>();

  constructor(private readonly opts: SqliteStoreOptions) {
    super();
  }

  override async init(): Promise<void> {
    try {
      const mod = (await import('node:sqlite')) as unknown as SqliteModule;
      mkdirSync(dirname(this.opts.path), { recursive: true });
      const db = new mod.DatabaseSync(this.opts.path);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
      db.exec('PRAGMA busy_timeout = 3000;');
      db.exec(SCHEMA);
      // 轻量迁移：老库的 key_meta 没有 cost_quota_override（按钱计的额度），补上。
      // SQLite 重复 ADD COLUMN 会报错，所以吞掉异常即可（列已存在就是成功）。
      try {
        db.exec('ALTER TABLE key_meta ADD COLUMN cost_quota_override REAL');
      } catch {
        /* 列已存在 */
      }
      // 轻量迁移 2：meter 增加 list_cost_cny（按刊例价折算的第二口径，2026-09-14 加）。
      // 老行的默认 0 = "当时没记牌面价"，不假装有值。
      try {
        db.exec('ALTER TABLE meter ADD COLUMN list_cost_cny REAL NOT NULL DEFAULT 0');
      } catch {
        /* 列已存在 */
      }
      this.db = db;
      this.timer = setInterval(() => {
        void this.flush().catch(() => undefined);
      }, this.opts.flushIntervalMs);
      this.timer.unref();
      this.opts.logger?.info('store.sqlite.ready', { path: this.opts.path });
    } catch (err) {
      // fail-open：数据库不可用则退回纯内存，网关必须继续服务
      this.db = undefined;
      this.degraded++;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.opts.logger?.error('store.sqlite.init_failed_fallback_memory', { error: this.lastError });
    }
  }

  override record(rec: MeterRecord): void {
    super.record(rec);
    this.buffer.push(rec);
    // 内存镜像始终保留最近窗口，保证数据库故障时看板仍有数据
    if (this.records.length > 50_000) this.records.splice(0, this.records.length - 50_000);
    if (this.buffer.length >= this.opts.batchSize) void this.flush().catch(() => undefined);
  }

  override recordTrace(trace: TraceRecord): void {
    super.recordTrace(trace);
    this.traceBuffer.push(trace);
    if (this.traceBuffer.length > 1000) this.traceBuffer.splice(0, this.traceBuffer.length - 1000);
  }

  override async flush(): Promise<void> {
    if (!this.db || this.flushing) {
      this.pending = this.buffer.length;
      return;
    }
    if (this.buffer.length === 0 && this.traceBuffer.length === 0 && this.pendingRate.size === 0) {
      this.lastFlushAt = Date.now();
      this.pending = 0;
      return;
    }
    this.flushing = true;
    const meters = this.buffer.splice(0, this.buffer.length);
    const traces = this.traceBuffer.splice(0, this.traceBuffer.length);
    const rates = new Map(this.pendingRate);
    this.pendingRate.clear();
    try {
      const ins = this.db.prepare(INSERT_METER);
      this.db.exec('BEGIN');
      for (const r of meters) {
        ins.run(
          r.ts, r.traceId, r.requestId, r.keyId, r.tenantId, r.tier, r.clientKind, r.agentScore, r.model, r.providerId,
          r.stream ? 1 : 0, r.toolCalling ? 1 : 0, r.outcome, r.httpStatus, r.durationMs,
          r.ttfbMs === null ? null : Math.round(r.ttfbMs), r.bytesIn, r.bytesOut,
          r.promptTokens, r.completionTokens, r.totalTokens, r.cachedPromptTokens, r.costCny, r.listCostCny ?? 0, r.attemptCount,
          r.failureReason, r.quickAction, r.recoverable === null ? null : r.recoverable ? 1 : 0,
          r.precheckViolations, r.precheckBlocked ? 1 : 0, r.precheckDegraded ? 1 : 0,
          r.precheckUs, r.classifyUs, r.attributionDelivered ? 1 : 0, r.duplicateInWindow,
        );
      }
      const insTrace = this.db.prepare(
        'INSERT OR REPLACE INTO trace (trace_id, ts, request_id, outcome, duration_ms, payload) VALUES (?,?,?,?,?,?)',
      );
      for (const t of traces) {
        insTrace.run(t.traceId, t.startedAt, t.requestId, t.outcome, t.durationMs, JSON.stringify(t));
      }
      this.db.exec('COMMIT');
      this.lastFlushAt = Date.now();
      this.lastError = undefined;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      this.lastError = err instanceof Error ? err.message : String(err);
      this.degraded++;
      this.opts.logger?.error('store.sqlite.flush_failed', { error: this.lastError, dropped: meters.length });
      /*
       * **重新入队，不能丢账**（2026-09-14 审计 C-4）。
       *
       * 老代码 catch 里 ROLLBACK 完就结束了 —— 本批记账（含额度）**永久消失**，
       * 面板当场看不出（内存镜像还在），重启后连面板也没了；额度没加上 = 客户白用。
       * 现在把本批拼回**队首**，下一次 flush 自动重试。
       *
       * 代价：DB 长期不可用时缓冲会堆积 —— 这是"宁可占内存也不丢账"的取舍，
       * degraded/lastError 已经立了证据。堆过上限就丢最旧的并**大声**记一笔，
       * 不能无声无息涨到 OOM。
       */
      this.buffer = meters.concat(this.buffer);
      this.traceBuffer = traces.concat(this.traceBuffer);
      for (const [k, v] of rates) this.pendingRate.set(k, v);
      const FLUSH_REQUEUE_CAP = 100_000;
      if (this.buffer.length > FLUSH_REQUEUE_CAP) {
        const over = this.buffer.length - FLUSH_REQUEUE_CAP;
        this.buffer.splice(FLUSH_REQUEUE_CAP, over);
        this.opts.logger?.error('store.sqlite.flush_buffer_overflow', { droppedOldest: over, kept: FLUSH_REQUEUE_CAP });
      }
    } finally {
      this.flushing = false;
      this.pending = this.buffer.length;
    }
  }

  override async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush().catch(() => undefined);
    try {
      this.db?.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      this.db?.close();
    } catch {
      /* ignore */
    }
  }

  override health(): StoreHealth {
    return {
      driver: 'sqlite',
      ok: !!this.db,
      path: this.opts.path,
      pendingWrites: this.buffer.length,
      lastFlushAt: this.lastFlushAt,
      degradedEvents: this.degraded,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /**
   * 额度快照：**按精确时间**从 `meter` 明细聚合（2026-09-14 交叉审计后重写）。
   *
   * 老实现按 UTC **天**分桶（`day >= floor(sinceMs/86400000)`），有两个错：
   *  ① **月中「重置额度」不生效** —— 窗口起点落在当天，但"当天已用的量"照样被算进来，
   *     客户仍然被 402 拦到次日；而 402 的文案承诺"重置后可在面板立刻恢复"。
   *     运营唯一的补救动作静默失效（内存实现按精确 ts，等于同一套代码两条口径）。
   *  ② **30 天滑动窗口多算最旧那天**（整天算进来，最多多 24 小时）→ 提前拦人。
   *
   * `meter` 上有 `(key_id, ts)` 索引，按 ts 范围聚合是索引扫描；再加一层 5 秒桶缓存，
   * 既够准，又不会让降损层成为瓶颈（"治理层不该成为瓶颈"是本项目的红线之一）。
   *
   * **口径要说实话**（2026-09-14 复核纠正）：窗口边界会被**向下取整到 5 秒桶**，
   * 所以重置后仍可能算上重置前最多 5 秒的用量。方向是保守（多算，不会漏拦），
   * 量级也小；但"按精确 ts 聚合""重置后立即生效"这种说法是夸大的，不要再这么写。
   * 桶缓存键带上 sinceMs：重置后 sinceMs 变成本刻 → 换键 → 重新计算，不需要额外失效。
   */
  override quotaSnapshot(keyId: string, sinceMs: number): { tokens: number; costCny: number; requests: number } {
    if (!this.db) return super.quotaSnapshot(keyId, sinceMs);
    // 窗口边界按 5 秒取整：额度是"30 天量级"的账，5 秒的滞后无关紧要
    const bucket = Math.floor(sinceMs / QUOTA_BUCKET_MS) * QUOTA_BUCKET_MS;
    const cacheKey = `${keyId}:${bucket}`;
    const now = Date.now();
    const hit = this.quotaCache.get(cacheKey);
    if (hit && now - hit.at < QUOTA_BUCKET_MS) return hit.value;
    try {
      const row = this.db
        .prepare(
          `SELECT COALESCE(SUM(total_tokens), 0) AS tokens,
                  COALESCE(SUM(cost_cny), 0)     AS cost,
                  COUNT(*)                       AS requests
             FROM meter WHERE key_id = ? AND ts >= ?`,
        )
        .get(keyId, bucket) as { tokens?: number; cost?: number; requests?: number } | undefined;
      const dbValue = {
        tokens: Number(row?.tokens ?? 0),
        costCny: Number(row?.cost ?? 0),
        requests: Number(row?.requests ?? 0),
      };
      /*
       * ⚠️ **必须缓存"解析后"的值，而且必须与内存镜像取最大**（2026-09-14 复核抓到的回归）。
       *
       * 第一版这里是「库里有行就用库，否则用内存」—— **但拿库值去写缓存**。后果很严重：
       * 批量落盘之前库里是空的，那一次算出的 **0 被写进缓存并复用满一个 5 秒桶**，
       * 额度闸门因此失明 5~10 秒。实测（生产参数 batchSize=200/flush=2s、20 req/s、10 万额度）：
       * **放行 13.3 万 token 才第一次拦住（超额 33%）**；48 req/s 时超 3.3 倍。
       * 也就是说"修额度"的补丁自己把额度弄瞎了。
       *
       * 现在的口径：
       *   · 内存镜像是"已记录的每一行"，只受 50k 上限约束 —— 它既**最新**（库是批量落盘的），
       *     通常也是**超集**；库更全的唯一情形是重启后内存为空、或窗口内行数超过内存上限。
       *   · 所以**逐项取最大**：两个方向都不会少算。少算 = 闸门失明；多算只是保守。
       *   · 缓存里存的就是这个解析后的值，命中时直接返回它是安全的。
       */
      const memValue = super.quotaSnapshot(keyId, sinceMs);
      const resolved = {
        tokens: Math.max(dbValue.tokens, memValue.tokens),
        costCny: Math.max(dbValue.costCny, memValue.costCny),
        requests: Math.max(dbValue.requests, memValue.requests),
      };
      this.quotaCache.set(cacheKey, { value: resolved, at: now });
      if (this.quotaCache.size > 512) {
        // 简单淘汰：把最旧的一半扔掉（键是 5 秒桶，活着的基本只有最近几个）
        const entries = [...this.quotaCache.entries()].sort((a, b) => a[1].at - b[1].at);
        for (const [k] of entries.slice(0, entries.length >> 1)) this.quotaCache.delete(k);
      }
      return resolved;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return super.quotaSnapshot(keyId, sinceMs);
    }
  }

  override rateCount(keyId: string, windowStartMs: number): number {
    return this.pendingRate.get(`${keyId}:${windowStartMs}`) ?? super.rateCount(keyId, windowStartMs);
  }

  override incrRate(keyId: string, windowStartMs: number): number {
    const next = super.incrRate(keyId, windowStartMs);
    this.pendingRate.set(`${keyId}:${windowStartMs}`, next);
    return next;
  }

  /**
   * 批量额度快照（SQLite 实现，每个 key 使用各自的 windowStart）。
   *
   * ⚠️ **v410 修一个我自己引入的正确性回归**：第一版 SQL 只写了
   * `WHERE key_id IN (...) GROUP BY key_id`——**没有 ts 过滤**，上面算好的 `buckets`
   * 变量根本没进 SQL（算了没用，是死变量）。后果：批量版返回的是**全时聚合**，
   * 而逐 key 的 `quotaSnapshot` 返回窗口内聚合，两者口径不一致。
   *
   * 为什么危险：`windowStart = max(now - 30d, 最近一次额度重置)`。DB 目前只积了 20 天，
   * 30 天窗口恰好等于全时，所以**看起来是对的**；但运营点一次「重置额度」后
   * windowStart 变成本刻，批量版仍把全部历史算进来 → 面板上这个 key 依旧显示「已用完」，
   * **运营唯一的补救动作静默失效**（这正是 `quotaSnapshot` 注释里记着的老坑，被我在
   * 换批量实现时又踩了一遍）。实测（1 小时窗口）：逐 key = 0 token，批量 = 98,716,917 token。
   *
   * 修法：按 windowStart 的 5 秒桶**分组**，每组一条带 `AND ts >= ?` 的查询。
   * 常见情形（无重置）只有 1 个桶 = 仍然 1 条 SQL；有重置的 key 各占一组，组数=重置过的 key 数，
   * 远小于 N。这样既保住"不做 N+1"，也保住与逐 key 版**逐字一致的口径**。
   */
  override quotaSnapshotForAll(keyIds: string[], windowStarts: Map<string, number>): Map<string, { tokens: number; costCny: number; requests: number }> {
    const result = new Map<string, { tokens: number; costCny: number; requests: number }>();
    if (keyIds.length === 0) return result;
    if (!this.db) {
      // 无 DB：回退到逐个查询
      for (const keyId of keyIds) {
        const sinceMs = windowStarts.get(keyId) ?? 0;
        result.set(keyId, this.quotaSnapshot(keyId, sinceMs));
      }
      return result;
    }
    const bucketOf = (keyId: string): number => {
      const sinceMs = windowStarts.get(keyId) ?? 0;
      return Math.floor(sinceMs / QUOTA_BUCKET_MS) * QUOTA_BUCKET_MS;
    };
    try {
      // 按 5 秒桶分组：同桶的 key 共用一条 SQL（桶边界即 quotaSnapshot 里的 bucket，口径一致）
      const groups = new Map<number, string[]>();
      for (const keyId of keyIds) {
        const b = bucketOf(keyId);
        const arr = groups.get(b);
        if (arr) arr.push(keyId);
        else groups.set(b, [keyId]);
      }
      const dbMap = new Map<string, { tokens: number; costCny: number; requests: number }>();
      // 单条 SQL 的占位符上限保护：组内 key 数按 500 切块（SQLite 变量上限 999，留足余量）
      const CHUNK = 500;
      for (const [bucket, ids] of groups) {
        for (let i = 0; i < ids.length; i += CHUNK) {
          const slice = ids.slice(i, i + CHUNK);
          const placeholders = slice.map(() => '?').join(',');
          const rows = this.db
            .prepare(
              `SELECT key_id,
                      COALESCE(SUM(total_tokens), 0) AS tokens,
                      COALESCE(SUM(cost_cny), 0)     AS cost,
                      COUNT(*)                       AS requests
                 FROM meter WHERE key_id IN (${placeholders}) AND ts >= ?
                GROUP BY key_id`,
            )
            .all(...slice, bucket) as { key_id: string; tokens?: number; cost?: number; requests?: number }[];
          for (const row of rows) {
            dbMap.set(row.key_id, {
              tokens: Number(row.tokens ?? 0),
              costCny: Number(row.cost ?? 0),
              requests: Number(row.requests ?? 0),
            });
          }
        }
      }
      // 逐项取最大（与 quotaSnapshot 同口径：内存镜像是超集）
      // v410 优化：内存侧也走批量单遍（此前逐 key 调 super.quotaSnapshot → 每次都
      // filter 整个 records 数组，O(N×M) + N 次大数组分配，是 /keys 的第二个瓶颈）
      const memAll = super.quotaSnapshotForAll(keyIds, windowStarts);
      for (const keyId of keyIds) {
        const dbValue = dbMap.get(keyId) ?? { tokens: 0, costCny: 0, requests: 0 };
        const memValue = memAll.get(keyId) ?? { tokens: 0, costCny: 0, requests: 0 };
        result.set(keyId, {
          tokens: Math.max(dbValue.tokens, memValue.tokens),
          costCny: Math.max(dbValue.costCny, memValue.costCny),
          requests: Math.max(dbValue.requests, memValue.requests),
        });
      }
      return result;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      // 回退到逐个查询
      for (const keyId of keyIds) {
        const sinceMs = windowStarts.get(keyId) ?? 0;
        result.set(keyId, this.quotaSnapshot(keyId, sinceMs));
      }
      return result;
    }
  }

  /**
   * 时序桶：走 SQL 分组（内存镜像在重启后是空的，直接用它会让柱状图空白）。
   * 这是同一类问题的第三处：额度计数、轨迹、时序，都必须读持久层。
   */
  override series(sinceMs: number, bucketMs: number): SeriesPoint[] {
    if (!this.db) return super.series(sinceMs, bucketMs);
    try {
      const rows = this.db
        .prepare(
          // 必须显式整数化：node:sqlite 把 JS 数字按 REAL 绑定，`(ts / ?) * ?` 于是变成
          // 浮点除法再乘回去 —— 结果≈原 ts，GROUP BY 就退化成了"每条记录一个桶"。
          // 表现是 24h 窗口返回 85 个桶、柱状图实际是"每请求一根柱"（对外完全看不出来）。
          `SELECT CAST(ts / CAST(? AS INTEGER) AS INTEGER) * CAST(? AS INTEGER) AS bucket,
                  COUNT(*) AS requests,
                  SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) AS errors,
                  SUM(total_tokens) AS tokens,
                  SUM(cost_cny) AS cost,
                  AVG(duration_ms) AS avg_ms
             FROM meter WHERE ts >= ?
            GROUP BY bucket ORDER BY bucket`,
        )
        .all(bucketMs, bucketMs, sinceMs) as Record<string, unknown>[];
      if (rows.length === 0) return super.series(sinceMs, bucketMs);
      return rows.map((r) => ({
        ts: Number(r['bucket'] ?? 0),
        requests: Number(r['requests'] ?? 0),
        errors: Number(r['errors'] ?? 0),
        tokens: Number(r['tokens'] ?? 0),
        costCny: round(Number(r['cost'] ?? 0), 6),
        avgDurationMs: Math.round(Number(r['avg_ms'] ?? 0)),
      }));
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return super.series(sinceMs, bucketMs);
    }
  }

  /** 从库里取窗口内最早一条记录的时间（重启后依然正确） */
  override oldestInWindow(sinceMs: number): number {
    if (!this.db) return super.oldestInWindow(sinceMs);
    try {
      const row = this.db.prepare('SELECT MIN(ts) AS t FROM meter WHERE ts >= ?').get(sinceMs) as { t?: number | null } | undefined;
      return Number(row?.t ?? 0);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return super.oldestInWindow(sinceMs);
    }
  }

  override async prune(retentionDays: number): Promise<number> {
    if (!this.db) return 0;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    try {
      const r1 = this.db.prepare('DELETE FROM meter WHERE ts < ?').run(cutoff);
      const r2 = this.db.prepare('DELETE FROM trace WHERE ts < ?').run(cutoff);
      return Number(r1.changes) + Number(r2.changes);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return 0;
    }
  }

  /* ---------------- 离线/跨重启聚合（直接读 SQL） ---------------- */

  /**
   * 从库里做维度聚合。重启后内存镜像为空，看板必须仍能回答"历史用量是多少"。
   * 存储层没有完整延迟样本，因此 p95 用 duration 排序取位（SQLite 上代价可控，
   * 因为窗口通常 ≤ 30 天且有 ts 索引）。
   */
  override dimensionStats(sinceMs: number, dimension: MeterDimension): Map<string, DimStats> | undefined {
    if (!this.db) return super.dimensionStats(sinceMs, dimension);
    const col = dimension;
    // 与内存实现 dimensionKey() 保持**逐字一致**的桶名。
    // 曾经这里直接取列值，内存路径取 'unknown'，于是同一天的数据在两条路径下
    // 是 "" 和 "unknown" 两个桶，看板上看起来像两拨不同的流量。
    const bucket = `CASE WHEN key_id = '${UNATTRIBUTED_KEY_ID}' THEN '${UNATTRIBUTED}' ELSE COALESCE(NULLIF(${col}, ''), 'unknown') END`;
    try {
      const rows = this.db
        .prepare(
          `SELECT ${bucket} AS k,
                  COUNT(*) AS requests,
                  SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) AS errors,
                  SUM(total_tokens) AS tokens,
                  SUM(cost_cny) AS cost,
                  SUM(list_cost_cny) AS list_cost,
                  SUM(cached_prompt_tokens) AS cached_tokens,
                  SUM(duration_ms) AS duration_sum
             FROM meter WHERE ts >= ? GROUP BY k`,
        )
        .all(sinceMs) as Record<string, unknown>[];
      if (rows.length === 0) return super.dimensionStats(sinceMs, dimension);
      const out = new Map<string, DimStats>();
      for (const r of rows) {
        const key = String(r['k'] ?? '');
        const p95row = this.db
          .prepare(
            `SELECT duration_ms FROM meter WHERE ts >= ? AND ${bucket} = ? ORDER BY duration_ms LIMIT 1 OFFSET (
               SELECT CAST(COUNT(*) * 0.95 AS INT) FROM meter WHERE ts >= ? AND ${bucket} = ?
             )`,
          )
          .get(sinceMs, key, sinceMs, key) as { duration_ms?: number } | undefined;
        out.set(key, {
          requests: Number(r['requests'] ?? 0),
          errors: Number(r['errors'] ?? 0),
          tokens: Number(r['tokens'] ?? 0),
          cost: Number(r['cost'] ?? 0),
          listCost: Number(r['list_cost'] ?? 0),
          cachedTokens: Number(r['cached_tokens'] ?? 0),
          durationSum: Number(r['duration_sum'] ?? 0),
          durationCount: Number(r['requests'] ?? 0),
          p95: Number(p95row?.duration_ms ?? 0),
        });
      }
      return out;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return super.dimensionStats(sinceMs, dimension);
    }
  }

  /**
   * 从库里做失败归因聚合。
   *
   * 这一条曾经漏改持久化读，后果很具体：`byModel/byTier/byProvider` 走 SQL（重启后仍答得出
   * "202 次鉴权失败"），`byFailureReason/byQuickAction/lossReduction` 走内存（重启后只剩 1 条），
   * 同一个看板自己跟自己矛盾；总览页那条"上游拒绝了你配置的密钥"横幅也因为它永远不触发。
   * 从用户视角看就是"评测时 API 全天 401，面板却说一切正常"（ADR-016）。
   */
  override attributionStats(sinceMs: number): AttributionStats {
    if (!this.db) return super.attributionStats(sinceMs);
    try {
      const rows = this.db.prepare('SELECT COUNT(*) AS n FROM meter WHERE ts >= ?').get(sinceMs) as
        | { n?: number }
        | undefined;
      if (!rows || Number(rows.n ?? 0) === 0) return super.attributionStats(sinceMs);

      const byReason = this.db
        .prepare(
          `SELECT failure_reason AS reason, COUNT(*) AS c, SUM(recoverable) AS rec
             FROM meter
            WHERE ts >= ? AND outcome != 'success' AND failure_reason IS NOT NULL
              AND NOT (failure_reason = 'auth_invalid' AND COALESCE(provider_id, '') = '')
            GROUP BY failure_reason`,
        )
        .all(sinceMs) as { reason: string; c: number; rec: number | null }[];
      const byAction = this.db
        .prepare(
          `SELECT quick_action AS action, COUNT(*) AS c
             FROM meter
            WHERE ts >= ? AND quick_action IS NOT NULL
              AND NOT (failure_reason = 'auth_invalid' AND COALESCE(provider_id, '') = '')
            GROUP BY quick_action`,
        )
        .all(sinceMs) as { action: string; c: number }[];
      const agg = this.db
        .prepare(
          `SELECT COUNT(*) AS n,
                  SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) AS errors,
                  SUM(CASE WHEN outcome != 'success' AND attribution_delivered = 1 THEN 1 ELSE 0 END) AS delivered,
                  SUM(CASE WHEN outcome = 'success' AND attempt_count > 1 THEN 1 ELSE 0 END) AS auto_recovered,
                  SUM(CASE WHEN duplicate_in_window > 1 THEN 1 ELSE 0 END) AS duplicates,
                  SUM(precheck_violations) AS pv,
                  SUM(precheck_blocked) AS pb,
                  SUM(precheck_degraded) AS pd,
                  SUM(precheck_us) AS pus,
                  SUM(classify_us) AS cus,
                  SUM(duration_ms) AS dur,
                  SUM(CASE WHEN failure_reason = 'auth_invalid' AND COALESCE(provider_id, '') = '' THEN 1 ELSE 0 END) AS client_auth,
                  MAX(CASE WHEN failure_reason = 'auth_invalid' AND COALESCE(provider_id, '') = '' THEN ts ELSE 0 END) AS client_auth_last
             FROM meter WHERE ts >= ?`,
        )
        .get(sinceMs) as Record<string, unknown>;

      const n = Number(agg['n'] ?? 0);
      const durSum = Number(agg['dur'] ?? 0);
      const overheadUs = Number(agg['pus'] ?? 0) + Number(agg['cus'] ?? 0);
      return {
        byReason: byReason
          .map((r) => ({ reason: r.reason as FailureReason, count: Number(r.c), recoverable: Number(r.rec ?? 0) }))
          .sort((a, b) => b.count - a.count),
        byAction: byAction.map((r) => ({ action: r.action as QuickAction, count: Number(r.c) })).sort((a, b) => b.count - a.count),
        coverage: {
          total: Number(agg['errors'] ?? 0),
          delivered: Number(agg['delivered'] ?? 0),
          autoRecovered: Number(agg['auto_recovered'] ?? 0),
        },
        duplicates: Number(agg['duplicates'] ?? 0),
        precheck: { violations: Number(agg['pv'] ?? 0), blocked: Number(agg['pb'] ?? 0), degraded: Number(agg['pd'] ?? 0) },
        overhead: {
          precheckUsAvg: n ? round(Number(agg['pus'] ?? 0) / n, 2) : 0,
          classifyUsAvg: n ? round(Number(agg['cus'] ?? 0) / n, 2) : 0,
          overheadRatioAvg: durSum ? round(overheadUs / 1000 / durSum, 6) : 0,
        },
        clientAuth: { count: Number(agg['client_auth'] ?? 0), lastAt: Number(agg['client_auth_last'] ?? 0) },
      };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return super.attributionStats(sinceMs);
    }
  }

  /** 从库里读最近轨迹（重启后仍可复盘） */
  override recentPersistedTraces(limit: number): TraceRecord[] {
    const memory = this.recentTraces(limit);
    if (memory.length >= limit || !this.db) return memory;
    try {
      const rows = this.db.prepare('SELECT payload FROM trace ORDER BY ts DESC LIMIT ?').all(limit) as { payload: string }[];
      const persisted = rows.map((r) => safeJsonParse<TraceRecord>(r.payload)).filter((t): t is TraceRecord => !!t);
      // 内存优先（更新），用库补齐重启前的历史
      const seen = new Set(memory.map((t) => t.traceId));
      return [...memory, ...persisted.filter((t) => !seen.has(t.traceId))].slice(0, limit);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return memory;
    }
  }

  /**
   * 窗口总量统计：优先读持久层。
   * 这样进程重启后（内存镜像为空）看板依然能给出正确的历史数字，
   * 而正常运行时也避免"内存镜像被 5 万条上限截断"导致的低估。
   */
  override windowStatsPreferPersistent(sinceMs: number): WindowStats {
    if (!this.db) return super.windowStats(sinceMs);
    const persistent = this.sqlWindowStats(sinceMs);
    // 持久有数直接用（manual#393·性能第一位）：原实现无条件再算一遍内存镜像
    // （filter+sort 全窗口），只在持久为零（刚写入未 flush）时才需要它兜底——
    // SQL 有索引且窗口聚合实测 ~0.9ms，内存那份在常走路径纯属白算。
    if (persistent.requests > 0) return persistent;
    return super.windowStats(sinceMs);
  }

  /** 从库里做真实聚合，用于长时间窗看板（内存镜像只有最近 5 万条） */
  sqlWindowStats(sinceMs: number): WindowStats {
    if (!this.db) return super.windowStats(sinceMs);
    try {
      const rows = this.db
        .prepare(
          `SELECT COUNT(*) AS requests,
                  SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) AS errors,
                  SUM(total_tokens) AS tokens,
                  SUM(cost_cny) AS cost,
                  SUM(list_cost_cny) AS list_cost,
                  AVG(duration_ms) AS avg_ms
             FROM meter WHERE ts >= ?`,
        )
        .get(sinceMs) as Record<string, number | null> | undefined;
      const p95row = this.db
        .prepare('SELECT duration_ms FROM meter WHERE ts >= ? ORDER BY duration_ms LIMIT 1 OFFSET (SELECT CAST(COUNT(*)*0.95 AS INT) FROM meter WHERE ts >= ?)')
        .get(sinceMs, sinceMs) as { duration_ms: number } | undefined;
      return {
        requests: Number(rows?.['requests'] ?? 0),
        errors: Number(rows?.['errors'] ?? 0),
        tokens: Number(rows?.['tokens'] ?? 0),
        costCny: round(Number(rows?.['cost'] ?? 0), 6),
        listCostCny: round(Number(rows?.['list_cost'] ?? 0), 6),
        avgDurationMs: Math.round(Number(rows?.['avg_ms'] ?? 0)),
        p95DurationMs: Number(p95row?.duration_ms ?? 0),
      };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return super.windowStats(sinceMs);
    }
  }

  /** 从库里读轨迹（重启后仍可复盘） */
  sqlFindTrace(traceId: string): TraceRecord | undefined {
    const memory = this.findTrace(traceId);
    if (memory) return memory;
    if (!this.db) return undefined;
    try {
      const row = this.db.prepare('SELECT payload FROM trace WHERE trace_id = ?').get(traceId) as { payload: string } | undefined;
      if (!row) return undefined;
      return safeJsonParse<TraceRecord>(row.payload);
    } catch {
      return undefined;
    }
  }

  /* ---------------- key 元数据持久化 ---------------- */

  upsertKeyMeta(meta: {
    keyId: string;
    label: string;
    tier: TierId;
    tenantId: string;
    enabled: boolean;
    allowedModels?: string[];
    expiresAt?: number;
    quotaOverride?: number;
    costQuotaOverride?: number;
    keyHash: string;
    origin: 'config' | 'panel';
  }): void {
    // 内存镜像始终更新（面板读取走它，避免每次都要碰磁盘）
    this.writeKeyMeta({
      keyId: meta.keyId,
      label: meta.label,
      tier: meta.tier,
      tenantId: meta.tenantId,
      enabled: meta.enabled,
      ...(meta.allowedModels ? { allowedModels: meta.allowedModels } : {}),
      ...(meta.expiresAt !== undefined ? { expiresAt: meta.expiresAt } : {}),
      ...(meta.quotaOverride !== undefined ? { quotaOverride: meta.quotaOverride } : {}),
      ...(meta.costQuotaOverride !== undefined ? { costQuotaOverride: meta.costQuotaOverride } : {}),
      keyHash: meta.keyHash,
      origin: meta.origin,
      createdAt: Date.now(),
    });
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT INTO key_meta (key_id, label, tier, tenant_id, enabled, allowed_models, expires_at, created_at, monthly_quota_override, cost_quota_override, key_hash, origin)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(key_id) DO UPDATE SET
             label = excluded.label, tier = excluded.tier, tenant_id = excluded.tenant_id,
             enabled = excluded.enabled, allowed_models = excluded.allowed_models,
             expires_at = excluded.expires_at, monthly_quota_override = excluded.monthly_quota_override,
             cost_quota_override = excluded.cost_quota_override,
             key_hash = excluded.key_hash, origin = excluded.origin`,
        )
        .run(
          meta.keyId, meta.label, meta.tier, meta.tenantId, meta.enabled ? 1 : 0,
          meta.allowedModels ? JSON.stringify(meta.allowedModels) : null,
          meta.expiresAt ?? null, Date.now(), meta.quotaOverride ?? null,
          meta.costQuotaOverride ?? null,
          meta.keyHash, meta.origin,
        );
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /** 熔断状态持久化：进程重启后上游不该马上被重新打爆 */
  saveBreaker(providerId: string, state: { openUntil: number; consecutiveFailures: number; lastReason?: string }): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT INTO breaker_state (provider_id, open_until, consecutive_failures, last_reason, updated_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(provider_id) DO UPDATE SET
             open_until = excluded.open_until,
             consecutive_failures = excluded.consecutive_failures,
             last_reason = excluded.last_reason,
             updated_at = excluded.updated_at`,
        )
        .run(providerId, state.openUntil, state.consecutiveFailures, state.lastReason ?? null, Date.now());
    } catch {
      /* fail-open */
    }
  }

  loadBreakers(): Map<string, { openUntil: number; consecutiveFailures: number; lastReason?: string }> {
    const out = new Map<string, { openUntil: number; consecutiveFailures: number; lastReason?: string }>();
    if (!this.db) return out;
    try {
      const rows = this.db.prepare('SELECT * FROM breaker_state').all();
      for (const r of rows) {
        out.set(String(r['provider_id']), {
          openUntil: Number(r['open_until']),
          consecutiveFailures: Number(r['consecutive_failures']),
          lastReason: r['last_reason'] === null ? undefined : String(r['last_reason']),
        });
      }
    } catch {
      /* fail-open */
    }
    return out;
  }

  override logEvent(level: string, kind: string, detail: Record<string, unknown>): void {
    super.logEvent(level, kind, detail);
    if (!this.db) return;
    try {
      this.db.prepare('INSERT INTO relay_event (ts, level, kind, detail) VALUES (?,?,?,?)').run(Date.now(), level, kind, JSON.stringify(detail));
    } catch {
      /* fail-open */
    }
  }

  override listEvents(limit: number): Record<string, unknown>[] {
    if (!this.db) return super.listEvents(limit);
    try {
      const rows = this.db.prepare('SELECT ts, level, kind, detail FROM relay_event ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
      return rows.map((r) => ({
        ts: Number(r['ts']),
        level: String(r['level']),
        kind: String(r['kind']),
        detail: safeJsonParse<Record<string, unknown>>(String(r['detail'])) ?? {},
      }));
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return super.listEvents(limit);
    }
  }

  /** 面板创建的 key 落库；配置文件里的 key 每次启动都会重新写入（origin=config） */
  override listKeyMeta(): StoredKeyMeta[] {
    if (!this.db) return super.listKeyMeta();
    try {
      const rows = this.db.prepare('SELECT * FROM key_meta ORDER BY created_at ASC').all() as Record<string, unknown>[];
      return rows.map((r) => {
        const allowed = r['allowed_models'] === null ? undefined : safeJsonParse<string[]>(String(r['allowed_models']));
        const override = r['monthly_quota_override'] === null || r['monthly_quota_override'] === undefined ? undefined : Number(r['monthly_quota_override']);
        return {
          keyId: String(r['key_id']),
          label: String(r['label']),
          tier: String(r['tier']) as TierId,
          tenantId: String(r['tenant_id']),
          enabled: Number(r['enabled']) === 1,
          ...(allowed ? { allowedModels: allowed } : {}),
          ...(r['expires_at'] === null || r['expires_at'] === undefined ? {} : { expiresAt: Number(r['expires_at']) }),
          ...(override === undefined ? {} : { quotaOverride: override }),
          ...(r['cost_quota_override'] === null || r['cost_quota_override'] === undefined
            ? {}
            : { costQuotaOverride: Number(r['cost_quota_override']) }),
          keyHash: String(r['key_hash'] ?? ''),
          origin: String(r['origin'] ?? 'config') === 'panel' ? 'panel' : 'config',
          createdAt: Number(r['created_at'] ?? 0),
        };
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return super.listKeyMeta();
    }
  }

  override setKeyMetaEnabled(keyId: string, enabled: boolean): void {
    super.setKeyMetaEnabled(keyId, enabled);
    if (!this.db) return;
    try {
      this.db.prepare('UPDATE key_meta SET enabled = ? WHERE key_id = ?').run(enabled ? 1 : 0, keyId);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  override lastQuotaResetAt(keyId: string): number {
    if (!this.db) return super.lastQuotaResetAt(keyId);
    try {
      const rows = this.db.prepare("SELECT ts, detail FROM relay_event WHERE kind = 'quota.reset' ORDER BY id DESC LIMIT 500").all() as Record<string, unknown>[];
      for (const r of rows) {
        const detail = safeJsonParse<Record<string, unknown>>(String(r['detail']));
        if (detail?.['keyId'] === keyId) return Number(r['ts']);
      }
      return 0;
    } catch {
      return super.lastQuotaResetAt(keyId);
    }
  }

  /**
   * 批量版（v410）：同一条 SQL 只跑一次，行也只解析一次。
   * 逐 key 版跑 N 次同样的 SQL、把同样的 500 行解析 N 遍——332 key 实测 72ms/请求，
   * 这才是 /keys 的吞吐瓶颈（额度聚合本身只要 7ms）。语义与逐 key 版完全一致。
   */
  override lastQuotaResetForAll(keyIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (keyIds.length === 0) return out;
    if (!this.db) return super.lastQuotaResetForAll(keyIds);
    const want = new Set(keyIds);
    try {
      const rows = this.db.prepare("SELECT ts, detail FROM relay_event WHERE kind = 'quota.reset' ORDER BY id DESC LIMIT 500").all() as Record<string, unknown>[];
      for (const r of rows) {
        const detail = safeJsonParse<Record<string, unknown>>(String(r['detail']));
        const kid = detail?.['keyId'];
        // 倒序扫描：首次遇到即该 key 的最新一次重置
        if (typeof kid === 'string' && want.has(kid) && !out.has(kid)) out.set(kid, Number(r['ts']));
      }
      return out;
    } catch {
      return super.lastQuotaResetForAll(keyIds);
    }
  }
}

function dimensionKey(r: MeterRecord, dimension: MeterDimension): string {
  // 没通过鉴权的请求不属于任何 key/分层，也谈不上用了哪个模型。
  // 混进 free 层和空模型名下，只会让人误判成"免费层全挂了"。
  if (r.keyId === UNATTRIBUTED_KEY_ID) return UNATTRIBUTED;
  switch (dimension) {
    case 'model':
      return r.model || 'unknown';
    case 'provider_id':
      return r.providerId || 'unknown';
    case 'tier':
      return r.tier;
    case 'client_kind':
      return r.clientKind;
    default:
      return 'unknown';
  }
}

export async function createStore(opts: {
  driver: 'sqlite' | 'memory';
  path: string;
  batchSize: number;
  flushIntervalMs: number;
  logger?: Logger;
}): Promise<Store> {
  if (opts.driver === 'memory') {
    const s = new MemoryStore();
    await s.init();
    return s;
  }
  const s = new SqliteStore({ path: opts.path, batchSize: opts.batchSize, flushIntervalMs: opts.flushIntervalMs, ...(opts.logger ? { logger: opts.logger } : {}) });
  await s.init();
  return s;
}
