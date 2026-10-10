/**
 * 上游池与路由。
 *
 * 池负责"有哪些上游、谁健康、谁还有并发额度"；路由负责"这次请求用谁、为什么"。
 * 两者都不持有会话状态，重启后行为一致（熔断状态可从 SQLite 恢复）。
 *
 * 归因 → 熔断 → 故障转移 的闭环：
 *   classifyFailure 判为不可恢复（如 auth_invalid / quota_exhausted）→ 直接把上游摘到熔断；
 *   判为可恢复（rate_limited / 5xx / timeout）→ 计入连续失败，达到阈值摘除，冷却后半开。
 */

import type {
  ClientKind,
  ProviderConfig,
  ProviderHealth,
  RelayConfig,
  RouteDecision,
  TierPolicy,
  FailureReason,
} from '../core/types.js';
import { BoundedCache, ewma, ownLookup } from '../util/index.js';
import { createUpstreamClient, type UpstreamClient } from './client.js';
import { Logger } from '../core/logger.js';

/* ------------------------------------------------------------------ *
 * 并发闸门（每上游）
 * ------------------------------------------------------------------ */

export class ConcurrencyLimiter {
  private inFlight = 0;
  private queue: (() => void)[] = [];

  constructor(private limit: number) {}

  setLimit(limit: number): void {
    this.limit = Math.max(1, limit);
    this.drain();
  }

  get active(): number {
    return this.inFlight;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.inFlight < this.limit) {
      this.inFlight++;
      return () => this.release();
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const i = this.queue.indexOf(grant);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error('aborted'));
      };
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        // ⚠️ 必须在**同步**的 grant 里自增：drain() 调用 next() 后同一 tick 就要能看到
        // inFlight 变化，否则会误判"还有额度"而把整个队列一次性唤醒（审计 P2-8；
        // 对冲让同一上游并发 acquire 翻倍，更容易踩到）。
        this.inFlight++;
        resolve();
      };
      this.queue.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    return () => this.release();
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.drain();
  }

  private drain(): void {
    // grant() 现在**同步**自增 inFlight，所以这里的 while 条件在每次唤醒后立刻成立/失效，
    // 不会超发（审计 P2-8）。
    while (this.inFlight < this.limit && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      next();
    }
  }

  stats(): { active: number; waiting: number; limit: number } {
    return { active: this.inFlight, waiting: this.queue.length, limit: this.limit };
  }
}

/* ------------------------------------------------------------------ *
 * 上游池
 * ------------------------------------------------------------------ */

export interface PoolEntry {
  config: ProviderConfig;
  client: UpstreamClient;
  limiter: ConcurrencyLimiter;
  health: ProviderHealth;
}

export interface ProviderSnapshot {
  id: string;
  label: string;
  protocol: string;
  baseUrl: string;
  models: string[];
  tags: string[];
  weight: number;
  priority: number;
  disabled: boolean;
  health: ProviderHealth;
  concurrency: { active: number; waiting: number; limit: number };
  cost?: ProviderConfig['cost'];
  apiKeyMasked: string;
  /** 多 key 池健康度（单 key 时为 undefined） */
  keyPool?: { index: number; masked: string; dead: boolean; cooldownMsLeft: number; failures: number }[];
}

export class ProviderPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly breakerPersist?: (id: string, state: { openUntil: number; consecutiveFailures: number; lastReason?: string }) => void;

  constructor(
    private readonly config: RelayConfig,
    private readonly logger: Logger,
    options: {
      breakerPersist?: (id: string, state: { openUntil: number; consecutiveFailures: number; lastReason?: string }) => void;
      restoredBreakers?: Map<string, { openUntil: number; consecutiveFailures: number; lastReason?: string }>;
    } = {},
  ) {
    this.breakerPersist = options.breakerPersist;
    for (const p of config.providers) {
      // 把服务端的超时**真的接进**上游客户端（此前只传了 userAgent，
      // 导致配置里的 upstreamTtfbTimeoutMs / upstreamTimeoutMs 形同虚设）。
      const client = createUpstreamClient(p, {
        userAgent: 'api-relay/0.1',
        timeoutMs: config.server.upstreamTimeoutMs,
        ttfbTimeoutMs: config.server.upstreamTtfbTimeoutMs,
        ...(config.server.upstreamStallTimeoutMs !== undefined
          ? { stallTimeoutMs: config.server.upstreamStallTimeoutMs }
          : {}),
      });
      const restored = options.restoredBreakers?.get(p.id);
      // healthy 必须与 openUntil 一致（r10 修复）：此前这里硬编码 `healthy: true`，
      // 于是恢复一个**仍处于熔断**的上游时，面板详情页会显示「健康: 正常」紧挨着
      // 「熔断剩余: 29分」——自相矛盾，运维据此会以为上游可用。
      // 不变量：healthy === (openUntil <= now)，由 noteFailure/noteSuccess/isOpen 共同维持。
      const restoredOpenUntil = restored?.openUntil ?? 0;
      this.entries.set(p.id, {
        config: p,
        client,
        limiter: new ConcurrencyLimiter(p.concurrency ?? 32),
        health: {
          providerId: p.id,
          healthy: restoredOpenUntil <= Date.now(),
          consecutiveFailures: restored?.consecutiveFailures ?? 0,
          openUntil: restoredOpenUntil,
          ...(restored?.lastReason ? { lastFailureReason: restored.lastReason as FailureReason } : {}),
          ewmaLatencyMs: 0,
          totalRequests: 0,
          totalFailures: 0,
        },
      });
    }
  }

  get(id: string): PoolEntry | undefined {
    return this.entries.get(id);
  }

  all(): PoolEntry[] {
    return [...this.entries.values()];
  }

  /** 是否处于熔断打开状态 */
  isOpen(entry: PoolEntry, now = Date.now()): boolean {
    if (entry.health.openUntil === 0) return false;
    if (now >= entry.health.openUntil) {
      // 半开：允许一次试探
      entry.health.openUntil = 0;
      entry.health.healthy = true;
      this.persistBreaker(entry);
      return false;
    }
    return true;
  }

  /** 可用性：未禁用 + 未熔断 */
  isAvailable(entry: PoolEntry, now = Date.now()): boolean {
    if (entry.config.disabled) return false;
    return !this.isOpen(entry, now);
  }

  noteSuccess(entry: PoolEntry, latencyMs: number): void {
    entry.health.consecutiveFailures = 0;
    entry.health.healthy = true;
    entry.health.openUntil = 0;
    entry.health.ewmaLatencyMs = ewma(entry.health.ewmaLatencyMs, latencyMs);
    entry.health.totalRequests++;
    this.persistBreaker(entry);
  }

  noteFailure(entry: PoolEntry, reason: FailureReason, fatal: boolean): void {
    entry.health.consecutiveFailures++;
    entry.health.lastFailureReason = reason;
    entry.health.lastErrorAt = Date.now();
    entry.health.totalRequests++;
    entry.health.totalFailures++;
    const { breakerThreshold, breakerCooldownMs } = this.config.lossReduction.attribution;
    if (fatal || entry.health.consecutiveFailures >= breakerThreshold) {
      entry.health.healthy = false;
      entry.health.openUntil = Date.now() + breakerCooldownMs;
      this.logger.warn('upstream.breaker_open', {
        provider: entry.config.id,
        reason,
        fatal,
        consecutiveFailures: entry.health.consecutiveFailures,
        cooldownMs: breakerCooldownMs,
      });
    } else {
      entry.health.healthy = true;
    }
    this.persistBreaker(entry);
  }

  /** 人工摘除/恢复（运营动作） */
  setDisabled(providerId: string, disabled: boolean): boolean {
    const entry = this.entries.get(providerId);
    if (!entry) return false;
    entry.config.disabled = disabled;
    if (!disabled) {
      entry.health.openUntil = 0;
      entry.health.consecutiveFailures = 0;
      entry.health.healthy = true;
    }
    this.persistBreaker(entry);
    return true;
  }

  /**
   * 人工重置熔断（运营动作，r10 修复）。
   *
   * 此前 admin 的 providerReset **直接改 entry.health 字段、不走 persistBreaker**——
   * 于是「重置成功」只对当前进程生效，重启后从 breaker_state 恢复出旧的 openUntil/
   * consecutiveFailures，熔断原样回来。实测：置 openUntil=+30min → POST reset（回 200
   * openUntil:0）→ 重启 → 仍熔断剩 1673 秒。运维会以为重置没生效而反复点。
   *
   * 与 setDisabled 的关键区别：那个只改 config.disabled（运行态，重启回配置文件），
   * 顺带清熔断；本方法只清熔断**且必须落盘**——因为熔断恰恰是跨重启保持的那一半。
   */
  resetBreaker(providerId: string): boolean {
    const entry = this.entries.get(providerId);
    if (!entry) return false;
    entry.health.consecutiveFailures = 0;
    entry.health.openUntil = 0;
    entry.health.healthy = true;
    this.persistBreaker(entry);
    return true;
  }

  private persistBreaker(entry: PoolEntry): void {
    try {
      this.breakerPersist?.(entry.config.id, {
        openUntil: entry.health.openUntil,
        consecutiveFailures: entry.health.consecutiveFailures,
        ...(entry.health.lastFailureReason ? { lastReason: entry.health.lastFailureReason } : {}),
      });
    } catch {
      /* fail-open */
    }
  }

  snapshot(): ProviderSnapshot[] {
    return this.all().map((e) => {
      const keyPool = (e.client as unknown as { keySnapshot?: () => ProviderSnapshot['keyPool'] }).keySnapshot?.();
      const keyCount = (e.config.apiKeys?.length ?? 0) + (e.config.apiKey ? 1 : 0);
      return {
        id: e.config.id,
        label: e.config.label,
        protocol: e.config.protocol,
        baseUrl: e.config.baseUrl,
        models: e.config.models,
        tags: e.config.tags ?? [],
        weight: e.config.weight ?? 1,
        priority: e.config.priority ?? 0,
        disabled: !!e.config.disabled,
        health: { ...e.health },
        concurrency: e.limiter.stats(),
        ...(e.config.cost ? { cost: e.config.cost } : {}),
        // 2026-09-14 审计 B-1：快照只带 cost，面板因此看不到双口径/按型号覆盖。
        // 财务按面板单价对账必错（Agnes 面板显示 ¥0.36/¥1.08，实际实付已被
        // modelCosts 覆盖成 0）。这里把其余价格字段与 http2 开关一并暴露。
        ...(e.config.listCost ? { listCost: e.config.listCost } : {}),
        ...(e.config.modelCosts ? { modelCosts: e.config.modelCosts } : {}),
        ...(e.config.modelListCosts ? { modelListCosts: e.config.modelListCosts } : {}),
        ...(e.config.http2 ? { http2: true } : {}),
        apiKeyMasked: keyCount > 1 ? `${keyCount} keys` : maskKey(e.config.apiKey),
        ...(keyPool ? { keyPool } : {}),
      };
    });
  }
}

/* ------------------------------------------------------------------ *
 * 任务复杂度判定（P8 数据飞轮的入口）
 * ------------------------------------------------------------------ */

export interface ComplexityInput {
  body: Record<string, unknown>;
  clientKind: ClientKind;
  isToolCalling: boolean;
}

export interface ComplexityVerdict {
  level: 'simple' | 'standard' | 'complex';
  score: number;
  signals: string[];
}

/**
 * 纯函数启发式。刻意保持保守：只有在**明确证据**下才降级为 simple，
 * 因为"把难任务路由到弱模型"是比多花钱严重得多的错误。
 */
export function assessComplexity(input: ComplexityInput): ComplexityVerdict {
  const body = input.body;
  const signals: string[] = [];
  let score = 0;

  const messages = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : [];
  const tools = Array.isArray(body['tools']) ? (body['tools'] as unknown[]) : [];
  const model = typeof body['model'] === 'string' ? (body['model'] as string) : '';
  const textLen = JSON.stringify(messages).length;

  if (tools.length > 0) {
    score += 3;
    signals.push('tools_declared(+3)');
  }
  if (input.isToolCalling) {
    score += 3;
    signals.push('tool_calls_in_history(+3)');
  }
  if (messages.length > 4) {
    score += 2;
    signals.push(`messages=${messages.length}(+2)`);
  }
  if (textLen > 20_000) {
    score += 3;
    signals.push(`payload=${textLen}B(+3)`);
  } else if (textLen > 6_000) {
    score += 1;
    signals.push(`payload=${textLen}B(+1)`);
  }
  const maxTokens = Number(body['max_tokens'] ?? body['max_completion_tokens'] ?? 0);
  if (maxTokens > 2_000) {
    score += 2;
    signals.push(`max_tokens=${maxTokens}(+2)`);
  }
  if (/(reason|think|o1|o3|r1|deep-?seek-?reasoner|qwq)/i.test(model)) {
    score += 4;
    signals.push('reasoning_model(+4)');
  }
  if (body['response_format'] !== undefined) {
    score += 1;
    signals.push('structured_output(+1)');
  }
  if (input.clientKind === 'agent') {
    score += 1;
    signals.push('agent_client(+1)');
  }

  const level: ComplexityVerdict['level'] = score >= 6 ? 'complex' : score >= 2 ? 'standard' : 'simple';
  return { level, score, signals };
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

export interface RouteOptions {
  requestedModel: string;
  /**
   * 本次请求内**重试无意义**的上游（密钥/权限/余额这类致命错误）。
   * 注意：瞬态失败（限流/超时/5xx）**不能**放进这里——若它是唯一上游，
   * 那等于让"重试"永远无法发生。
   */
  exclude: Set<string>;
  /** 本次请求内已经试过的上游：仍然可选，但排在没试过的后面（避免抖动） */
  tried?: Set<string>;
  /** 刚失败过的上游：优先级最低（只在没有其他候选时才回到它） */
  deprioritize?: Set<string>;
  tier: TierPolicy;
  clientKind: ClientKind;
  complexity: ComplexityVerdict;
  now?: number;
  /** 强制指定上游（用于 A/B 或排障） */
  forceProviderId?: string;
}

export interface RouteResult {
  decision: RouteDecision;
  entry: PoolEntry;
}

export type NoRouteKind =
  /** 没有任何上游声明支持这个模型 —— 确实该换模型 */
  | 'model_unsupported'
  /** 有上游支持，但全被禁用 —— 运营动作导致 */
  | 'all_disabled'
  /** 有上游支持，但都在熔断冷却中 —— 上游故障，等冷却或去修它 */
  | 'all_breaker_open'
  /** 有上游声明支持，但全部在**本次请求内**被排除（如已判定为供应商级致命错误） */
  | 'all_excluded'
  /** 混合原因（熔断 + 禁用 + 请求级排除同时存在） */
  | 'mixed';

export class NoRouteError extends Error {
  readonly kind: NoRouteKind;
  /** 熔断中的上游及其最近失败原因（用于把"上游挂了"和"模型不存在"区分开） */
  readonly openBreakers: { providerId: string; consecutiveFailures: number; lastFailureReason?: string }[];

  constructor(
    readonly requestedModel: string,
    /** **声明**支持该模型的上游（不管是否被禁用/熔断/请求级排除）。
     *  这个列表是"模型不存在"与"模型存在但暂时没路"的唯一判据：
     *  以前这里在抛出点固定传 []，导致任何零候选都被判成"没人声明这个模型"，
     *  于是把上游故障说成模型名写错。 */
    readonly declared: string[],
    readonly rejected: { providerId: string; why: string }[],
    readonly breakers: { providerId: string; consecutiveFailures: number; lastFailureReason?: string }[] = [],
    readonly disabledCount = 0,
  ) {
    super(
      `没有可用上游能服务模型 ${requestedModel}（声明支持它的上游 ${declared.length} 个，本次全部不可用：${rejected
        .map((r) => `${r.providerId}:${r.why}`)
        .join('; ') || '无'}）`,
    );
    this.name = 'NoRouteError';
    this.openBreakers = breakers;
    const declaredCount = declared.length;
    const excluded = declaredCount - disabledCount - breakers.length;
    if (declaredCount === 0) this.kind = 'model_unsupported';
    else if (breakers.length > 0 && disabledCount === 0 && excluded === 0) this.kind = 'all_breaker_open';
    else if (disabledCount > 0 && breakers.length === 0 && excluded === 0) this.kind = 'all_disabled';
    else if (breakers.length === 0 && disabledCount === 0 && excluded > 0) this.kind = 'all_excluded';
    else this.kind = 'mixed';
  }

  /** 熔断上游的**根本**失败原因（供机器分流：限流该退避，密钥错该换 key） */
  get rootCause(): string | undefined {
    return this.openBreakers[0]?.lastFailureReason;
  }
}

export class Router {
  constructor(
    private readonly pool: ProviderPool,
    private readonly config: RelayConfig,
  ) {}

  /** 把用户请求的 model 解析为上游真实模型名 */
  resolveModel(requested: string): string {
    // ownLookup 而非 this.config.modelAliases[requested]：模型名直接来自请求体，
    // `model=constructor` / `toString` / `valueOf` 会命中 Object.prototype 而拿到一个
    // 函数，接着被当成"真实模型名"往下传 —— 实测把这些 JS 内部结构泄漏进了
    // 404 报文（"没有任何上游声明支持模型 function toString() { [native code] }"）。
    const alias = ownLookup(this.config.modelAliases, requested);
    return alias ?? requested;
  }

  /**
   * 网关**认识**的全部模型名（含别名与档位阶梯名），不管当前能不能服务。
   *
   * 为什么是"认识"而不是"可用"：P2 预检的职责是判断"这个名字是不是我们会服务的名字"。
   * 如果上游被禁用就把它从目录里删掉，预检会给出"网关不认识模型 X"——
   * 而事实是这个模型存在、只是它的上游暂时不可用。用户会去改模型名，越改越错。
   *
   * 所以：预检用 catalog()（认识的名字），路由失败时再由 route() 给出准确原因
   * （"没有可用上游"而不是"模型不存在"）。对外列模型用 availableCatalog()。
   */
  catalog(): string[] {
    const set = new Set<string>();
    for (const e of this.pool.all()) {
      for (const m of e.config.models) set.add(m);
      for (const [alias, target] of Object.entries(e.config.modelMap ?? {})) {
        if (e.config.models.includes(target)) set.add(alias);
      }
    }
    for (const alias of Object.keys(this.config.modelAliases)) set.add(alias);
    for (const name of Object.keys(this.config.modelLadders ?? {})) set.add(name);
    return [...set].sort();
  }

  /**
   * 当前**真的能服务**的模型名（上游未禁用）。用于对外 `GET /v1/models`
   * 与管理面板——列出此刻能用的，而不是全部名义上认识的。
   */
  availableCatalog(): string[] {
    const set = new Set<string>();
    for (const e of this.pool.all()) {
      if (e.config.disabled) continue;
      for (const m of e.config.models) set.add(m);
      for (const [alias, target] of Object.entries(e.config.modelMap ?? {})) {
        if (e.config.models.includes(target)) set.add(alias);
      }
    }
    for (const [alias, target] of Object.entries(this.config.modelAliases)) {
      if (this.pool.all().some((e) => !e.config.disabled && e.config.models.includes(target))) set.add(alias);
    }
    // 阶梯名：至少有一阶能服务才算可用
    for (const [name, ladder] of Object.entries(this.config.modelLadders ?? {})) {
      const reachable = ladder.some((step) => {
        const target = this.resolveModel(step);
        return this.pool.all().some((e) => !e.config.disabled && e.config.models.includes(target));
      });
      if (reachable) set.add(name);
    }
    return [...set].sort();
  }

  /** 阶梯名 → 实际可达的上游集合（把每一阶的上游并起来） */
  ladderReachability(): { model: string; providers: string[]; ladder: string[] }[] {
    const out: { model: string; providers: string[]; ladder: string[] }[] = [];
    for (const [name, rawLadder] of Object.entries(this.config.modelLadders ?? {})) {
      const ladder = rawLadder.map((m) => this.resolveModel(m));
      const providers = new Set<string>();
      for (const step of ladder) {
        const target = this.resolveModel(step);
        for (const e of this.pool.all()) {
          if (!e.config.disabled && e.config.models.includes(target)) providers.add(e.config.id);
        }
      }
      out.push({ model: name, providers: [...providers], ladder });
    }
    return out;
  }

  /** 上游实际的模型名（供 provider.modelMap 转换） */
  private upstreamModelFor(entry: PoolEntry, target: string): string {
    // ownLookup：target 是模型名（源自请求体），'constructor' 等原型链键会命中
    // Object.prototype 而拿到函数，本该走 `?? target` 回落的分支被静默跳过。
    return ownLookup(entry.config.modelMap, target) ?? target;
  }

  route(opts: RouteOptions): RouteResult {
    const now = opts.now ?? Date.now();
    const target = this.resolveModel(opts.requestedModel);
    const tried = opts.tried ?? new Set<string>();
    const deprioritize = opts.deprioritize ?? new Set<string>();
    const rejected: { providerId: string; why: string }[] = [];
    const breakers: { providerId: string; consecutiveFailures: number; lastFailureReason?: string }[] = [];
    let disabledCount = 0;
    // 先记录"谁声明支持这个模型"——这是与"模型名写错"区分开的唯一依据
    const declared = this.pool
      .all()
      .filter((e) => e.config.models.includes(target))
      .map((e) => e.config.id)
      .sort();

    const candidates = this.pool.all().filter((e) => {
      if (opts.exclude.has(e.config.id)) {
        rejected.push({ providerId: e.config.id, why: 'fatal_error_this_request' });
        return false;
      }
      if (!e.config.models.includes(target)) return false;
      if (e.config.disabled) {
        disabledCount++;
        rejected.push({ providerId: e.config.id, why: 'disabled' });
        return false;
      }
      if (this.pool.isOpen(e, now)) {
        breakers.push({
          providerId: e.config.id,
          consecutiveFailures: e.health.consecutiveFailures,
          ...(e.health.lastFailureReason ? { lastFailureReason: e.health.lastFailureReason } : {}),
        });
        rejected.push({ providerId: e.config.id, why: `breaker_open(连续 ${e.health.consecutiveFailures} 次失败${e.health.lastFailureReason ? '，最近原因 ' + e.health.lastFailureReason : ''})` });
        return false;
      }
      return true;
    });

    // 强制指定（排障/A-B）
    if (opts.forceProviderId) {
      const forced = this.pool.get(opts.forceProviderId);
      if (forced && forced.config.models.includes(target)) {
        candidates.length = 0;
        candidates.push(forced);
      } else {
        rejected.push({ providerId: opts.forceProviderId, why: '强制指定但该上游不声明此模型' });
      }
    }

    if (candidates.length === 0) {
      throw new NoRouteError(target, declared, rejected, breakers, disabledCount);
    }

    let reason: RouteDecision['reason'] = 'explicit';
    if (!opts.forceProviderId) {
      const costAware = opts.tier.smartRouting && opts.complexity.level === 'simple';
      if (costAware) {
        const priced = candidates.filter((c) => c.config.cost);
        if (priced.length > 0) {
          candidates.splice(0, candidates.length, ...priced);
          reason = 'smart_routing';
        }
      }
      // 分层排序：
      //   ① 本次请求还没试过的上游优先（抖动时自动探索其他上游）
      //   ② 刚失败的上游排最后（只在无其他候选时才回到它 —— 这就是"重试"的唯一出路）
      //   ③ 优先级 → 成本 → 权重 → ewma 延迟
      candidates.sort((a, b) => {
        const ta = tried.has(a.config.id) ? 1 : 0;
        const tb = tried.has(b.config.id) ? 1 : 0;
        if (ta !== tb) return ta - tb;
        const da = deprioritize.has(a.config.id) ? 1 : 0;
        const db = deprioritize.has(b.config.id) ? 1 : 0;
        if (da !== db) return da - db;
        const pa = a.config.priority ?? 0;
        const pb = b.config.priority ?? 0;
        if (pa !== pb) return pb - pa;
        const ca = a.config.cost ? a.config.cost.inputPerMTok + a.config.cost.outputPerMTok : Number.POSITIVE_INFINITY;
        const cb = b.config.cost ? b.config.cost.inputPerMTok + b.config.cost.outputPerMTok : Number.POSITIVE_INFINITY;
        if (ca !== cb) return ca - cb;
        const wa = a.config.weight ?? 1;
        const wb = b.config.weight ?? 1;
        if (wa !== wb) return wb - wa;
        const la = a.health.ewmaLatencyMs || Number.POSITIVE_INFINITY;
        const lb = b.health.ewmaLatencyMs || Number.POSITIVE_INFINITY;
        return la - lb;
      });
      if (reason === 'explicit' && tried.size > 0) reason = 'failover';
      else if (reason === 'explicit' && candidates.length > 1) reason = 'priority';
    }

    const winner = candidates[0]!;
    const decision: RouteDecision = {
      providerId: winner.config.id,
      upstreamModel: this.upstreamModelFor(winner, target),
      reason,
      attempt: tried.size,
      candidatesConsidered: candidates.map((c) => c.config.id),
      ...(winner.config.cost
        ? { estimatedCostPerMTok: round2((winner.config.cost.inputPerMTok + winner.config.cost.outputPerMTok) / 2) }
        : {}),
    };
    return { decision, entry: winner };
  }

  /** 给定模型的可路由上游（管理看板用）。阶梯名也会出现，列的是各阶上游的并集。 */
  reachability(): { model: string; providers: string[]; ladder?: string[] }[] {
    const byName = new Map<string, string[]>();
    for (const r of this.ladderReachability()) byName.set(r.model, r.ladder);
    const out: { model: string; providers: string[]; ladder?: string[] }[] = [];
    for (const model of this.catalog()) {
      const target = this.resolveModel(model);
      const providers = this.pool
        .all()
        .filter((e) => !e.config.disabled && e.config.models.includes(target))
        .map((e) => e.config.id);
      const ladder = byName.get(model);
      if (ladder) {
        // 阶梯名没有"自己"的上游——它的可达性是各阶上游的并集
        const union = new Set<string>(providers);
        for (const step of ladder) {
          for (const e of this.pool.all()) {
            if (!e.config.disabled && e.config.models.includes(step)) union.add(e.config.id);
          }
        }
        out.push({ model, providers: [...union], ladder });
      } else {
        out.push({ model, providers });
      }
    }
    return out;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function maskKey(key: string): string {
  return key.length > 10 ? `${key.slice(0, 6)}...${key.slice(-4)}` : '***';
}

/* ------------------------------------------------------------------ *
 * 同轮/短窗口重复请求去重（P7 的网关侧等价物）
 * ------------------------------------------------------------------ */

/**
 * 注意：中转站不能"同轮去重"（没有轮的概念，也没有返回旧结果的权力——那等于 P6 缓存，
 * 会破坏信任假设）。这里做的是**只读观测**：统计同一 key 在短窗口内发送了完全相同的
 * payload 的次数，用于 P8 度量与向用户提示"你在无效重试"。
 * 判定为纯函数 + 有界窗口计数，绝不缓存响应、绝不返回陈旧结果。
 */
export class DuplicateObserver {
  private readonly windows: { push(key: string, ts: number): void; count(key: string, ts: number): number };

  constructor(private readonly windowMs = 60_000) {
    const buckets = new BoundedCache<{ ts: number; n: number }>(20_000);
    this.windows = {
      push: (key, ts) => {
        const cur = buckets.get(key);
        if (cur && ts - cur.ts <= windowMs) buckets.set(key, { ts: cur.ts, n: cur.n + 1 });
        else buckets.set(key, { ts, n: 1 });
      },
      count: (key, ts) => {
        const cur = buckets.get(key);
        return cur && ts - cur.ts <= windowMs ? cur.n : 0;
      },
    };
  }

  /** 记录一次并返回窗口内累计次数（含本次） */
  observe(keyId: string, payloadHash: string, ts = Date.now()): number {
    const key = `${keyId}:${payloadHash}`;
    this.windows.push(key, ts);
    return this.windows.count(key, ts);
  }

  /** 只读峰值，不产生写入（用于看板） */
  peek(keyId: string, payloadHash: string, ts = Date.now()): number {
    return this.windows.count(`${keyId}:${payloadHash}`, ts);
  }
}

/* ------------------------------------------------------------------ *
 * 每 key 的短窗口特征累计（供无状态指纹增强，不存正文）
 * ------------------------------------------------------------------ */

export interface KeyWindowFeatures {
  requests60s: number;
  distinctSystemPrompts5m: number;
  failures10m: number;
}

export class KeyFeatureWindow {
  private readonly requests = new Map<string, number[]>();
  private readonly systemPrompts = new Map<string, { hash: string; ts: number }[]>();
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly maxKeys = 20_000) {}

  observeRequest(keyId: string, ts = Date.now()): void {
    push(this.requests, keyId, ts, 120_000, this.maxKeys);
  }

  observeSystemPrompt(keyId: string, hash: string, ts = Date.now()): void {
    if (!hash) return;
    const arr = this.systemPrompts.get(keyId) ?? [];
    arr.push({ hash, ts });
    prunePrompts(arr, ts, 600_000);
    this.systemPrompts.set(keyId, arr);
    this.trim(this.systemPrompts);
  }

  observeFailure(keyId: string, ts = Date.now()): void {
    push(this.failures, keyId, ts, 1_200_000, this.maxKeys);
  }

  features(keyId: string, ts = Date.now()): KeyWindowFeatures {
    const reqs = this.requests.get(keyId) ?? [];
    const fails = this.failures.get(keyId) ?? [];
    const prompts = this.systemPrompts.get(keyId) ?? [];
    const distinct = new Set(prompts.filter((p) => ts - p.ts <= 300_000).map((p) => p.hash));
    return {
      requests60s: reqs.filter((t) => ts - t <= 60_000).length,
      distinctSystemPrompts5m: distinct.size,
      failures10m: fails.filter((t) => ts - t <= 600_000).length,
    };
  }

  private trim(map: Map<string, { hash: string; ts: number }[]>): void {
    if (map.size <= this.maxKeys) return;
    let dropped = 0;
    for (const k of map.keys()) {
      map.delete(k);
      if (++dropped > this.maxKeys / 2) break;
    }
  }
}

function push(map: Map<string, number[]>, keyId: string, ts: number, windowMs: number, maxKeys: number): void {
  const arr = map.get(keyId) ?? [];
  arr.push(ts);
  prune(arr, ts, windowMs);
  map.set(keyId, arr);
  if (map.size > maxKeys) {
    let dropped = 0;
    for (const k of map.keys()) {
      map.delete(k);
      if (++dropped > maxKeys / 2) break;
    }
  }
}

function prune(arr: number[], ts: number, windowMs: number): void {
  const cutoff = ts - windowMs;
  while (arr.length > 0 && arr[0]! < cutoff) arr.shift();
}

function prunePrompts(arr: { hash: string; ts: number }[], ts: number, windowMs: number): void {
  const cutoff = ts - windowMs;
  while (arr.length > 0 && arr[0]!.ts < cutoff) arr.shift();
}

