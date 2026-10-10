/**
 * 只读视图组（P2 拆分第四层第五刀）。
 *
 * 六个方法都是**只读**，且都不写 this.*：
 *   - health/series/authPolicyView/metricsView 只读 deps
 *   - keysView 读 deps.keys + deps.store
 *   - overview 读 deps.* 并自持一个 15s 缓存（含缓存键计算与淘汰）
 *
 * overview 的缓存逻辑（getOverviewCache/overviewCacheKey）跟着一起搬 ——
 * 它是 overview 的私有实现，留在 AdminApi 里会让「缓存键含原始 window 参数」
 * 这条修正（g-v442-cache-key-must-cover-all-output-affecting-inputs）散在两个地方。
 *
 * deps 只给真正用到的，不给整个 AdminDeps。
 */
import type { ServerResponse } from 'node:http';
import type { RelayConfig } from '../../core/types.js';
import type { Meter } from '../../loss/meter.js';
import type { ProviderPool } from '../../upstream/pool.js';
import type { Store, SeriesPoint } from '../../store/index.js';
import type { TraceStore } from '../../loss/tracer.js';
import type { KeyRegistry } from '../../gateway/keys.js';
import { windowFrom, windowOf, numParam } from '../params.js';

export interface ViewHandlerDeps {
  config: RelayConfig;
  meter: Meter;
  pool: ProviderPool;
  store: Store;
  traceStore: TraceStore;
  keys: KeyRegistry;
  /**
   * 管理面鉴权失败计数（adminAuthFails）。**传引用**：AdminApi.authorize 会原地更新它，
   * health() 读到的必须是最新的。与 budgetWatch 同款——该对象从不重新赋值，只改字段。
   */
  adminAuthFails: { total: number; lastAt: number; lastRemote: string };
}

export class ViewHandlers {
  /** P4 修复：overview 缓存（15s TTL，与前端刷新频率对齐） */
  private overviewCache = new Map<string, { json: string; data: Record<string, unknown>; at: number }>();
  private overviewCacheTtlMs = 15_000;

  constructor(private readonly deps: ViewHandlerDeps) {}

  /**
   * 取 overview 缓存（含**预序列化的 json**）。
   *
   * 之所以 public：AdminApi.buildRoutes 的 overview 路由要在缓存命中时
   * 直接 `res.end(cached.json)`，省掉一次大对象的 JSON.stringify
   * （overview 不带 slim 时约 25KB，ov 页 15s 一刷）。缓存本身住在
   * ViewHandlers 里 —— 它是 overview 的私有实现，不该拆到两个地方去。
   */
  getOverviewCache(url: URL): { json: string; at: number } | undefined {
    const cacheKey = this.overviewCacheKey(url);
    const cached = this.overviewCache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.overviewCacheTtlMs) {
      return cached;
    }
    return undefined;
  }

  /** P4 修复：计算 overview 缓存键 */
  private overviewCacheKey(url: URL): string {
    // 键必须包含**原始** window 参数，不能只按生效值算。
    // 缓存的 data（以及预序列化的 json）里嵌了 windowLabel，而 windowLabel 会回显
    // 「未识别的 window=X，已按 24h 处理」。若键只按生效值算，`?window=10m` 的标签
    // 会泄漏到 `?window=24h` 的响应里 —— 缓存投毒，且预序列化的 json 也一样错。
    const raw = url.searchParams.get('window');
    return `${url.searchParams.get('slim') === '1' ? 'slim' : 'full'}:${windowFrom(url)}:${raw ?? ''}`;
  }

  health(): Record<string, unknown> {
    const store = this.deps.store.health();
    const pool = this.deps.pool.snapshot();
    const openBreakers = pool.filter((p) => p.health.openUntil > Date.now()).length;
    const meter = this.deps.meter.snapshot();
    return {
      status: openBreakers > 0 || !store.ok ? 'degraded' : 'ok',
      adminAuth: { ...this.deps.adminAuthFails },
      store,
      providers: { total: pool.length, disabled: pool.filter((p) => p.disabled).length, breakerOpen: openBreakers },
      lossReduction: {
        enabled: true,
        counters: meter.counters,
        classifyCache: this.deps.meter.enabled ? undefined : null,
        traceRing: this.deps.traceStore.size(),
      },
    };
  }

  overview(url: URL): Record<string, unknown> {
    // P4 修复：缓存检查（15s TTL）
    const cacheKey = this.overviewCacheKey(url);
    const cached = this.overviewCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.at < this.overviewCacheTtlMs) {
      return cached.data;
    }
    const { windowMs, label } = windowOf(url);
    const summary = this.deps.meter.summarize(windowMs);
    const snap = this.deps.meter.snapshot();
    const base: Record<string, unknown> = {
      windowLabel: label,
      windowMs,
      summary,
      counters: snap.counters,
      overheadUs: snap.overheadUs,
      providers: this.deps.pool.snapshot().map((p) => ({
        id: p.id,
        label: p.label,
        models: p.models,
        disabled: p.disabled,
        healthy: p.health.healthy,
        breakerOpen: p.health.openUntil > Date.now(),
        consecutiveFailures: p.health.consecutiveFailures,
        ewmaLatencyMs: Math.round(p.health.ewmaLatencyMs),
        totalRequests: p.health.totalRequests,
        totalFailures: p.health.totalFailures,
        concurrency: p.concurrency,
      })),
      store: this.deps.store.health(),
      // 档位策略随 overview 下发（manual#199）：GUI 的 ov 分层表此前用静态 TIER_LABEL/TIER_DESC
      // 映射档位名与策略——那是 config.tiers 的过期镜子（运营改名/调参后 ov 显示旧值、ops 页
      // 显示新值，同档位两套词汇）。真源只有一份：config.tiers（authPolicyView 同源）。
      tiers: this.deps.config.tiers,
    };
    // slim=1（manual#164）：ov 页 15s 自动刷新是 overview 的唯一 GUI 消费者，而它只用
    // summary/providers/overheadUs/store 这几个字段——keys（25.8KB，且 keysView 每个 key
    // 要算 usage/policy）与 events/topErrors 对它全是死重（keys 页/排障页有各自专用端点）。
    // slim 省略这些字段并跳过 keysView 计算；默认返回不变（curl 消费者的契约不动）。
    if (url.searchParams.get('slim') !== '1') {
      base.keys = this.keysView().keys;
      base.events = this.deps.store.listEvents(20);
      base.topErrors = this.deps.store.topErrors(Date.now() - windowMs, 10);
    }
    // P4 修复：写入缓存（预序列化 JSON + 原始对象，避免缓存命中时重复序列化）
    this.overviewCache.set(cacheKey, { json: JSON.stringify(base), data: base, at: now });
    // P4 修复：清理过期缓存（LRU 淘汰，避免缓存击穿）
    for (const [k, entry] of this.overviewCache) {
      if (now - entry.at >= this.overviewCacheTtlMs) this.overviewCache.delete(k);
    }
    // 如果仍超过限制，清理最旧的
    if (this.overviewCache.size > 100) {
      const sorted = [...this.overviewCache.entries()].sort((a, b) => a[1].at - b[1].at);
      const toRemove = sorted.length - 100;
      for (let i = 0; i < toRemove; i++) {
        const entry = sorted[i];
        if (entry) this.overviewCache.delete(entry[0]);
      }
    }
    return base;
  }

  series(url: URL): Record<string, unknown> {
    const windowMs = windowFrom(url);
    // 桶随窗口自适应（manual#220）：此前固定 1h 默认——30 天窗口 720 个桶挤进柱状图不可读；
    // 且 store 省略空桶，GUI 按索引等距渲染时稀疏数据的时间轴被压缩（相邻两柱可能隔 1 小时
    // 也可能隔 30 小时，视觉无别——tooltip 有真时间但柱位撒谎）。改为与 /v1/panel 同款的
    // 自适应桶（≤1h→60s / ≤24h→1h / 否则→1d）+ 空桶补零：补零后每个索引就是一个桶，
    // 等距渲染即等时距渲染，24h=24 柱 / 7d=7 柱 / 30d=30 柱，时间轴诚实。
    const dflt = windowMs <= 3_600_000 ? 60_000 : windowMs <= 86_400_000 ? 3_600_000 : 86_400_000;
    const bucketMs = numParam(url, 'bucketMs', dflt, 60_000, 86_400_000);
    const since = Date.now() - windowMs;
    const raw = this.deps.store.series(since, bucketMs);
    if (raw.length === 0) return { bucketMs, points: [] as SeriesPoint[] };
    // 补零范围取窗口边界（不是首尾活跃点之间）——否则最后一条柱永远贴在右边缘，
    // 「三天前就没流量了」在图上看起来像「刚刚还有」。左边缘=窗口起点、右边缘=现在。
    const byTs = new Map(raw.map((p) => [p.ts, p]));
    const points: SeriesPoint[] = [];
    for (let t = Math.ceil(since / bucketMs) * bucketMs; t <= Date.now(); t += bucketMs) {
      points.push(byTs.get(t) ?? { ts: t, requests: 0, errors: 0, tokens: 0, costCny: 0, avgDurationMs: 0 });
    }
    return { bucketMs, points };
  }

  keysView(slim = false): { keys: Record<string, unknown>[]; concurrency?: Record<string, unknown>[]; authFailures?: Record<string, unknown> } {
    const allKeys = this.deps.keys.listKeys();
    // P2 修复：批量获取所有 key 的 usage（消除 N+1 查询）
    const usageMap = this.deps.keys.usageForAll(allKeys.map((k) => k.id));
    if (slim) {
      // slim 行（manual#293）：ov 页需关注 chip 的最小集——keyState(k) 只读
      // enabled/expiresAt/usage.quotaUsedPct/usage.quotaCnyUsedPct，chip 标题读 id/label；
      // createdAt 保留（排序用，13B/key）。usage 裁到两个 pct（limits/counters  ov 不用）。
      const slimKeys = allKeys.map((k) => {
        const u = usageMap.get(k.id);
        return {
          id: k.id,
          label: k.label,
          enabled: k.enabled,
          expiresAt: k.expiresAt,
          createdAt: k.createdAt,
          usage: { quotaUsedPct: u?.quotaUsedPct ?? null, quotaCnyUsedPct: u?.quotaCnyUsedPct ?? null },
        };
      });
      return { keys: slimKeys };
    }
    const concurrency = new Map(this.deps.keys.concurrencySnapshot().map((c) => [c.keyId, c]));
    // createdAt 呈现纠正（manual#151）：gateway/keys.ts 装载面板 key 时用 Date.now()（启动时刻）
    // 覆盖了 DB 里的真实 created_at——每次重启后所有 key 都显示『刚创建』（key 表格的时间列
    // 全部失真，任何按 created_at 的运维判断都被带偏；本轮清理脚本就因此误伤了生产 key）。
    // 根因修复在 gateway/keys.ts（能力层，待签字）；这里在呈现层用 store 的真实值纠正，
    // GUI 与 API 消费者拿到的 created_at 即真实创建时间。
    const metaAt = new Map(this.deps.store.listKeyMeta().map((m) => [m.keyId, m.createdAt]));
    return {
      authFailures: { ...this.deps.keys.authRejections(50) },
      keys: (() => {
      const rows = allKeys.map((k) => {
        const usage = usageMap.get(k.id) ?? this.deps.keys.usageForKey(k.id);
        const policy = this.deps.keys.policyFor(k.tier);
        return {
          ...k,
          createdAt: metaAt.get(k.id) ?? k.createdAt,
          policy: {
            precheck: policy.precheck,
            attribution: policy.attribution,
            rpm: policy.rpm,
            maxConcurrency: policy.maxConcurrency,
            billing: policy.billing,
            smartRouting: policy.smartRouting,
            periodQuotaTokens: policy.periodQuotaTokens,
          },
          usage,
          concurrency: concurrency.get(k.id) ?? { active: 0, waiting: 0, limit: 0 },
          /** 是否可安全删除：配置里的 key 删了重启还会回来，所以只能禁用 */
          deletable: k.origin === 'panel',
        };
      });
      // 排序也用纠正后的 createdAt（manual#152）：gateway listKeys 按内存记录的 createdAt 排，
      // 而那个值被启动时刻覆盖（#151）——全部相等后退化成按 id 排，表格显示真实时间但顺序乱。
      return rows.sort((a, b) => Number(a['createdAt']) - Number(b['createdAt']) || String(a['id']).localeCompare(String(b['id'])));
      })(),
      concurrency: this.deps.keys.concurrencySnapshot(),
    };
  }

  /** 鉴权与限流策略总览（面板"策略"页用） */
  authPolicyView(): Record<string, unknown> {
    return {
      tiers: this.deps.config.tiers,
      // 额度周期（manual#200）：真源是 gateway/keys.ts 的 QUOTA_PERIOD_MS（能力层、未导出），
      // 此处 30 天是它的**展示镜像**——改了常量要同步改这里（或导出常量由本处引用，
      // 已列签字项）。仅用于面板展示，不参与本文件的任何逻辑判断。
      quotaPeriodMs: 30 * 86_400_000,
      keyCount: this.deps.keys.listKeys().length,
      activeKeys: this.deps.keys.listKeys().filter((k) => k.enabled).length,
      note: '限流与额度是每实例独立的；多实例部署时实际上限约为 N 倍（见 docs/DEPLOYMENT.md §4.2）',
    };
  }

  /**
   * 原始指标视图（面板"指标"页用）。
   * 与 overview 的分层聚合不同，这里给的是**计数器的原始读数与延迟分布**（n/avg/min/max），
   * 用于回答"这个数为什么是这个值"，而不是"业务上怎么样"。
   */
  metricsView(url: URL): Record<string, unknown> {
    const { windowMs, label } = windowOf(url);
    const from = Date.now() - windowMs;
    const snapshot = this.deps.meter.snapshot();
    const records = this.deps.store.recordsSince(from);

    // PERF-005 修复：单次迭代计算所有指标（原实现 9 次 summarize + 2 次 filter + 2 次 reduce = 13N 次迭代）
    const stats = {
      'relay.request.duration_ms': { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
      'relay.request.ttfb_ms': { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
      'relay.request.payload_bytes': { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
      'relay.response.bytes': { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
      'relay.usage.total_tokens': { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
      'relay.cost_cny': { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
      'relay.upstream.attempts': { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
      'relay.overhead.precheck_us': { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
      'relay.overhead.classify_us': { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
      'relay.duplicate_in_window': { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
    };
    let errorCount = 0;
    let attributionDeliveredCount = 0;
    let overheadUsTotal = 0;
    let durationMsTotal = 0;

    for (const r of records) {
      // 更新各指标统计
      const metrics: [string, number | null][] = [
        ['relay.request.duration_ms', r.durationMs],
        ['relay.request.ttfb_ms', r.ttfbMs],
        ['relay.request.payload_bytes', r.bytesIn],
        ['relay.response.bytes', r.bytesOut],
        ['relay.usage.total_tokens', r.totalTokens],
        ['relay.cost_cny', r.costCny],
        ['relay.upstream.attempts', r.attemptCount],
        ['relay.overhead.precheck_us', r.precheckUs],
        ['relay.overhead.classify_us', r.classifyUs],
        ['relay.duplicate_in_window', r.duplicateInWindow],
      ];
      for (const [key, v] of metrics) {
        if (v === null || !Number.isFinite(v)) continue;
        const s = stats[key as keyof typeof stats];
        s.count++;
        s.sum += v;
        if (v < s.min) s.min = v;
        if (v > s.max) s.max = v;
      }
      // 错误统计
      if (r.outcome !== 'success') {
        errorCount++;
        if (r.attributionDelivered) attributionDeliveredCount++;
      }
      // 开销统计
      overheadUsTotal += r.precheckUs + r.classifyUs;
      durationMsTotal += r.durationMs;
    }

    const summaries: Record<string, { count: number; sum: number; min: number; max: number; avg: number }> = {};
    for (const [key, s] of Object.entries(stats)) {
      summaries[key] = { count: s.count, sum: s.sum, min: s.count ? s.min : 0, max: s.count ? s.max : 0, avg: s.count ? s.sum / s.count : 0 };
    }

    return {
      windowMs,
      // 标签必须走 windowOf 助手，不能内联回显原始参数（g-v439：曾有调用点内联回显，
      // 导致「标签说 10m、数值是 24h」——面板把 24 小时的数据当成 10 分钟的读）。
      windowLabel: label,
      uptimeS: Math.round(process.uptime()),
      nameNote: '命名对齐 OpenTelemetry GenAI 语义约定（gen_ai.client.*），relay.* 为本网关的本地扩展',
      counters: snapshot.counters,
      overheadUs: snapshot.overheadUs,
      store: snapshot.store,
      // 零 token 守卫的累计条数（进程内）。>0 表示"有成功请求没记到 token" ——
      // 2026-09-14 那次 375 条流式全记 0 就是靠这个数才可能被主动发现。
      zeroTokenCount: snapshot.zeroTokenCount,
      summaries,
      derived: {
        'relay.overhead.ratio': durationMsTotal > 0 ? overheadUsTotal / 1000 / durationMsTotal : 0,
        'relay.error.rate': records.length ? errorCount / records.length : 0,
        'relay.attribution.coverage': errorCount ? attributionDeliveredCount / errorCount : 0,
      },
      classCounters: {
        'relay.preflight.blocked': snapshot.counters.precheckBlocked,
        'relay.preflight.degraded': snapshot.counters.precheckDegraded,
        'relay.attribution.cards': snapshot.counters.attributionCards,
        'relay.upstream.auto_retries': snapshot.counters.autoRetries,
        'relay.upstream.auto_recovered': snapshot.counters.autoRecovered,
        'relay.request.duplicate': snapshot.counters.duplicates,
      },
    };
  }
}
