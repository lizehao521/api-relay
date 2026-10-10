/**
 * 管理接口 + 运营看板。
 *
 * 安全模型：
 * - 未配置 adminToken 时，只接受来自 127.0.0.1/::1 的请求（本机运维）。
 * - 配置了 adminToken 后，必须带 `X-Admin-Token` 或 `Authorization: Bearer`。
 * - 看板 HTML 内嵌，不依赖任何 CDN（内网/离线可用）。
 *
 * 看板呈现的核心是**降损层是否真的在起作用**：归因投递率、自动恢复、无效重试、
 * 预检拦截、降损层自身开销占比 —— 每一项都能对上一个可行动的结论。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { secHeaders, json, text, badRequest, notFoundOrBad } from './response.js';
import { AdminAuth } from './auth.js';
import { KbHandlers } from './handlers/kb.js';
import { AgentHandlers } from './handlers/agent.js';
import { KeyHandlers } from './handlers/keys.js';
import { EvolutionHandlers } from './handlers/evolution.js';
import { ProviderHandlers } from './handlers/providers.js';
import { ConfigHandlers } from './handlers/config.js';
import { ViewHandlers } from './handlers/views.js';
import { windowFrom, windowOf, numParam, maskSecret } from './params.js';
import { ownLookup } from '../util/index.js';
import { resolveRoute, type Route, type RouteContext } from './router.js';
import { Logger } from '../core/logger.js';
import type { Engine } from '../gateway/engine.js';
import type { KeyRegistry } from '../gateway/keys.js';
import { extractBearer } from '../gateway/keys.js';
import { Meter, renderSummary } from '../loss/meter.js';
import type { ProviderPool } from '../upstream/pool.js';
import { Router } from '../upstream/pool.js';
import type { Store, SeriesPoint } from '../store/index.js';
import type { TraceStore } from '../loss/tracer.js';
import { renderTrace, diffTraces } from '../loss/tracer.js';
import type { RelayConfig, TraceRecord } from '../core/types.js';
import { dashboardHtml } from './dashboard.js';
import { gzipSync } from 'node:zlib';
import { KbStore } from '../kb/store.js';
import type { AgentRunner } from '../agent/runner.js';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface AdminDeps {
  config: RelayConfig;
  logger: Logger;
  engine: Engine;
  pool: ProviderPool;
  router: Router;
  keys: KeyRegistry;
  meter: Meter;
  store: Store;
  traceStore: TraceStore;
  /** 知识库存储（垂直 Agent 能力；undefined = 未启用） */
  kb?: KbStore | undefined;
  /** 内部 Agent 系统（自托管运维/迭代决策环；undefined = 未启用） */
  agent?: AgentRunner | undefined;
  serverStats: () => { requestCount: number; inflight: number; uptimeMs: number };
}

export class AdminApi {
  /** F6 修复：budgetWatch 改为类属性，keyDelete 时可同步清理 */
  private budgetWatch = new Map<string, 'warn' | 'error'>();
  constructor(private readonly deps: AdminDeps) {
    // 鉴权独立成类（P2 拆分第二层）：速率限制状态自持，不再与业务 handler 混在一起
    this.auth = new AdminAuth(deps.config.server.adminToken);
    this.routes = this.buildRoutes();
    this.kb = new KbHandlers({ config: deps.config, store: deps.store, kb: deps.kb });
    // agent 用惰性 getter：app.ts 在 AdminApi 构造**之后**才创建 AgentRunner 并回填
    // deps.agent。按值捕获会拿到构造那刻的 undefined（本层实际踩到的回归）。
    this.agent = new AgentHandlers({ store: deps.store, logger: deps.logger, agent: () => deps.agent });
    // budgetWatch 传的是 Map 引用（该引用从不重新赋值，只 get/set/delete）——
    // 与 agent 那个坑不同：那里是「构造后才赋值的 undefined」，这里共享同一个可变对象。
    this.keys = new KeyHandlers({
      config: deps.config, keys: deps.keys, store: deps.store,
      logger: deps.logger, router: deps.router, budgetWatch: this.budgetWatch,
    });
    this.evolution = new EvolutionHandlers({ config: deps.config, store: deps.store });
    // provider 运营动作（写操作）：走 pool 自己的 setDisabled/resetBreaker，
    // 不直接改 entry.health —— 否则绕过 persistBreaker，重启后熔断原样回来。
    this.providers = new ProviderHandlers({ pool: deps.pool, logger: deps.logger, store: deps.store });
    // 配置与目录视图（只读）：configView/modelList/allowedModelsFor/attributionCatalog
    this.config = new ConfigHandlers({ config: deps.config, router: deps.router, keys: deps.keys });
    // 只读视图组（health/overview/series/keysView/authPolicyView/metricsView）。
    // adminAuthFails 传的是**对象引用**：authorize() 会原地累加它的 total/lastAt/lastRemote，
    // health() 读到的必须是最新值（与 budgetWatch 同款；和 agent 那个「构造后才赋值的
    // undefined」正好相反，这里对象从不重新赋值，只改字段）。
    this.views = new ViewHandlers({
      config: deps.config, meter: deps.meter, pool: deps.pool, store: deps.store,
      traceStore: deps.traceStore, keys: deps.keys, adminAuthFails: this.adminAuthFails,
    });
    // 每日按配置留存清理（manual#319）：store.prune() 一直存在但**生产零调用方**——
    // relay-net.yaml 的 meter.retentionDays:30 是装饰性配置，meter/trace 表无界增长
    // （round-319 实测 5741+5745 行/10.6MB 且只增不减）。能力层的调度缺口待签字；
    // 呈现层先兜底（与 #310 墓碑同款）：admin 进程启动时跑一次+每日一次，按配置的留存
    // 天数清理。三道保险：days 非法（<1）不跑、fail-open（清理失败不影响服务）、
    //  timer.unref（不拖住进程退出）；删了行才记审计事件（storage.prune）。
    const days = deps.config.lossReduction?.meter?.retentionDays;
    if (typeof days === 'number' && days >= 1) {
      const run = () => {
        void Promise.resolve()
          .then(() => deps.store.prune(days))
          .then((n) => { if (n > 0) deps.store.logEvent('info', 'storage.prune', { days, deleted: n }); })
          .catch(() => { /* fail-open：清理失败不影响服务 */ });
      };
      run();
      const t = setInterval(run, 86_400_000);
      if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
    }
    // Key 预算阈值预警（manual#362）：带额度帽的 key（free 200000 token / quotaOverride /
    // quotaCny）耗尽时客户请求开始吃 402/429，而运营往往事后才知道（k_yah877ib 实录：
    // 『预算耗尽待运营处置』——发现即已断客）。admin 层每 5 分钟扫一遍启用 key 的用量
    // 百分比，越线写 store 事件 key.budget——事件进排障页事件表，也进内部 agent 巡检的
    // recentEvents（下一轮决策可见），形成『检测→事件→agent』闭环。去重：进程内
    // Map<keyId, 已报级别>，只在升级时记（none→warn≥85%→error≥100%），跌回阈值下清除
    // （配额重置后可再报）；重启后最多重报一次。三道保险同 #319：fail-open（扫描异常
    // 不影响服务）、timer.unref、只读不写业务数据。
    // F6 修复：budgetWatch 已提升为类属性
    // v414 修复：循环内的 usageForKey 换成一次 usageForAll。
    // 这是与 /keys 同族的 N+1——usageForKey 每 key 跑一次 lastQuotaResetAt
    // （全扫 relay_event 取 500 行 + JSON 解析一遍）加一次额度聚合 SQL。
    // 46 个启用 key 实测 14.6ms，且**每 5 分钟准时阻塞一次事件循环**——
    // 被卡的同样包括代理转发路径，不只是这个定时器自己。
    // 批量版语义经断言等价（3 个时间点 × 51 key × 8 字段全等），实测 5.1ms。
    const budgetCheck = (): void => {
      try {
        const keys = deps.keys.listKeys().filter((k) => k.enabled);
        if (keys.length === 0) return;
        const usage = deps.keys.usageForAll(keys.map((k) => k.id));
        for (const k of keys) {
          const u = usage.get(k.id);
          if (!u) continue;
          const pcts = [u.quotaUsedPct, u.quotaCnyUsedPct].filter((p): p is number => typeof p === 'number');
          if (!pcts.length) continue; // 无额度帽的 key（如 standard 默认）不会耗尽，无需预警
          const max = Math.max(...pcts);
          const level: 'warn' | 'error' | '' = max >= 1 ? 'error' : max >= 0.85 ? 'warn' : '';
          const prev = this.budgetWatch.get(k.id) ?? '';
          // 只在升级时记：none→warn、warn→error；同级别不重记（防 5 分钟一条的刷屏）
          if ((level === 'warn' && prev === '') || (level === 'error' && prev !== 'error')) {
            deps.store.logEvent(level, 'key.budget', {
              keyId: k.id,
              label: k.label ?? '',
              tier: k.tier,
              quotaUsedPct: u.quotaUsedPct ?? null,
              quotaCnyUsedPct: u.quotaCnyUsedPct ?? null,
              level,
              note: level === 'error' ? '配额/预算已耗尽——客户请求将被 402 拒，尽快处置' : '配额/预算即将耗尽（≥85%）——提前联系客户续费或扩容',
            });
          }
          if (level) this.budgetWatch.set(k.id, level);
          else this.budgetWatch.delete(k.id);
        }
      } catch { /* fail-open：预警扫描失败不影响服务 */ }
    };
    budgetCheck();
    const bt = setInterval(budgetCheck, 300_000);
    if (typeof (bt as { unref?: () => void }).unref === 'function') (bt as { unref: () => void }).unref();
  }
  // admin 令牌鉴权失败计数（manual#179）：客户端 key 的失败有 authRejections 计数+排障页
  // 展示，admin 令牌的失败尝试此前只回 401、无任何记录——Funnel 暴露面下暴力破解不可见。
  // 进程内计数（重启清零，同进程行其他口径），经 health.adminAuth 暴露给 GUI。
  /** 管理面鉴权（P2 拆分：独立成 AdminAuth，见 auth.ts） */
  private readonly auth: AdminAuth;
  /** 路由表（P2 拆分第三层：声明式数据，见 router.ts） */
  private readonly routes: Route[];
  /** KB handler（P2 拆分第四层：见 handlers/kb.ts） */
  private readonly kb: KbHandlers;
  /** Agent handler（P2 拆分第四层：见 handlers/agent.ts） */
  private readonly agent: AgentHandlers;
  /** key 生命周期 handler（P2 拆分第四层：见 handlers/keys.ts） */
  private readonly keys: KeyHandlers;
  /** 进化方向 handler（P2 拆分第四层：见 handlers/evolution.ts） */
  private readonly evolution: EvolutionHandlers;
  /** 上游运营动作 handler（P2 拆分第四层：见 handlers/providers.ts） */
  private readonly providers: ProviderHandlers;
  /** 配置与目录视图 handler（P2 拆分第四层：见 handlers/config.ts） */
  private readonly config: ConfigHandlers;
  /** 只读视图组 handler（P2 拆分第四层：见 handlers/views.ts） */
  private readonly views: ViewHandlers;
  private adminAuthFails = { total: 0, lastAt: 0, lastRemote: '' };

  /* ---------------- 鉴权 ---------------- */

  /* ---------------- 路由 ---------------- */

  /**
   * 路由表（P2 拆分第三层）。
   *
   * 原先是 handle 里 421 行的 switch；现在是一张声明式表 ——
   * 「文档列出的端点是否都注册了」「有没有重复路由」从读 switch 变成读表。
   * handler 用箭头函数捕获 this，因此不需要把 deps/state 传来传去。
   */
  /**
   * 路由表（P2 拆分第三层 + P3 按域拆分，r21）。
   *
   * 28 条路由按**业务域**分到下面六个私有方法里，这里只剩聚合。
   * 拆开不是为了少行数，是为了「改 key 相关路由时不用在 28 条里数位置」——
   * 每域一张小表，可单独读、单独审，域内增删不影响别处。
   *
   * 顺序不影响匹配：resolveRoute 是 `METHOD action` **精确匹配**（见 router.ts），
   * 不是前缀匹配。但每条路由仍必须**恰好注册一次** —— route-coverage 测试
   * 盯着全部 28 条，多一条少一条都会被发现。
   */
  private buildRoutes(): Route[] {
    return [
      ...this.opsRoutes(),
      ...this.providerRoutes(),
      ...this.keyRoutes(),
      ...this.configRoutes(),
      ...this.evolutionRoutes(),
      ...this.kbRoutes(),
    ];
  }

  /** 运维监控（只读视图） */
  private opsRoutes(): Route[] {
    return [
      { method: 'GET', action: 'health', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return json(res, 200, { ...this.health(), server: this.deps.serverStats() });
      }},
      { method: 'GET', action: 'overview', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            // P4 修复：优先发送预序列化 JSON（避免缓存命中时重复序列化）
            const cached = this.getOverviewCache(url);
            if (cached) {
              secHeaders(res);
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.setHeader('cache-control', 'no-store');
              res.writeHead(200);
              res.end(cached.json);
              return true;
            }
            return json(res, 200, this.overview(url));
      }},
      { method: 'GET', action: 'series', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return json(res, 200, this.series(url));
      }},
      { method: 'GET', action: 'traces', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            // 深度搜索（manual#92）：q 非空时在调用方指定窗口内按 requestId/traceId/failedAtStage/outcome 过滤。
            // GUI 账本搜索只覆盖已加载的 100 条，客户报障引用的 request-id 常早于该窗口——过滤下沉到服务端。
            const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
            const limit = numParam(url, 'limit', 50, 1, 5000);
            // scanned 口径统一（manual#278）：与 events 端点同义=**筛选前**扫描数（窗口大小）。
            // 此前 traces 的 scanned 是筛选后计数——既与 events 同名不同义，又与 traces.length
            // 重复（恒等，零信息量）。深搜时 scanned  telling 运营『搜了多大窗口、命中多少』。
            let traces = this.deps.store.recentPersistedTraces(limit);
            const scanned = traces.length;
            if (q) {
              traces = traces.filter((t) => {
                // model 入深搜（manual#227，manual#261 扩展）：走 traceModel（正常 model=X 与
                // 无路由『支持模型 X』两种形态）——运营可按模型定位失败请求（含未声明模型）。
                const model = traceModel(t.steps) ?? '';
                return [t.requestId, t.traceId, t.failedAtStage, t.outcome, model].join(' ').toLowerCase().includes(q);
              });
              // 深搜返回上限 200（manual#299，性能第一位）：q 命中 4635 条时响应 1.2MB/1.2s
              // （实测 q=agnes 几乎不过滤）——深搜的目的是『找到客户引用的那条 trace』不是
              // 全量倾倒（GUI 也渲染不了 4635 行）。扫 5000 的窗口不变（老 request-id 要能
              // 搜到），返回截到 200——与 events kind 筛选同思路（#291 拉取量匹配显示需求）。
              traces = traces.slice(0, 200);
            }
            // slim=1（manual#163）：账本行渲染只要摘要字段（时间/id/结果/耗时/失败阶段/步数/
            // 是否降级），steps 全量在点开抽屉时按 id 单取（GET /traces/:id）——全量列表
            // 100 条要 235KB，slim 后约 20KB（省 ~90%），对 15s 级刷新与移动网络都实在。
            // degraded/stepCount 由服务端预计算（与行内 chip、『降级放行』筛选同源）。
            // slimTrace 提取为公共方法（Q004：消除 slim=1 与 forced slim 的重复逻辑）。
            const slimTrace = (t: TraceRecord) => {
              const steps = t.steps || [];
              const degraded = steps.some((s) => s.stage === 'precheck' && s.detail && s.detail.degraded);
              return {
                traceId: t.traceId, requestId: t.requestId, startedAt: t.startedAt,
                durationMs: t.durationMs, outcome: t.outcome, failedAtStage: t.failedAtStage,
                model: traceModel(steps),
                stepCount: steps.length, degraded,
              };
            };
            if (url.searchParams.get('slim') === '1') {
              const slim = traces.map(slimTrace);
              return json(res, 200, { traces: slim, deep: !!q, scanned, slim: true });
            }
            // 非 slim 也带 model（manual#227）：与 slim 同一提取路径——深搜按 model 命中后，
            // 两种载荷都应能看到匹配字段（API 消费者不强制用 slim）。
            const withModel = traces.map((t) => ({ ...t, model: traceModel(t.steps) }));
            // 载荷天花板（challenge#1·P1）：非 slim 全量响应 ≤2MB，超出强制 slim——
            // 实测 limit=5000 全量 11.7MB/689ms，浏览器可触发内存压力。
            // slim 模式仅 1.3MB（9 倍差距），强制 slim 是安全降级。
            // PERF-001 修复：用 Buffer.byteLength 估算大小，避免双重序列化。
            const payloadSize = Buffer.byteLength(JSON.stringify({ traces: withModel, deep: !!q, scanned }));
            if (payloadSize > 2 * 1024 * 1024) {
              // 超 2MB → 强制 slim
              const slim = traces.map(slimTrace);
              return json(res, 200, { traces: slim, deep: !!q, scanned, slim: true, forced: true });
            }
            return json(res, 200, { traces: withModel, deep: !!q, scanned });
      }},
      { method: 'GET', action: 'metrics', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return json(res, 200, this.metricsView(url));
      }},
      { method: 'GET', action: 'events', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            // kind 前缀过滤（manual#168）：排障页此前只客户端筛已加载的 100 条——想多看一类
            // 事件（如全部 kb.*）受窗口所限。服务端先按 kind 前缀过滤再取 limit，语义变为
            // 「最近 N 条某类事件」而非「最近 N 条里筛某类」。与 slim 同族：opt-in 参数，
            // 不传时行为不变（listEvents 原语义）。
            const kind = (url.searchParams.get('kind') ?? '').trim();
            // level 过滤（manual#314）：排障的第一诉求是『只看 error』——此前只有 kind 前缀
            // 过滤，error 级事件混在 warn/info 里要人眼翻。与 kind 同族 opt-in（不传行为不变），
            // 两者可组合（kind=key&level=error）；语义统一为『最近 N 条匹配事件』——先过滤后截断。
            const level = (url.searchParams.get('level') ?? '').trim();
            const limit = numParam(url, 'limit', 50, 1, 500);
            const all = this.deps.store.listEvents(500) as { ts: number; level: string; kind?: string; detail?: unknown }[];
            let pool = all;
            if (kind) pool = pool.filter((e) => (e.kind || '').startsWith(kind));
            if (level) pool = pool.filter((e) => e.level === level);
            const events = pool.slice(0, limit);
            // detail=0（manual#301）：表格只要 90 字预览+actor——detail 全量在点开行/导出 CSV 时
            // 按需拉（首次拉一次并按查询缓存，traces 页 #163 同模式）。默认不变（curl 契约不动）。
            if (url.searchParams.get('detail') === '0') {
              return json(res, 200, {
                events: events.map((e) => ({
                  ts: e.ts,
                  level: e.level,
                  kind: e.kind,
                  actor: (e.detail && typeof e.detail === 'object' ? (e.detail as { actor?: unknown }).actor : undefined) || '',
                  brief: JSON.stringify(e.detail || {}).slice(0, 90),
                })),
                kind: kind || null,
                level: level || null,
                scanned: all.length,
              });
            }
            return json(res, 200, { events, kind: kind || null, level: level || null, scanned: all.length });
      }},
      { method: 'GET', action: 'auth-failures', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return json(res, 200, this.deps.keys.authRejections(numParam(url, 'limit', 50, 1, 500)));
          // top-errors（manual#183）：窗口内上游失败签名（reason+次数+实例 model@provider HTTP status）。
          // overview 非 slim 模式早返回 topErrors，但 ov 页不消费（#164 判过死重）、GUI 无其他入口——
          // 排障页此前只有鉴权失败（401）+事件+目录，上游 5xx 泛滥时看不到「错的是什么、长什么样」。
      }},
      { method: 'GET', action: 'top-errors', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            const { windowMs, label } = windowOf(url);
            const since = Date.now() - windowMs;
            // 客户端鉴权失败（auth_invalid 且无 providerId）排除在外——那是「鉴权失败」块的职责
            // （manual#183：两块互补，混进来会重复且 example 是空的『@ HTTP 401』）。
            // 计数走 DB 级 attributionStats（manual#324）：此前用 recordsSince（进程内内存镜像）
            // 自行聚合——重启后内存只剩新记录，同一份 report 里「失败归因（P3）」（attributionStats，
            // SQL 跨重启）显示 5 而「错的是什么」显示 1，同一概念两个计数（cross-endpoint 不一致）。
            // attributionStats 的过滤条件与此处逐字相同（outcome!=success 且 failure_reason 非空且
            // 排除客户端 auth_invalid）；example（model@provider HTTP status）在内存镜像没有对应记录
            // （重启前的）时留空——计数正确比示例齐全重要，示例本就是「长什么样」的佐证非主数据。
            const exMap = new Map<string, string>();
            for (const r of this.deps.store.recordsSince(since)) {
              if (!r.failureReason) continue;
              if (r.failureReason === 'auth_invalid' && !r.providerId) continue;
              if (!exMap.has(r.failureReason)) exMap.set(r.failureReason, (r.model || '') + '@' + (r.providerId || '') + ' HTTP ' + (r.httpStatus || 0));
            }
            const errors = (this.deps.store.attributionStats(since).byReason || [])
              .map((r) => ({ reason: r.reason, count: r.count, example: exMap.get(r.reason) || '' }))
              .sort((a, b) => b.count - a.count).slice(0, numParam(url, 'limit', 10, 1, 50));
            return json(res, 200, {
              window: label,
              windowMs,
              coveredSince: this.deps.store.oldestInWindow(since) || null,
              errors,
            });
      }},
    ];
  }

  /** 上游 provider 运营 */
  private providerRoutes(): Route[] {
    return [
      { method: 'GET', action: 'providers', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            // reachability 带 tools（manual#267）：modelCapabilities（哪些模型支持工具调用）
            // 是引擎智能路由的判定依据，但此前只存在于配置层——面板零展示，运营要读 yaml
            // 才知道。与 #265/#266 同族：在役数据要暴露。datalist（#262）与 advisory（#263）
            // 用的是同一个 reachability 形状，加字段不影响它们（只增不改）。
            const caps = this.deps.config.modelCapabilities ?? {};
            const reachability = this.deps.router.reachability().map((r) => ({
              ...r,
              // ownLookup：模型名若叫 'constructor'/'toString' 等，`caps[m]` 会命中
              // Object.prototype 而拿到一个（无 tools 字段的）函数/对象 —— 面板的
              // 「工具调用」列就对那个模型显『—』，而它其实是声明了能力的。
              // 与第 18 轮扫出的是同一个 bug 类，这处当时漏了。
              tools: ownLookup(caps, r.model)?.tools === true,
            }));
            // slim=1 只回 reachability（manual#292，性能第一位）：ov 页的需关注 chip 只查可达性，
            // 而快照部分与 overview?slim=1 的 providers 字段完全重复（占载荷 64%）——ov 页每 15s
            // 刷新都白拉一半。与 #163（traces slim）/ #164（overview slim）同族 opt-in，不传行为不变。
            if (url.searchParams.get('slim') === '1') {
              return json(res, 200, { reachability });
            }
            return json(res, 200, { providers: this.deps.pool.snapshot(), reachability });
      }},
      { method: 'POST', action: 'providers/toggle', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return this.providerToggle(res, body);
      }},
      { method: 'POST', action: 'providers/reset', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return this.providerReset(res, body);
      }},
    ];
  }

  /** 客户 key 生命周期 */
  private keyRoutes(): Route[] {
    return [
      { method: 'GET', action: 'keys', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            // slim=1（manual#293）：ov 页需关注 chip 的 60s 缓存只用 id/label/enabled/expiresAt/
            // usage 的两个 pct（keyState）——policy/hashPrefix/tier/origin/tenantId/deletable/
            // concurrency 与 authFailures/concurrencySnapshot 对它全是死重。与 #163/#164/#292
            // 同族 opt-in，不传行为不变（keys 页要 authFailures，用全量）。
            return json(res, 200, this.keysView(url.searchParams.get('slim') === '1'));
      }},
      { method: 'POST', action: 'keys/whoami', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return this.keyWhoami(res, body);
      }},
      { method: 'POST', action: 'keys/create', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return this.keyCreate(res, body, actor);
      }},
      { method: 'POST', action: 'keys/update', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return this.keyUpdate(res, body, actor);
      }},
      { method: 'POST', action: 'keys/revoke', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return this.keyRevoke(res, body, actor);
      }},
      { method: 'POST', action: 'keys/rotate', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return this.keyRotate(res, body, actor);
      }},
      { method: 'POST', action: 'keys/reset-quota', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return this.keyResetQuota(res, body);
      }},
      { method: 'POST', action: 'keys/delete', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return this.keyDelete(res, body, actor);
      }},
    ];
  }

  /** 配置与策略 */
  private configRoutes(): Route[] {
    return [
      { method: 'GET', action: 'config', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return json(res, 200, this.configView());
      }},
      { method: 'GET', action: 'report', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            // windowOf：一次取出生效毫秒数与标签。此前这里调了 3 次
            // （windowFrom ×2 + windowLabel ×1），而 windowLabel 内部还要再调两次
            // windowFrom、各读一次 searchParams —— 既浪费，也让「标签」与「数值」
            // 可能来自不同的参数读取（清单说谎，g-v439 同族）。
            const { windowMs, label } = windowOf(url);
            const since = Date.now() - windowMs;
            const summary = this.deps.meter.summarize(windowMs);
            let report = renderSummary(summary, { windowLabel: label });
            // 空窗口说明（manual#244）：renderSummary 在能力层（不动），空窗口时它输出完整的
            // 标题+零值+空章节——运营首次看到会以为报告坏了。这里补一句人话说明。
            // 判空复用 summarize 已算的 overall.requests（manual#330 复测优化）：此前为这一句
            // 多调一次 store.windowStatsPreferPersistent——SQLite 实现每次都会白跑一遍全量内存
            // scan（slice+sort+多次 reduce）只为决定回落分支（#330 实测 report 16ms 中这一调用
            // 约占 1/3；能力层根因待签字㉑）。同一请求里算过的不必再算。
            if (!summary.overall.requests) {
              report += String.fromCharCode(10, 10) + '（窗口内没有请求——上面各节为空是正常的，跑一次调用就有数据）';
            }
            // 追加「错的是什么」节（manual#190）：renderSummary 在能力层（src/loss/meter.ts）不改，
            // 但报告是运营贴工单/IM 的载体——排障页 #183 有的上游失败签名这里也要有。
            // 与 #183 同源过滤：客户端鉴权失败归报告的「失败归因」节，这里只列上游错误。
            // 计数复用 summarize 已算的 byFailureReason（manual#331，#330 同款「算过的不必再算」）：
            // 与 store.attributionStats(since).byReason 同源同数（summarize 内部就调它、过滤条件
            // 逐字相同）——#324 把计数从 recordsSince（内存镜像，重启后腰斩）改成 DB 级聚合，但那份
            // 聚合 summarize 刚算过；再调一次 attributionStats 是同请求内的重复贵调用（SQL 四连：
            // byReason+byAction+coverage+overhead）。example 尽力而为：内存镜像有对应记录（重启后
            // 的）才带，否则留空。
            const exMap = new Map<string, string>();
            for (const r of this.deps.store.recordsSince(since)) {
              if (!r.failureReason) continue;
              if (r.failureReason === 'auth_invalid' && !r.providerId) continue;
              if (!exMap.has(r.failureReason)) exMap.set(r.failureReason, (r.model || '') + '@' + (r.providerId || '') + ' HTTP ' + (r.httpStatus || 0));
            }
            const errs = (summary.byFailureReason || [])
              .map((r) => ({ reason: r.reason, count: r.count, example: exMap.get(r.reason) || '' }))
              .sort((a, b) => b.count - a.count).slice(0, 10);
            // 追加「模型」节（manual#229）：报告此前有分层/客户端/上游维度，唯独缺模型——
            // 而 GUI 的 ov 页有按模型表（overview.byModel）。交接文本要知道哪个模型在跑、
            // 哪个模型在错。
            // 数据源复用 summarize 已算的 byModel（manual#338，#330/#331 同款「算过的不必再算」
            // 第三处）：summarize 的 groupRows 优先走 store.dimensionStats（SQL 跨重启，内存仅
            // 回落——#337 查证），与本处原调用同源同数（#338 实证：两侧数字逐位一致）。
            // #331 曾以「summary.byModel 来自内存镜像」为由克制复用——那是误读（#337 已纠正），
            // 维度拆分实际与 overall 同为 SQL 持久聚合，复用无覆盖差异。
            const modelRows = (summary.byModel || [])
              .map((m) => ({ model: m.key, requests: m.requests, errors: m.errors, tokens: m.totalTokens, cost: m.costCny }))
              .sort((a, b) => b.requests - a.requests);
            if (modelRows.length) {
              const cny2 = (v: number) => '¥' + (Math.round((v || 0) * 1e6) / 1e6).toFixed(4);
              report += String.fromCharCode(10, 10) + '-- 模型 --' + String.fromCharCode(10) +
                modelRows.map((m) => '  ' + (m.model || '(未鉴权)').padEnd(22) + '请求 ' + String(m.requests).padStart(5) +
                  '  错误率 ' + ((m.requests ? (m.errors / m.requests) * 100 : 0).toFixed(2) + '%').padStart(7) +
                  '  token ' + String(m.tokens).padStart(8) + '  成本 ' + cny2(m.cost)).join(String.fromCharCode(10));
            }
            if (errs.length) {
              report += String.fromCharCode(10, 10) + '-- 错的是什么（上游失败签名） --' + String.fromCharCode(10) +
                // example 为空（重启前记录，内存镜像没有）时不带拖尾分隔符（manual#324）
                errs.map((e) => '  ' + e.reason + ' × ' + e.count + (e.example ? ' · ' + e.example : '')).join(String.fromCharCode(10));
            }
            return text(res, 200, report);
      }},
      { method: 'GET', action: 'attribution/catalog', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return json(res, 200, this.attributionCatalog());
      }},
      { method: 'GET', action: 'auth-policy', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return json(res, 200, this.authPolicyView());
      }},
      { method: 'GET', action: 'loss-reduction', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return json(res, 200, this.deps.config.lossReduction);
      }},
      { method: 'POST', action: 'loss-reduction/update', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return this.lossReductionUpdate(res, body, actor);
      }},
    ];
  }

  /** 进化方向 */
  private evolutionRoutes(): Route[] {
    return [
      { method: 'GET', action: 'evolution-direction', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return json(res, 200, this.evolutionDirectionView());
      }},
      { method: 'POST', action: 'evolution-direction', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return this.evolutionDirectionUpdate(res, body, actor);
          // kb/delete 必须走在下面 startsWith('kb/') 拦截之前（manual#97：该端点 panelInfo 有文档、
          // kbDelete 方法也在，但路由从未注册——一直落进 kbRoute 把 'delete' 当 KB id 报 404；
          // 文档即契约：panelInfo 列出的每个端点都必须实测可达）。
      }},
    ];
  }

  /** 知识库 */
  private kbRoutes(): Route[] {
    return [
      { method: 'POST', action: 'kb/delete', handler: (ctx) => {
        const { res, url, body, actor } = ctx;
            return this.kbDelete(res, body, actor);
      }},
    ];
  }

  /* ---------------- 委派：配置与目录视图（handlers/config.ts） ---------------- */

  private configView(): Record<string, unknown> {
    return this.config.view();
  }

  /** 公开：gateway/server.ts 的 GET /v1/models 直接调（按 key 白名单过滤） */
  modelList(authorization?: string): { id: string; object: string; created: number; owned_by: string }[] {
    return this.config.modelList(authorization);
  }

  /** 公开：gateway/server.ts 的 /v1/attribution/catalog 直接调 */
  attributionCatalog(): Record<string, unknown> {
    return this.config.attributionCatalog();
  }

  /* ---------------- 委派：上游运营动作（handlers/providers.ts） ---------------- */

  private providerToggle(res: ServerResponse, body: Record<string, unknown> | undefined): boolean {
    return this.providers.toggle(res, body);
  }

  private providerReset(res: ServerResponse, body: Record<string, unknown> | undefined): boolean {
    return this.providers.reset(res, body);
  }

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    headers: Record<string, string>,
    requestId: string,
  ): Promise<boolean> {
    const path = url.pathname.replace(/\/+$/, '') || '/admin';

    /*
     * 顺序很关键：**先给 HTML 外壳，再做鉴权**。
     *
     * 浏览器顶层导航无法携带 X-Admin-Token，所以只要"HTML 也走鉴权"，
     * 配置了 adminToken 的网关在浏览器里就永远是一页 401 JSON ——
     * 而登录门恰恰在 HTML 里面，于是它永远没机会出现（面板"不存在"了）。
     *
     * 这里提供的是**纯静态外壳**：只有样式、客户端脚本和登录表单，
     * 不含任何运营数据。数据全部在 /admin/api/* 后面，那些照旧要求令牌。
     * 这与"登录页必然可匿名访问"是同一件事。
     */
    if (path === '/admin' || path === '/admin/' || path === '/admin/dashboard') {
      const { html, gz } = shellPayload();
      secHeaders(res);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      // no-store（manual#92）：整个面板内联在这一页 HTML 里，浏览器一旦启发式缓存旧 HTML，
      // 新构建上线后用户看到的仍是旧页面（json/text 分支早有 no-store，唯独 HTML 分支漏了）。
      res.setHeader('cache-control', 'no-store');
      // gzip + vary（manual#165）：见 shellPayload 注释；vary 保证代理缓存按编码分份。
      res.setHeader('vary', 'accept-encoding');
      const ae = String(headers['accept-encoding'] ?? '');
      if (ae.includes('gzip')) {
        res.setHeader('content-encoding', 'gzip');
        res.writeHead(200);
        res.end(gz);
      } else {
        res.writeHead(200);
        res.end(html);
      }
      return true;
    }

    // panel-info 只回答"这个网关要不要令牌"和端点清单，不含任何数据。
    // 也必须免鉴权：否则首屏无法区分"体验模式（本机直连）"和"需要令牌"，
    // 只能一律显示"令牌无效"，把用户引向错误的排查方向。
    if (req.method === 'GET' && path === '/admin/api/panel-info') {
      return json(res, 200, this.panelInfo());
    }

    const auth = this.auth.authorize(req, headers);
    if (!auth.ok) {
      this.adminAuthFails.total += 1;
      this.adminAuthFails.lastAt = Date.now();
      this.adminAuthFails.lastRemote = req.socket.remoteAddress ?? '';
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.writeHead(401);
      res.end(JSON.stringify({ error: { message: auth.reason, type: 'authentication_error', code: 'admin_unauthorized' } }));
      return true;
    }

    if (!path.startsWith('/admin/api/')) return false;
    const action = path.slice('/admin/api/'.length);
    // HEAD 映射为 GET（manual#241）：管理面此前对 HEAD 返 405——健康检查/探测类客户端
    // （负载均衡、uptime 监控）常用 HEAD 做廉价探测，405 会被判成『端点不存在』。
    // Node 对 HEAD 响应自动剥 body（只送头），故直接改 method 走 GET 路由即可。
    if (req.method === 'HEAD') req.method = 'GET';
    // Content-Type 强制（challenge#1·S3 / p1#1）：POST/PUT/PATCH 端点必须带 application/json——
    // 无 Content-Type 的 JSON 端点接受请求是 CSRF 向量（表单提交可触发）。
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const ct = String(headers['content-type'] ?? '').toLowerCase();
      if (!ct.includes('application/json')) {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.writeHead(400);
        res.end(JSON.stringify({ error: { message: 'Content-Type 必须为 application/json', type: 'invalid_request_error', code: 'invalid_content_type' } }));
        return true;
      }
    }
    const body = await readJsonBody(req);
    // 请求体超 256KB：明确 413 而不是截断后 500（manual#144——超限时旧代码 break 断流，
    // 响应写出时管道抛错，运维看到的是『中转站内部错误』而非『你的 body 太大』）。
    if (body && '__tooLarge' in body && body['__tooLarge']) {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.writeHead(413);
      res.end(JSON.stringify({ error: { message: '请求体超过 256KB 上限', type: 'invalid_request_error', code: 'payload_too_large' } }));
      return true;
    }
    // P2 修复：无效 JSON 返回 400，区分空 body 和格式错误
    if (body && '__invalidJson' in body && body['__invalidJson']) {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.writeHead(400);
      res.end(JSON.stringify({ error: { message: '请求体不是有效的 JSON', type: 'invalid_request_error', code: 'invalid_json' } }));
      return true;
    }
    /*
     * 审计身份：key 的轮换/吊销是不可逆的运营动作，出事时必须查得出"是谁、从哪台机器"。
     * 之前事件里只有 keyId，于是"我的 key 怎么突然失效了"只能靠猜
     * （真实发生过：面板上一个误点的「轮换」让刚发出的 key 直接作废，谁都查不出来）。
     */
    const actor = `${req.socket.remoteAddress ?? '?'} ${String(headers['user-agent'] ?? '').slice(0, 60)}`.trim();

    // 精确匹配的路由表（P2 拆分第三层：声明式数据，见 buildRoutes）
    // req.method 类型上是 string | undefined，但 HTTP 请求必然带方法；
    // 原 switch 用模板串 `${req.method} ${action}`，undefined 会拼成 "undefined x"
    // 而落空——这里 ?? '' 同样落空，行为一致。
    const route = resolveRoute(this.routes, req.method ?? '', action);
    if (route) return route.handler({ req, res, url, body, actor });

    if (req.method === 'GET' && action.startsWith('traces/')) {
      const traceId = decodeURIComponent(action.slice('traces/'.length));
      // 查找顺序：内存环 → 持久化库（manual#99）。traceStore.find 只有内存环（重启即清空），
      // 而账本列出的是 recentPersistedTraces（含重启前历史）——不补这个回退，
      // 每次重启后点开任何旧 trace（含 #84 的详情、#99 的对比）都会 404。
      const findTrace = (tid: string): TraceRecord | undefined =>
        this.deps.traceStore.find(tid)
        ?? this.deps.store.recentPersistedTraces(500).find((t) => t.traceId === tid);
      const trace = findTrace(traceId);
      if (!trace) return json(res, 404, { error: { message: `轨迹不存在: ${traceId}（或已超出 5000 条复盘窗口）`, type: 'not_found_error', code: 'not_found' } });
      const other = url.searchParams.get('diff');
      if (other) {
        const otherTrace = findTrace(other);
        if (otherTrace) return json(res, 200, { trace, diff: diffTraces(otherTrace, trace), rendered: renderTrace(trace) });
      }
      // model 一等字段（manual#232）：与列表端点（#227 slim/非 slim）同一提取路径——
      // 此前单 trace 不带 model，抽屉（详情视图）与排障摘要都用不了。
      const model = traceModel(trace.steps);
      return json(res, 200, { trace: { ...trace, model }, rendered: renderTrace(trace) });
    }

    // 方法不容 → 405（manual#196）：switch 按 `METHOD action` 匹配，只读端点收到写方法时
    // 原一路穿透到通配 404『路由不存在』——路由存在、只是方法不对，HTTP 语义应是 405+Allow:GET
    // （kb/agent 集合端点早有 405，这批漏了）。外部消费者可依此分流，不再误判路由不存在。
    const READ_ONLY_ACTIONS = new Set([
      'health', 'overview', 'series', 'providers', 'keys', 'traces', 'events', 'metrics',
      'config', 'auth-policy', 'loss-reduction', 'auth-failures', 'top-errors',
      'attribution/catalog', 'report',
    ]);
    if (req.method !== 'GET' && (READ_ONLY_ACTIONS.has(action) || action.startsWith('traces/'))) {
      res.setHeader('allow', 'GET');
      return json(res, 405, {
        error: { message: `${action} 是只读端点，收到 ${req.method}——请用 GET`, type: 'method_not_allowed', code: 'method_not_allowed' },
      });
    }

    /* ---------------- 知识库 /admin/api/kb/... ---------------- */
    if (action === 'kb') {
      if (req.method === 'GET') return json(res, 200, this.kbView());
      if (req.method === 'POST') return this.kbCreate(res, body, actor);
      return json(res, 405, { error: { message: `kb 集合端点只支持 GET/POST，收到 ${req.method}`, type: 'method_not_allowed', code: 'method_not_allowed' } });
    }
    if (action.startsWith('kb/')) {
      return this.kbRoute(req.method ?? 'GET', action, url, body, res, actor);
    }

    /* ---------------- 内部 Agent /admin/api/agent/... ---------------- */
    if (action === 'agent') {
      if (req.method === 'GET') return json(res, 200, this.agentView());
      if (req.method === 'POST') return this.agentTrigger(res, body, actor);
      return json(res, 405, { error: { message: `agent 集合端点只支持 GET/POST，收到 ${req.method}`, type: 'method_not_allowed', code: 'method_not_allowed' } });
    }
    if (action.startsWith('agent/')) {
      return this.agentRoute(req.method ?? 'GET', action, url, body, res, actor);
    }

    void requestId;
    return false;
  }

  /* ---------------- 视图 ---------------- */

  /**
   * 免鉴权的自述信息：只回答"要不要令牌"，不含任何运营数据。
   * 首屏靠它决定是直接进面板还是弹登录门 —— 没有它就只能一律报"令牌无效"。
   */
  panelInfo(): Record<string, unknown> {
    return {
      tokenRequired: !!this.deps.config.server.adminToken,
      note: this.deps.config.server.adminToken
        ? '管理接口需要 X-Admin-Token（或 Authorization: Bearer）；看板外壳与 panel-info 本身不需要令牌'
        : '未配置 adminToken：管理接口仅接受来自 127.0.0.1/::1 的请求。这是体验模式的默认行为；生产环境请务必设置 adminToken。',
      writableEndpoints: [
        'POST /admin/api/agent （触发一次巡检·manual#135 进自动刷新白名单后 GUI 触发按钮消费）',
        'POST /admin/api/keys/create',
        'POST /admin/api/keys/update',
        'POST /admin/api/keys/revoke',
        'POST /admin/api/keys/rotate',
        'POST /admin/api/keys/reset-quota',
        'POST /admin/api/keys/delete （仅 panel 来源可彻底删除；config 来源 400 拒删并指引改配置；删除写墓碑（清空 keyHash）保证跨重启不复活——manual#306/#310）',
        'POST /admin/api/keys/whoami',
        'POST /admin/api/providers/toggle',
        'POST /admin/api/providers/reset',
        'POST /admin/api/loss-reduction/update',
        // 进化方向（manual#372）：operator 手动设置下一轮进化方向；落 data/evolution-direction.json
        // （gitignored）；引擎每轮第 0 步 GET 读取并同步进长期目标。clear:true 恢复自动排序。
        'POST /admin/api/evolution-direction （设置/清除下一轮进化方向·manual#372）',
        // 知识库（垂直 Agent 能力）
        'POST /admin/api/kb （创建 KB）',
        'POST /admin/api/kb/delete （删除 KB）',
        'PUT /admin/api/kb/{id} （更新 KB 元数据·manual#97）',
        'POST /admin/api/kb/{id}/docs （加文档）',
        'DELETE /admin/api/kb/{id}/docs/{docId} （删文档）',
        'GET /admin/api/kb/{id}/docs/{docId} （文档详情·编辑预填）',
        'PUT /admin/api/kb/{id}/docs/{docId} （替换文档·manual#94）',
        'POST /admin/api/kb/{id}/docs/batch （批量灌入·manual#95；200=报告语义：total/okCount/failCount + results 逐篇明细 [{title, ok, id?, chunkCount?, error?}]——GUI 的失败提示直接消费 results，不用翻事件日志）',
        // 状态码契约（manual#157）：创建类（POST kb / POST docs / POST keys-create）统一 201；
        // 更新/替换/批量报告 200；客户端按 res.ok 判断即可，需要分流时以此为准。
        'POST /admin/api/kb/{id}/search （检索）',
      ],
      readEndpoints: [
        'GET /admin/api/overview|series|providers|keys|auth-failures|traces|traces/:id|config|events|report|auth-policy|loss-reduction|metrics|attribution/catalog|top-errors',
        'GET /admin/api/health （管理面健康：healthz + serverStats）',
        'GET /admin/api/kb|kb/{id}/docs|kb/{id}/docs/{docId}|kb/{id}/stats （知识库，需启用）',
        'GET /admin/api/agent|agent/last|agent/runs （内部 Agent，需启用）',
        'GET /admin/api/evolution-direction （进化方向候选队列+当前手动设置·manual#372）',
      ],
      endpointNotes: {
        report: 'text/plain（渲染后的摘要文本，非 JSON——客户端按 raw 文本处理）；含分层/客户端类型/上游/模型/失败归因/建议动作/降损层收益各节（模型节 manual#229，数据源同 overview 的 dimensionStats）',
        agentLast: '尚无运行记录时返回 404（业务语义，非路由缺失）',
        tracesDiff: 'GET /admin/api/traces/:id?diff=<另一traceId> 返回 TraceDiff（diverged/onlyInA/onlyInB/durationDeltaMs/sameOutcome）——一成一败对比（manual#99）',
        // 性能三连的契约面（manual#166 补记）：三个新能力此前面临「实现了但契约没记账」——
        // API 消费者查 panelInfo 以为没有。slim 都是 opt-in 参数，默认返回不变。
        tracesSlim: 'GET /admin/api/traces?limit=N&slim=1 只回摘要字段（traceId/requestId/startedAt/durationMs/outcome/failedAtStage/stepCount/degraded/model，后三者服务端预计算/提取）——steps 详情按 id 单取 GET /traces/:id；100 条 235KB→25KB（manual#163）；model 从 route step 的 summary 提取（manual#227，noRoute/熔断两种失败形态也有来源 #261/#272），q 深搜支持按模型过滤（如 q=step-5-preview，窗口 limit≤5000、命中返回上限 200 条——扫全窗口保老 request-id 可寻，返回截断防 4635 命中的 1.2MB 响应，manual#299），单 trace 端点（GET /traces/:id）同样带 model（manual#232）。响应另带 deep（bool=本次是否深搜）与 scanned（number=**筛选前**的窗口大小，与 events 端点同义 #278）——深搜时 traces.length 是命中数、scanned 是搜索窗口，两者合起来回答『搜了多大窗口、命中多少』；无 q 时 scanned==traces.length',
        overviewSlim: 'GET /admin/api/overview?slim=1 省略 keys/events/topErrors（ov 页 15s 刷新只用 summary/providers/overheadUs/store/tiers）并跳过 keysView 计算；46.6KB→5.7KB（manual#164）；tiers 是档位策略表（label/precheck/attribution/rpm/maxConcurrency/periodQuotaTokens/periodQuotaCny，manual#199 随 overview 下发，ov 分层表与 ops 分层策略表同源）',
        shellGzip: 'GET /admin（外壳 HTML）按 accept-encoding 协商 gzip（vary: accept-encoding；无 gzip 的客户端照收原文）；161.5KB→54.3KB，进程内缓存（manual#165）',
        topErrors: 'GET /admin/api/top-errors?window=24h&limit=10 返回窗口内上游失败签名 [{reason, count, example}]（example=model@provider HTTP status）——排障页「错的是什么」块（manual#183）；与 auth-failures（鉴权 401）互补：那个管客户端 key，这个管上游错误。注意覆盖范围：数据来自进程内度量 records（启动以来），coveredSince 标明实际最早覆盖时刻——刚重启后比 window 短是正常的',
        // 在役数据暴露链的 notes（manual#270，#238 checklist：#265/#266/#267 的新字段进自描述）
        providersTools: 'GET /admin/api/providers 的 reachability[] 带 tools（manual#267）——该模型是否声明支持 tool calling（源=config.modelCapabilities，引擎智能路由的判定依据）；diag 页可达性表的『工具调用』列即此字段；注意『未声明』≠『不支持』（以声明状态为准）',
        providerToggle: 'POST /admin/api/providers/toggle 的 disabled 是**运行态**——人工摘除/恢复只对当前进程生效，重启后恢复 relay-net.yaml 的启用态（与熔断状态相反：openUntil/consecutiveFailures 经 persistBreaker 跨重启保持）；要永久下线请改配置文件（manual#311 补齐这个不对称的文档）',
        eventsFilters: 'GET /admin/api/events 的三个 opt-in 过滤参数（都可组合、都不传时行为不变）：kind=前缀（manual#168，语义=最近 N 条某类事件）；detail=0（manual#301，行只回 ts/level/kind/actor/brief 90 字预览，全量 detail 在点行/导出时按需拉）；level=error|warn|info（manual#314，排障『只看 error』）。三者先过滤后截断，统一保持『最近 N 条匹配事件』；响应回显 kind/level 与 scanned（筛选前窗口大小）',

        configLadders: 'GET /admin/api/config 带 modelLadders（manual#265）——档位阶梯（客户端模型名→按序尝试的模型链，前者失败自动落下一阶）；此前只暴露恒空的 modelAliases（旧机制），ladder 才是在役数据；ops 页『模型别名』行读此字段',
        kbConfig: 'GET /admin/api/kb 带 config（manual#266）——{path, chunkSize, chunkOverlap} KB 独立库的配置快照（主库路径在 config.storage，KB 是独立库 by design）；ov 页能力区 KB 行的路径/分块信息读此字段',
      },
      kbClient: this.deps.kb
        ? {
            enabled: this.deps.kb.ok,
            askEndpoint: 'POST /v1/kb/{id}/ask （带 Bearer key，检索后注入 system，走完整引擎链路）',
            health: this.deps.kb.health,
          }
        : { enabled: false, note: '知识库未启用（配置缺 kb.path）' },
    };
  }

  /* ---------------- 只读视图组（P2 拆分第四层）----------------
   * health / overview / series / keysView / authPolicyView / metricsView，
   * 以及 overview 的 15s 缓存（缓存键必须含**原始** window 参数，否则 `?window=10m`
   * 的标签会泄漏到 `?window=24h` 的响应里——缓存投毒）都已切到 handlers/views.ts。
   *
   * 这里只剩委派。getOverviewCache 仍对外：overview 路由要在缓存命中时直接
   * res.end(cached.json)，省掉一次约 25KB 的 JSON.stringify（ov 页 15s 一刷）。
   * ------------------------------------------------------------------ */

  /** 健康总览（面板"驾驶舱"页与 /healthz） */
  health(): Record<string, unknown> {
    return this.views.health();
  }

  /** overview 缓存（含预序列化 json，供路由层直接发送） */
  getOverviewCache(url: URL): { json: string; at: number } | undefined {
    return this.views.getOverviewCache(url);
  }

  /** 分层总览（面板"总览"页；slim=1 省略 keys/events/topErrors 供 15s 轮询） */
  overview(url: URL): Record<string, unknown> {
    return this.views.overview(url);
  }

  /** 时间序列（面板图表；桶随窗口自适应 + 空桶补零，让等距渲染即等时距渲染） */
  series(url: URL): Record<string, unknown> {
    return this.views.series(url);
  }

  /** key 视图（含 usage/policy/concurrency；slim=true 裁到 ov 页 chip 要的最小集） */
  keysView(slim = false): { keys: Record<string, unknown>[]; concurrency?: Record<string, unknown>[]; authFailures?: Record<string, unknown> } {
    return this.views.keysView(slim);
  }

  /** 鉴权与限流策略总览（面板"策略"页） */
  authPolicyView(): Record<string, unknown> {
    return this.views.authPolicyView();
  }

  /** 原始指标视图（面板"指标"页：计数器原始读数与延迟分布，回答"这个数为什么是这个值"） */
  metricsView(url: URL): Record<string, unknown> {
    return this.views.metricsView(url);
  }

  /* ---------------- 知识库（垂直 Agent 能力） ---------------- */
  // P2 拆分第四层：KB 视图/创建/删除/子路由分发已切到 handlers/kb.ts。
  // 这里只保留薄委派——AdminApi 负责组合，KbHandlers 负责行为。
  // 依赖只有 config.kb / kb / store 三个，是全类内聚度最高的一组。

  kbView(): Record<string, unknown> {
    return this.kb.view();
  }

  private kbCreate(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    return this.kb.create(res, body, actor);
  }

  private kbDelete(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    return this.kb.del(res, body, actor);
  }

  private kbRoute(
    method: string,
    action: string,
    url: URL,
    body: Record<string, unknown> | undefined,
    res: import('node:http').ServerResponse,
    actor?: string,
  ): boolean {
    return this.kb.route(method, action, url, body, res, actor);
  }

  /* ---------------- 内部 Agent /admin/api/agent/... ---------------- */
  // P2 拆分第四层第二刀：Agent 视图/触发/子路由已切到 handlers/agent.ts。

  private agentView(): Record<string, unknown> {
    return this.agent.view();
  }

  private agentTrigger(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    return this.agent.trigger(res, body, actor);
  }

  private agentRoute(
    method: string,
    action: string,
    url: URL,
    body: Record<string, unknown> | undefined,
    res: ServerResponse,
    actor?: string,
  ): boolean {
    return this.agent.route(method, action, url, body, res, actor);
  }

  /* ---------------- key 生命周期（面板核心写操作） ---------------- */
  // P2 拆分第四层第三刀：整组已切到 handlers/keys.ts。
  // 这里只保留薄委派——AdminApi 负责组合，KeyHandlers 负责行为。

  private unknownModels(models: string[] | undefined): string[] {
    return this.keys.unknownModels(models);
  }

  private keyCreate(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    return this.keys.create(res, body, actor);
  }

  private keyWhoami(res: ServerResponse, body: Record<string, unknown> | undefined): boolean {
    return this.keys.whoami(res, body);
  }

  private keyUpdate(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    return this.keys.update(res, body, actor);
  }

  /* ---------------- 进化方向（manual#372，operator 可控化） ---------------- */
  // P2 拆分第四层：已切到 handlers/evolution.ts（切它是为了让 key 组在 api.ts 里连贯）

  evolutionDirectionView(): { candidates: { id: string; label: string }[]; setting: Record<string, unknown> | null } {
    return this.evolution.view();
  }

  private evolutionDirectionUpdate(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    return this.evolution.update(res, body, actor);
  }

  private keyRevoke(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    return this.keys.revoke(res, body, actor);
  }

  private keyDelete(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    return this.keys.del(res, body, actor);
  }

  private keyRotate(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    return this.keys.rotate(res, body, actor);
  }

  private keyResetQuota(res: ServerResponse, body: Record<string, unknown> | undefined): boolean {
    return this.keys.resetQuota(res, body);
  }

  /* ---------------- 降损层热更新（可控 / 可逆） ---------------- */

  private lossReductionUpdate(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    if (!body) return badRequest(res, '缺少请求体');
    const lr = this.deps.config.lossReduction;
    const changed: string[] = [];
    // 热生效性分级（manual#161）：引擎（engine.ts）持有 config.lossReduction 的引用、每请求读
    // precheck/attribution——这些开关热生效；而 Meter 与 TraceStore 在 app.ts 构造时把 enabled
    // 捕获成值（new Meter({ enabled: ... })）——热改这两个字段是静默无效的（当前行为不变、
    // 重启后配置文件也没变=改动丢失）。此前统一 note『热生效』对这两个字段是谎报。
    // 修复在能力层（让 Meter/TraceStore 动态读配置）需签字；这里先把契约说真话：
    // 按字段分级返回，前端分开展示。
    const HOT = (f: string) => f.startsWith('precheck.') || f.startsWith('attribution.');
    const hot: string[] = [];
    const needsRestart: string[] = [];
    // P1 修复：使用类型安全的 setter 替代 as unknown as 双重断言
    const setBool = <K extends 'precheck' | 'attribution' | 'meter' | 'trace'>(path: K, obj: Record<string, unknown>, key: string): void => {
      const v = obj[key];
      if (typeof v === 'boolean') {
        // 类型安全：直接设置到 lr[path] 的对应字段
        const section = lr[path] as Record<string, unknown>;
        section[key] = v;
        const f = `${path}.${key}=${v}`;
        changed.push(f);
        (HOT(`${path}.${key}`) ? hot : needsRestart).push(f);
      }
    };
    if (body['precheck'] && typeof body['precheck'] === 'object') setBool('precheck', body['precheck'] as Record<string, unknown>, 'enabled');
    if (body['attribution'] && typeof body['attribution'] === 'object') {
      setBool('attribution', body['attribution'] as Record<string, unknown>, 'enabled');
      setBool('attribution', body['attribution'] as Record<string, unknown>, 'includeEvidence');
      // 精确模型名的阶梯兜底（r15）。热生效：engine 每请求读
      // `this.lr.attribution.siblingModelFallback`，而 this.lr 就是本对象的引用。
      // 关掉 => resolveLadder 对点名模型退回单阶，横向兜底耗尽后 429 直接丢回客户端。
      setBool('attribution', body['attribution'] as Record<string, unknown>, 'siblingModelFallback');
      const retry = (body['attribution'] as Record<string, unknown>)['autoRetry'];
      // r13 修复：必须是**整数**。此前只查 0<=x<=5，于是 2.5 也能进 —— 而 engine 用它做
      // `sameModelRetries < maxSameModelRetries` 的比较，2.5 实际等价于 2（允许 0/1/2），
      // 但面板会显示「2.5 次」，运营看到的是一个不存在的重试次数。
      if (typeof retry === 'number' && Number.isInteger(retry) && retry >= 0 && retry <= 5) {
        lr.attribution.autoRetry = retry;
        const f = `attribution.autoRetry=${retry}`;
        changed.push(f);
        hot.push(f);
      }
    }
    if (body['meter'] && typeof body['meter'] === 'object') setBool('meter', body['meter'] as Record<string, unknown>, 'enabled');
    if (body['trace'] && typeof body['trace'] === 'object') setBool('trace', body['trace'] as Record<string, unknown>, 'enabled');

    if (changed.length === 0) return badRequest(res, '没有可更新的降损层开关');
    // actor 入日志（manual#213）：降损开关是影响客户侧行为的运营动作（关降损=客户赔付变差），
    // 与 key 轮换同等的审计要求——此前漏记 IP+UA，出争议时查不出是谁改的。
    this.deps.store.logEvent('warn', 'loss_reduction.update', { changed, hot, needsRestart, actor: actor ?? 'panel' });
    this.deps.logger.warn('admin.loss_reduction_update', { changed, hot, needsRestart });
    const note = needsRestart.length
      ? (hot.length ? 'precheck/attribution 热生效；' : '') + 'meter/trace 开关在进程启动时捕获，热改无效——需修改 relay-net.yaml 后重启（本次内存改动重启即失效）'
      : '热生效，重启后回到配置文件的值';
    return json(res, 200, { ok: true, changed, hot, needsRestart, lossReduction: lr, note });
  }

  /* ---------------- 统一错误响应 ---------------- */





  /**
   * 公开额度视图（无需管理令牌）。
   *
   * 只给计数与时间：窗口内的请求数、按上游/模型的分布、token 与成本合计。
   * **不含** prompt/正文、客户端 key、上游密钥——它是给本机面板与插件读的，
   * 不是给外部匿名用户读的（所以关掉它的开关叫 publicQuota）。
   */
  publicQuota(): Record<string, unknown> {
    const now = Date.now();
    const windows = [1, 5, 24].map((hours) => {
      const ms = hours * 3_600_000;
      const since = now - ms;
      // 关键：走存储层的维度聚合（SQLite 走 SQL），而不是内存镜像。
      // 内存镜像在进程重启后是空的——用它会让"5 小时窗口计数"每次重启归零，
      // 而滚动窗口的计数恰恰不能归零。
      const modelStats = this.deps.store.dimensionStats(since, 'model') ?? new Map();
      const providerStats = this.deps.store.dimensionStats(since, 'provider_id') ?? new Map();
      const window = this.deps.store.windowStatsPreferPersistent(since);

      const models = [...modelStats.entries()]
        .map(([model, v]) => ({
          model,
          requests: v.requests,
          errors: v.errors,
          totalTokens: v.tokens,
          cachedPromptTokens: v.cachedTokens,
          costCny: Math.round(v.cost * 1e6) / 1e6,
        }))
        .sort((a, b) => b.requests - a.requests);
      const providersDetail = [...providerStats.entries()]
        .map(([provider, v]) => ({
          provider,
          requests: v.requests,
          errors: v.errors,
          totalTokens: v.tokens,
          costCny: Math.round(v.cost * 1e6) / 1e6,
        }))
        .sort((a, b) => b.requests - a.requests);

      const byModel: Record<string, number> = {};
      for (const m of models) byModel[m.model] = m.requests;
      const byProvider: Record<string, number> = {};
      for (const p of providersDetail) byProvider[p.provider] = p.requests;

      // 下一次额度释放的时刻：需要窗口内**最早那次请求**的时间。
      // dimensionStats 只给聚合值，所以这里单独查一次最早时间；查不到就退回窗口左边界。
      const oldestTs = this.deps.store.oldestInWindow(since) ?? 0;

      return {
        windowHours: hours,
        since,
        oldestTs,
        nextReleaseAt: oldestTs > 0 ? oldestTs + ms : 0,
        requests: window.requests,
        errors: window.errors,
        totalTokens: window.tokens,
        costCny: window.costCny,
        byProvider,
        byModel,
        models,
        providersDetail,
      };
    });
    const store = this.deps.store.health();
    return {
      now,
      uptimeS: Math.round(process.uptime()),
      store: { driver: store.driver, ok: store.ok },
      providers: this.deps.pool.snapshot().map((p) => ({
        id: p.id,
        disabled: p.disabled,
        healthy: p.health.healthy,
        breakerOpen: p.health.openUntil > now,
        consecutiveFailures: p.health.consecutiveFailures,
        ewmaLatencyMs: Math.round(p.health.ewmaLatencyMs),
        models: p.models,
      })),
      windows,
    };
  }

  /**
   * 公开面板数据包（无需管理令牌，仅供本机面板/插件读取）。
   *
   * 为什么要打包成一个端点：插件的 HTTP 客户端通常不能带自定义 header，
   * 一次调用比多次更省事；也让"暴露了什么"集中在一处可审计。
   *
   * 明确**不**包含：prompt/正文、客户端 key、上游密钥、上游 baseUrl。
   * 轨迹里的步骤摘要是排障必需的（含上游错误文案片段），已按条数截断。
   */
  publicPanel(url: URL): Record<string, unknown> {
    const { windowMs, label } = windowOf(url);
    // 统一走 numParam（manual#198）：此处原自带 Math.min/max clamp——功能等价但重复了
    // #148 要消灭的逻辑（同一套 min/max/默认值散落两处必漂移）。语义对齐：空/非有限→默认 30，
    // 0 会被 numParam 抬到 min=1（旧写法 || 30 把 0 也变默认——traces=0 本意应是取 1 条）。
    const traceLimit = numParam(url, 'traces', 30, 1, 100);
    const rawOverview = this.overview(url) as Record<string, unknown>;
    const metrics = this.metricsView(url) as Record<string, unknown>;

    /* 剥离管理面专用字段。
       注意：overview 内嵌的 keys 来自 keysView()，带 hashPrefix——
       那是管理员核对 key 用的，绝不能进公开端点。这里整体替换成脱敏版本。 */
    const publicKeys = this.keysView().keys.map((k) => ({
      id: k['id'],
      label: k['label'],
      tier: k['tier'],
      enabled: k['enabled'],
      origin: k['origin'],
      usage: k['usage'],
      policy: k['policy'],
    }));
    const overview: Record<string, unknown> = { ...rawOverview, keys: publicKeys };

    // 轨迹：优先读持久层（内存环在重启后是空的，而"回看昨晚那次失败"正需要它）。
    // 只给排障需要的字段，detail 里的值也做长度保护。
    const traces = this.deps.store
      .recentPersistedTraces(traceLimit)
      .map((t) => ({
        traceId: t.traceId,
        requestId: t.requestId,
        startedAt: t.startedAt,
        durationMs: t.durationMs,
        outcome: t.outcome,
        failedAtStage: t.failedAtStage ?? null,
        steps: t.steps.map((st) => ({
          stage: st.stage,
          offsetMs: st.offsetMs,
          ok: st.ok,
          summary: String(st.summary).slice(0, 240),
          error: st.error ? String(st.error).slice(0, 240) : null,
        })),
      }));

    // 时序桶：面板首页的柱状图需要，窗口自适应（点太多就换大桶）
    const nowMs = Date.now();
    const bucketMs = windowMs <= 3_600_000 ? 60_000 : windowMs <= 86_400_000 ? 3_600_000 : 86_400_000;
    const series = this.deps.store.series(nowMs - windowMs, bucketMs);

    return {
      now: nowMs,
      windowLabel: label,
      windowMs,
      bucketMs,
      series,
      // 版本镜像（manual#207）：真源是 gateway/server.ts 的 RELAY_VERSION（能力层、未导出），
      // 此处是它的展示镜像——升级版本改了 server.ts 要同步改这里（或导出常量由本处引用，
      // 已列签字项）。仅用于公开面板展示，不参与任何逻辑判断。
      version: '0.1.0',
      overview,
      metrics: {
        counters: metrics['counters'],
        overheadUs: metrics['overheadUs'],
        summaries: metrics['summaries'],
        derived: metrics['derived'],
        classCounters: metrics['classCounters'],
        uptimeS: metrics['uptimeS'],
      },
      providers: (overview['providers'] as unknown[]) ?? [],
      reachability: this.deps.router.reachability(),
      traces,
      keys: publicKeys,
      attribution: {
        failure_reasons: this.attributionCatalog()['failure_reasons'],
      },
    };
  }

  /* ---------------- 运营动作 ---------------- */



  /* ---------------- 工具 ---------------- */

  /**
   * 安全响应头（manual#342 安全轮）：管理面经 Tailscale Funnel 暴露，此前零安全头——
   * ① nosniff：防老浏览器把 JSON 响应嗅探成 HTML 执行（存储型 XSS 的经典载体）；
   * ② frame-options DENY：防点击劫持（攻击者页面套透明 iframe 诱导点管理面的写按钮）；
   * ③ referrer-policy no-referrer：管理面 URL 不带密钥（令牌在 localStorage+请求头），
   *   但面板路径/查询参数不应泄漏给第三方（如外链资源请求时的 Referer）。
   * CSP 刻意不加：整个面板是单页全内联（<style>+<script> 内嵌），可用的 CSP 只剩
   * unsafe-inline——加了等于没加还平添破坏面（一次外链资源变更就可能被拦）。
   * 若将来拆出外部脚本/样式再收紧。
   */

}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/**
 * 从 trace 的 route step 提取模型名（manual#261 扩展 #227）。
 *
 * 两种形态：
 *  ① 正常路由：`→ provider（reason）model=X`（#227 已覆盖）
 *  ② 无路由失败：`档位阶梯全部不可达：没有任何上游声明支持模型 X（这是模型清单问题…）`
 *     ——#227 只认 ①，未声明模型的请求（unknown 上游）在账本里 model 只显「—」，
 *     运营看不到是哪个模型名（如 step-1-8k）。补 ② 让这些请求也能按模型搜/显。
 * 注意 ② 的模型名后紧跟全角括号，[^\s（] 防止把括号吃进名字。
 */
function traceModel(steps: TraceRecord['steps'] | undefined): string | null {
  // ① summary 形态（#227 正常 model=X / #261 noRoute『支持模型 X』）。
  // 注意 find 要按摘要特征筛：阶梯别名请求有**两个** route step——第一个是阶梯计划
  // （『档位阶梯共 5 阶：…』无 model=），第二个才是实际路由（带 model=）。直接取第一个
  // 会拿到计划步（#272 回归实测：35 个阶梯请求的模型名全丢）。
  const rsSummary = (steps || []).find((s) => s.stage === 'route' && (/model=/.test(s.summary || '') || /支持模型\s/.test(s.summary || '')));
  if (rsSummary) {
    const m = String(rsSummary.summary).match(/model=(\S+)/) ?? String(rsSummary.summary).match(/支持模型\s+([^\s（]+)/);
    if (m && m[1]) return m[1];
  }
  // ② detail.ladder 形态（manual#272）：熔断冷却类失败（『上游 X 正处于熔断冷却中……
  // 与请求的模型名无关』）的模型名不在 summary 里——只在 route step 的 detail.ladder。
  // 此前账本对这类只显『—』（13 个熔断失败全无模型名，排查时看不到请求的是哪个模型）。
  // 只收单模型形态（不含 |）：阶梯别名请求的 detail.ladder 是整条链，客户真正请求的
  // 别名不在 trace 里（根修复在能力层 #227），显示整链会污染模型列——那种保持 null。
  const rsLadder = (steps || []).find((s) => {
    if (s.stage !== 'route') return false;
    const lad = s.detail && typeof s.detail === 'object' ? (s.detail as { ladder?: unknown }).ladder : undefined;
    return typeof lad === 'string' && lad.length > 0 && !lad.includes('|');
  });
  if (rsLadder) {
    return (rsLadder.detail as { ladder: string }).ladder;
  }
  return null;
}

/**
 * admin 外壳的进程内缓存 + gzip（manual#165）：整个面板内联在这一页 HTML 里（~160KB），
 * 首屏每次加载全量传输且此前无压缩——HTML 在进程内是静态的，首次请求时算好原文与
 * gzip 两份，之后零计算直接发；gzip 后约 30KB（-80%+），移动网络/Tailscale 首屏收益直接。
 * 不支持 gzip 的客户端（curl 脚本等）照发原文，行为不变。
 */
let SHELL_CACHE: { html: string; gz: Buffer } | null = null;
function shellPayload(): { html: string; gz: Buffer } {
  if (!SHELL_CACHE) {
    // 用户自定义看板优先（r22 接上）：放 `<项目根>/overrides/dashboard.html` 即可换皮，
    // 不用改代码、不用重新构建。loadCustomDashboard() 此前是**死代码** ——
    // docs/ARCHITECTURE.md 承诺过这个能力，却从未被调用。
    // 仍是进程内缓存（改文件要重启才生效），与内嵌 HTML 同样语义。
    const html = loadCustomDashboard(process.cwd()) ?? dashboardHtml();
    SHELL_CACHE = { html, gz: gzipSync(Buffer.from(html), { level: 6 }) };
  }
  return SHELL_CACHE;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | { __tooLarge: true } | { __invalidJson: true } | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  // F2 修复：30 秒读取超时（slowloris 防护）— 超时后 destroy socket 返回 undefined
  const timeout = setTimeout(() => { req.destroy(); }, 30_000);
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.byteLength;
      if (total > 256 * 1024) { tooLarge = true; continue; }  // 继续读以耗尽流（manual#144）
      chunks.push(buf);
    }
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
  if (tooLarge) return { __tooLarge: true };
  if (chunks.length === 0) return undefined;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { __invalidJson: true };
  } catch {
    // P2 修复：返回错误标记，区分空 body 和无效 JSON
    return { __invalidJson: true };
  }
}

/** 若存在用户自定义看板模板则优先使用（方便不改代码就换皮） */
export function loadCustomDashboard(root: string): string | undefined {
  const p = `${root}/overrides/dashboard.html`;
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}
