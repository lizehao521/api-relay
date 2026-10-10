/**
 * 客户端 key 鉴权、限流、额度、并发闸门。
 *
 * 设计原则（对齐评估文档 §6 分层商业模式）：
 * - key 以 **sha256 哈希**存储并索引，明文只在配置里出现一次，进程内不保留明文映射。
 * - 分层策略（free/standard/pro）决定降损层开关、rpm、并发、额度、计费模式。
 * - 限流/额度检查失败一律 fail-open（除"确实超限"这一确定性结论外），
 *   即：存储故障不能让整个网关拒绝服务。
 */

import type { ClientIdentity, ClientKeyConfig, RelayConfig, TierId, TierPolicy } from '../core/types.js';
import type { Store } from '../store/index.js';
import { ConcurrencyLimiter } from '../upstream/pool.js';
import { randomBytes } from 'node:crypto';
import { ownLookup, sha256Hex, monotonicMs, shortId } from '../util/index.js';
import { Logger } from '../core/logger.js';

export type AuthFailure =
  | { code: 'missing_key'; message: string }
  | { code: 'invalid_key'; message: string }
  | { code: 'expired_key'; message: string }
  | { code: 'key_disabled'; message: string }
  | { code: 'model_not_allowed'; message: string; allowed: string[] }
  /**
   * 模型名**根本不存在**（不是"存在但没开通"）。必须与 model_not_allowed 分开：
   * 前者是拼错/写错，动作是"改模型名"；后者是没买，动作是"去开通"。
   * 混在一起会把人引向完全错误的方向 —— 实测有人把 agnes 写成 agens，
   * 网关却告诉他"你的 key 未开通模型 agens"。
   */
  | { code: 'model_not_found'; message: string; allowed: string[]; suggestion?: string }
  | { code: 'rate_limited'; message: string; retryAfterMs: number; limit: number }
  | { code: 'quota_exhausted'; message: string; limit: number; used: number }
  | { code: 'too_many_concurrent'; message: string; limit: number }
  | { code: 'internal'; message: string };

export interface AuthOk {
  ok: true;
  identity: ClientIdentity;
  policy: TierPolicy;
  /** 释放并发额度 */
  release: () => void;
  /** 鉴权与限流耗时（微秒） */
  durationUs: number;
}

export interface AuthErr {
  ok: false;
  error: AuthFailure;
  /** 归属（用于度量与错误归因，即使鉴权失败也要记账） */
  identity?: Partial<ClientIdentity>;
  durationUs: number;
}

export type AuthOutcome = AuthOk | AuthErr;

interface KeyRecord {
  id: string;
  label: string;
  hash: string;
  tier: TierId;
  tenantId: string;
  enabled: boolean;
  allowedModels?: string[];
  expiresAt?: number;
  quotaOverride?: number;
  /** 按钱计的额度（人民币元） */
  quotaCnyOverride?: number;
  origin: 'config' | 'panel';
  createdAt: number;
}

const QUOTA_PERIOD_MS = 30 * 86_400_000;

export interface KeyRegistryOptions {
  config: RelayConfig;
  store: Store;
  logger: Logger;
  /** 额外注入的 key（管理接口动态创建） */
  dynamicKeys?: ClientKeyConfig[];
  /**
   * 从持久层恢复面板创建的 key。
   * 注意：只能恢复**哈希**，无法恢复明文——这是刻意的（数据库泄露不等于 key 泄露）。
   * 因此面板创建的 key 只在创建那一刻显示一次。
   */
  restoredKeys?: {
    keyId: string;
    label: string;
    tier: TierId;
    tenantId: string;
    enabled: boolean;
    keyHash: string;
    allowedModels?: string[];
    expiresAt?: number;
    quotaOverride?: number;
    costQuotaOverride?: number;
  }[];
}

export interface CreatedKey {
  /** 明文 key，**只在此刻返回一次**，之后系统里只有哈希 */
  secret: string;
  record: KeyView;
}

/**
 * 一次被拒的鉴权尝试。
 *
 * 只留 **指纹**（明文 key 的 sha256 前缀，与 KeyView.hashPrefix 同一口径），永不留明文。
 * 存在的理由：客户端拿错 key 时，网关原本只有一句"无效的 relay key"——日志没有、看板没有、
 * 指纹没有，用户只能看到"API 全 401"，第一反应是"服务挂了"。有了指纹就能一眼对上是哪个 key。
 */
export interface AuthRejectRecord {
  at: number;
  code: AuthFailure['code'];
  /** 明文 key 的 sha256 前缀（8 位十六进制）；缺 key 时为空串 */
  fingerprint: string;
  keyLength: number;
  /** Authorization 头的形态：少了 `Bearer ` 也能看出来 */
  headerForm: 'bearer' | 'bare' | 'none';
  path: string;
}

/** 被拒指纹的聚合视图：同一个错 key 刷了 200 次也只占一行 */
export interface AuthRejectGroup {
  code: AuthFailure['code'];
  fingerprint: string;
  count: number;
  firstAt: number;
  lastAt: number;
  keyLength: number;
  headerForm: AuthRejectRecord['headerForm'];
  /** 指纹是否命中某个已签发的 key（命中=key 存在但被禁用/过期；不命中=key 根本不是这里签的） */
  matchesIssuedKey: boolean;
}

/** 面板展示用的 key 视图（绝不含明文） */
export interface KeyView {
  id: string;
  label: string;
  tier: TierId;
  tenantId: string;
  enabled: boolean;
  allowedModels?: string[];
  expiresAt?: number;
  quotaOverride?: number;
  /** 按钱计的额度（人民币元）；与 token 额度是两种口径，各自独立判断 */
  quotaCnyOverride?: number;
  origin: 'config' | 'panel';
  createdAt: number;
  /** 明文 key 的 sha256 前缀，用于人工核对"这个 key 是不是我手上那个" */
  hashPrefix: string;
}

export class KeyRegistry {
  private readonly byHash = new Map<string, KeyRecord>();
  private readonly limiters = new Map<string, ConcurrencyLimiter>();
  private readonly dynamic = new Map<string, KeyRecord>();
  private readonly config: RelayConfig;
  private readonly store: Store;
  private readonly logger: Logger;
  /** 被拒鉴权的环形台账（只留指纹），用于面板自证"到底是谁的 key 不对" */
  private readonly rejects: AuthRejectRecord[] = [];
  private readonly rejectCounts = new Map<string, { count: number; firstAt: number; lastAt: number; keyLength: number; headerForm: AuthRejectRecord['headerForm'] }>();
  private rejectTotal = 0;
  private static readonly REJECT_RING = 200;

  constructor(opts: KeyRegistryOptions) {
    this.config = opts.config;
    this.store = opts.store;
    this.logger = opts.logger;
    for (const c of opts.config.clients) this.register(c);
    // 从库里恢复面板创建的 key（只有哈希，明文不可恢复）
    for (const r of opts.restoredKeys ?? []) {
      const rec: KeyRecord = {
        id: r.keyId,
        label: r.label,
        hash: r.keyHash,
        tier: r.tier,
        tenantId: r.tenantId,
        enabled: r.enabled,
        origin: 'panel',
        createdAt: Date.now(),
        ...(r.allowedModels && r.allowedModels.length > 0 ? { allowedModels: r.allowedModels } : {}),
        ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
        ...(r.quotaOverride !== undefined ? { quotaOverride: r.quotaOverride } : {}),
        ...(r.costQuotaOverride !== undefined ? { quotaCnyOverride: r.costQuotaOverride } : {}),
      };
      if (!rec.hash) continue;
      this.byHash.set(rec.hash, rec);
      this.dynamic.set(rec.id, rec);
      this.limiters.set(rec.id, new ConcurrencyLimiter(this.config.tiers[rec.tier]?.maxConcurrency ?? 32));
    }
    for (const c of opts.dynamicKeys ?? []) this.register(c, true);
  }

  /** 注册/更新一个 key（配置装载或管理接口调用），并写入持久层 */
  register(config: ClientKeyConfig, isDynamic = false): void {
    const hash = hashKey(config.key);
    const rec: KeyRecord = {
      id: config.id,
      label: config.label,
      hash,
      tier: config.tier,
      tenantId: config.tenantId,
      enabled: config.enabled,
      origin: isDynamic ? 'panel' : 'config',
      createdAt: Date.now(),
      ...(config.allowedModels && config.allowedModels.length > 0 ? { allowedModels: config.allowedModels } : {}),
      ...(config.expiresAt !== undefined ? { expiresAt: config.expiresAt } : {}),
      ...(config.quotaOverride !== undefined ? { quotaOverride: config.quotaOverride } : {}),
      ...(config.quotaCny !== undefined ? { quotaCnyOverride: config.quotaCny } : {}),
    };
    this.byHash.set(rec.hash, rec);
    if (isDynamic) this.dynamic.set(rec.id, rec);
    const policy = this.config.tiers[rec.tier];
    this.limiters.set(rec.id, new ConcurrencyLimiter(policy?.maxConcurrency ?? 32));
    this.persistMeta(rec);
  }

  private persistMeta(rec: KeyRecord): void {
    try {
      const store = this.store as unknown as {
        upsertKeyMeta?: (m: Record<string, unknown>) => void;
      };
      store.upsertKeyMeta?.({
        keyId: rec.id,
        label: rec.label,
        tier: rec.tier,
        tenantId: rec.tenantId,
        enabled: rec.enabled,
        ...(rec.allowedModels ? { allowedModels: rec.allowedModels } : {}),
        ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
        ...(rec.quotaOverride !== undefined ? { quotaOverride: rec.quotaOverride } : {}),
        ...(rec.quotaCnyOverride !== undefined ? { costQuotaOverride: rec.quotaCnyOverride } : {}),
        keyHash: rec.hash,
        origin: rec.origin,
      });
    } catch {
      // fail-open：元数据落库失败不影响鉴权
    }
  }

  remove(keyId: string): boolean {
    const rec = this.dynamic.get(keyId);
    if (!rec) return false;
    this.byHash.delete(rec.hash);
    this.dynamic.delete(keyId);
    this.limiters.delete(keyId);
    return true;
  }

  listKeys(): KeyView[] {
    const out: KeyView[] = [];
    const seen = new Set<string>();
    // byHash ∪ dynamic 并集（manual#392·签字授权）：revoke 只摘 byHash（鉴权索引），
    // dynamic 里的管理记录必须在管理面可见——只走 byHash 会让已撤销 key 从列表消失，
    // 连带 keys/delete 的前查 404（#365/#392 实证：删除/重启用都够不着）。
    const all = [...this.byHash.values(), ...this.dynamic.values()];
    for (const rec of all) {
      if (seen.has(rec.id)) continue;
      seen.add(rec.id);
      out.push(this.toView(rec));
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  private toView(rec: KeyRecord): KeyView {
    return {
      id: rec.id,
      label: rec.label,
      tier: rec.tier,
      tenantId: rec.tenantId,
      enabled: rec.enabled,
      ...(rec.allowedModels ? { allowedModels: rec.allowedModels } : {}),
      ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
      ...(rec.quotaOverride !== undefined ? { quotaOverride: rec.quotaOverride } : {}),
      ...(rec.quotaCnyOverride !== undefined ? { quotaCnyOverride: rec.quotaCnyOverride } : {}),
      origin: rec.origin,
      createdAt: rec.createdAt,
      hashPrefix: rec.hash.slice(0, 8),
    };
  }

  /** 面板创建 key：明文只返回一次，库里只有哈希 */
  create(input: {
    label?: string;
    tier: TierId;
    tenantId: string;
    allowedModels?: string[];
    expiresAt?: number;
    quotaOverride?: number;
    /** 按钱计的额度（人民币元） */
    quotaCny?: number;
    /** 允许调用方自带 key（例如用户想沿用自己已有的字符串） */
    secret?: string;
    /** 谁做的这次操作（IP/UA）。审计用：key 被轮换后必须查得出是谁干的 */
    actor?: string;
  }): CreatedKey {
    const policy = this.config.tiers[input.tier];
    if (!policy) throw new Error(`未知分层: ${input.tier}`);
    const secret = input.secret && input.secret.length >= 8 ? input.secret : generateKey();
    const hash = hashKey(secret);
    if (this.byHash.has(hash)) throw new Error('该 key 已存在（哈希冲突或重复创建）');
    // label 唯一性约束（Q003/F1/SEC-006 修复）：在 create() 内部加约束，防止 TOCTOU 竞态。
    // Node.js 单线程模型下，同步 check-then-create 是原子的，但加此检查作为 defense in depth。
    const trimmedLabel = input.label?.trim();
    if (trimmedLabel) {
      const all = [...this.byHash.values(), ...this.dynamic.values()];
      if (all.some((r) => r.label === trimmedLabel)) {
        throw new Error(`label "${trimmedLabel}" 已存在`);
      }
    }

    let id = `k_${shortId(8)}`;
    while ([...this.byHash.values()].some((r) => r.id === id)) id = `k_${shortId(8)}`;

    const rec: KeyRecord = {
      id,
      label: input.label?.trim() || `未命名 key（${input.tier}）`,
      hash,
      tier: input.tier,
      tenantId: input.tenantId || 'default',
      enabled: true,
      origin: 'panel',
      createdAt: Date.now(),
      ...(input.allowedModels && input.allowedModels.length > 0 ? { allowedModels: input.allowedModels } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.quotaOverride !== undefined ? { quotaOverride: input.quotaOverride } : {}),
      ...(input.quotaCny !== undefined ? { quotaCnyOverride: input.quotaCny } : {}),
    };
    this.byHash.set(hash, rec);
    this.dynamic.set(id, rec);
    this.limiters.set(id, new ConcurrencyLimiter(policy.maxConcurrency ?? 32));
    this.persistMeta(rec);
    this.store.logEvent('warn', 'key.create', { keyId: id, tier: rec.tier, tenantId: rec.tenantId, label: rec.label, ...(input.actor ? { actor: input.actor } : {}) });
    this.logger.info('admin.key_create', { keyId: id, tier: rec.tier });
    return { secret, record: this.toView(rec) };
  }

  /** 修改元数据（不含明文 key；换 key 请用 rotate） */
  update(
    keyId: string,
    patch: {
      label?: string;
      tier?: TierId;
      enabled?: boolean;
      allowedModels?: string[] | null;
      expiresAt?: number | null;
      quotaOverride?: number | null;
      quotaCny?: number | null;
    },
    actor?: string,
  ): KeyView {
    const rec = this.findRecord(keyId);
    if (!rec) throw new Error(`key 不存在: ${keyId}`);
    if (patch.tier !== undefined) {
      const policy = this.config.tiers[patch.tier];
      if (!policy) throw new Error(`未知分层: ${patch.tier}`);
      rec.tier = patch.tier;
      this.limiters.get(rec.id)?.setLimit(policy.maxConcurrency ?? 32);
    }
    if (patch.label !== undefined) rec.label = patch.label.trim() || rec.label;
    if (patch.enabled !== undefined) rec.enabled = patch.enabled;
    // 重启用补回鉴权索引（manual#392）：revoke 摘了 byHash，只置 enabled=true 的话
    // auth 仍查不到 this.byHash——『重新启用』必须同时让 key 恢复可用（#392 实证：
    // #365 修复只治好一半，update 成功但 auth 仍 401）。origin=config 的记录本就在
    // byHash，此重植是幂等的。
    if (rec.enabled && this.byHash.get(rec.hash) !== rec) {
      this.byHash.set(rec.hash, rec);
    }
    if (patch.allowedModels !== undefined) {
      if (patch.allowedModels === null || patch.allowedModels.length === 0) delete rec.allowedModels;
      else rec.allowedModels = patch.allowedModels;
    }
    if (patch.expiresAt !== undefined) {
      if (patch.expiresAt === null) delete rec.expiresAt;
      else rec.expiresAt = patch.expiresAt;
    }
    if (patch.quotaOverride !== undefined) {
      if (patch.quotaOverride === null) delete rec.quotaOverride;
      else rec.quotaOverride = patch.quotaOverride;
    }
    if (patch.quotaCny !== undefined) {
      if (patch.quotaCny === null) delete rec.quotaCnyOverride;
      else rec.quotaCnyOverride = patch.quotaCny;
    }
    this.persistMeta(rec);
    this.store.logEvent('warn', 'key.update', { keyId, patch: { ...patch }, ...(actor ? { actor } : {}) });
    this.logger.info('admin.key_update', { keyId, patch: { ...patch } });
    return this.toView(rec);
  }

  /** 吊销：软删除（保留历史度量，只让 key 失效） */
  revoke(keyId: string, actor?: string): KeyView {
    const rec = this.findRecord(keyId);
    if (!rec) throw new Error(`key 不存在: ${keyId}`);
    rec.enabled = false;
    this.persistMeta(rec);
    // 面板创建的 key 从**鉴权索引**摘掉（byHash）即 auth 失效；dynamic 里的管理记录
    // 保留（manual#392·签字授权，#365 根因修复）：摘 dynamic 会让管理面在重启前认不得
    // 这把 key（列表消失/无法重启用/无法删除），与重启后 restore 的停用态语义割裂。
    if (rec.origin === 'panel') {
      this.byHash.delete(rec.hash);
    }
    this.store.logEvent('warn', 'key.revoke', { keyId, origin: rec.origin, label: rec.label, ...(actor ? { actor } : {}) });
    this.logger.warn('admin.key_revoke', { keyId, origin: rec.origin });
    return this.toView(rec);
  }

  /** 轮换：生成新 key 替换旧的（旧 key 立即失效），返回新的明文 */
  rotate(keyId: string, actor?: string): CreatedKey {
    const rec = this.findRecord(keyId);
    if (!rec) throw new Error(`key 不存在: ${keyId}`);
    const secret = generateKey();
    const hash = hashKey(secret);
    this.byHash.delete(rec.hash);
    rec.hash = hash;
    rec.enabled = true;
    this.byHash.set(hash, rec);
    this.persistMeta(rec);
    this.store.logEvent('warn', 'key.rotate', { keyId, label: rec.label, ...(actor ? { actor } : {}) });
    this.logger.warn('admin.key_rotate', { keyId });
    return { secret, record: this.toView(rec) };
  }

  /** 额度重置：不影响历史度量，只把本周期已用量清零 */
  resetQuota(keyId: string): { keyId: string; before: number; quota: number | null } {
    const rec = this.findRecord(keyId);
    if (!rec) throw new Error(`key 不存在: ${keyId}`);
    const before = this.usageForKey(keyId).tokens;
    this.store.logEvent('warn', 'quota.reset', { keyId, before, at: Date.now() });
    this.logger.warn('admin.quota_reset', { keyId, before });
    return { keyId, before, quota: this.quotaFor(rec) };
  }

  private findRecord(keyId: string): KeyRecord | undefined {
    for (const rec of this.byHash.values()) if (rec.id === keyId) return rec;
    // dynamic 兜底（manual#392·签字授权）：revoke 对 panel key 摘 byHash 后记录只剩
    // dynamic 一份——只搜 byHash 会让已撤销 key 在管理面全 404（#365 实证：列表消失/
    // 无法重启用/无法删除，直到重启才以停用态复活）。remove() 本就按 dynamic 取记录，
    // 这里把 findRecord 对齐成同一地图口径。
    const dyn = this.dynamic.get(keyId);
    return dyn;
  }

  private quotaFor(rec: KeyRecord): number | null {
    return rec.quotaOverride ?? this.config.tiers[rec.tier]?.periodQuotaTokens ?? null;
  }

  /**
   * 本网关"认识"的全部模型名：各上游声明的 + 阶梯名 + 别名（含别名指向的真名）。
   * 用来把"模型名写错了"和"模型存在但没开通"分开。
   */
  private knownModels(): Set<string> {
    const out = new Set<string>();
    for (const p of this.config.providers) for (const m of p.models ?? []) out.add(m);
    for (const [name, steps] of Object.entries(this.config.modelLadders ?? {})) {
      out.add(name);
      for (const st of steps) out.add(st);
    }
    for (const [alias, target] of Object.entries(this.config.modelAliases ?? {})) {
      out.add(alias);
      out.add(target);
    }
    return out;
  }

  /** 按钱计的额度（人民币元）；未设则返回 null（= 不限） */
  private quotaCnyFor(rec: KeyRecord): number | null {
    return rec.quotaCnyOverride ?? this.config.tiers[rec.tier]?.periodQuotaCny ?? null;
  }

  policyFor(tier: TierId): TierPolicy {
    // ownLookup：`this.config.tiers[tier]` 在 tier 为 'constructor'/'toString' 等时会命中
    // Object.prototype 而返回一个函数，下游把它当 TierPolicy 读就整条链路失调。
    // tier 来自 key 配置（运营可控），但一个拼错的档位名不该静默拿到"策略"。
    const policy = ownLookup(this.config.tiers, tier);
    if (policy === undefined) {
      throw new Error(`档位策略未定义：${tier}（tiers 配置里缺少该档位）`);
    }
    return policy;
  }

  /** 主鉴权入口 */
  async authenticate(opts: {
    authorization?: string;
    model?: string;
    signal?: AbortSignal;
    now?: number;
    /** 仅用于台账：让运维知道是哪个端点在被刷 */
    path?: string;
  }): Promise<AuthOutcome> {
    const t0 = monotonicMs();
    const now = opts.now ?? Date.now();
    const duration = (): number => Math.round((monotonicMs() - t0) * 1000);

    try {
      const token = extractBearer(opts.authorization);
      if (!token) {
        const error: AuthFailure = { code: 'missing_key', message: '缺少 Authorization 头。请使用: Authorization: Bearer <你的 relay key>' };
        this.recordReject(error.code, opts.authorization, opts.path);
        return { ok: false, error, durationUs: duration() };
      }
      const rec = this.byHash.get(hashKey(token));
      if (!rec) {
        const fingerprint = fingerprintOf(token);
        const error: AuthFailure = {
          code: 'invalid_key',
          message:
            `无效的 relay key（指纹 ${fingerprint}）。它不是本网关当前签发的 key——` +
            '常见原因有三个：① 还在用旧 key（轮换或删除后立即作废）；' +
            '② **这份配置读的存储里没有这个 key**：面板创建的 key 只落在它当时那份配置的数据库里，' +
            '换一份配置（或换一个 storage.path）启动，同一台机器上也会认不出它；' +
            '③ 把上游厂商的 key 当成了 relay key。' +
            '到 /admin →「客户 Key」页可以核对已签发 key 的指纹，或直接粘贴你手上的 key 做自检。',
        };
        this.recordReject(error.code, opts.authorization, opts.path);
        return { ok: false, error, durationUs: duration() };
      }
      const policy = this.config.tiers[rec.tier];
      const identity: ClientIdentity = { keyId: rec.id, keyLabel: rec.label, tier: rec.tier, tenantId: rec.tenantId };

      if (!rec.enabled) {
        const error: AuthFailure = { code: 'key_disabled', message: `key ${rec.label}（${rec.id}）已被禁用；如果这是你正在用的 key，请让运维在 /admin 里重新启用` };
        this.recordReject(error.code, opts.authorization, opts.path);
        return { ok: false, error, identity, durationUs: duration() };
      }
      if (rec.expiresAt !== undefined && now > rec.expiresAt) {
        const error: AuthFailure = {
          code: 'expired_key',
          message: `key ${rec.label}（${rec.id}）已于 ${new Date(rec.expiresAt).toISOString()} 过期，请换一个新 key`,
        };
        this.recordReject(error.code, opts.authorization, opts.path);
        return { ok: false, error, identity, durationUs: duration() };
      }
      if (!policy) {
        return { ok: false, error: { code: 'internal', message: `key ${rec.id} 引用了未定义的分层 ${rec.tier}` }, identity, durationUs: duration() };
      }
      if (opts.model && rec.allowedModels && rec.allowedModels.length > 0 && !rec.allowedModels.includes(opts.model)) {
        const allowed = rec.allowedModels;
        // 先分清"这个模型名在本网关里存不存在"：不存在就是改名字的事，不是开通的事。
        const known = this.knownModels();
        if (!known.has(opts.model)) {
          const near = nearestModel(opts.model, [...allowed]);
          return {
            ok: false,
            error: {
              code: 'model_not_found',
              message:
                `模型 ${opts.model} 不在本网关的模型清单里。` +
                (near ? `是不是想写 ${near}？` : '') +
                ` 你这把 key（${policy.label}）可用的模型：${allowed.join(' / ')}`,
              allowed,
              ...(near ? { suggestion: near } : {}),
            },
            identity,
            durationUs: duration(),
          };
        }
        return {
          ok: false,
          error: {
            code: 'model_not_allowed',
            message: `当前 key（${policy.label}）未开通模型 ${opts.model}（该模型存在，但这把 key 的白名单里没有它；可用的：${allowed.join(' / ')}）`,
            allowed,
          },
          identity,
          durationUs: duration(),
        };
      }

      /* ---------- 限流（固定窗口，无状态取向） ---------- */
      if (policy.rpm !== null && policy.rpm > 0) {
        const windowStart = Math.floor(now / 60_000) * 60_000;
        const count = this.store.incrRate(rec.id, windowStart);
        if (count > policy.rpm) {
          const retryAfterMs = windowStart + 60_000 - now;
          return {
            ok: false,
            error: {
              code: 'rate_limited',
              message: `超过本层速率上限 ${policy.rpm} RPM，请退避 ${Math.ceil(retryAfterMs / 1000)} 秒后重试`,
              retryAfterMs,
              limit: policy.rpm,
            },
            identity,
            durationUs: duration(),
          };
        }
      }

      /* ---------- 额度（按 30 天滑动周期，从度量库读取） ----------
       * 两种口径各自独立判断，任一超了都拒：
       *   · token 额度 —— 适合"给多少量"
       *   · 按钱的额度（quotaCny）—— 适合"给多少预算"，因为它对输入/输出比例不敏感。
       * 钱必须按钱算：¥3/M 输入、¥6/M 输出，同样 ¥10 折成 token 数取决于两者比例，
       * 用 token 额度冒充只能猜，客户对不上账。
       */
      const quota = rec.quotaOverride ?? policy.periodQuotaTokens;
      const quotaCny = rec.quotaCnyOverride ?? policy.periodQuotaCny ?? null;
      if ((quota !== null && quota !== undefined) || (quotaCny !== null && quotaCny > 0)) {
        // 周期起点考虑"额度重置"：运营重置后用户应立刻恢复可用
        const resetAt = this.store.lastQuotaResetAt(rec.id);
        const used = this.store.quotaSnapshot(rec.id, Math.max(now - QUOTA_PERIOD_MS, resetAt));
        if (quota !== null && quota !== undefined && used.tokens >= quota) {
          return {
            ok: false,
            error: {
              code: 'quota_exhausted',
              message: `本周期额度已用尽（${used.tokens}/${quota} token）。升级到更高层或等待下个周期重置`,
              limit: quota,
              used: used.tokens,
            },
            identity,
            durationUs: duration(),
          };
        }
        if (quotaCny !== null && quotaCny > 0 && used.costCny >= quotaCny) {
          return {
            ok: false,
            error: {
              code: 'quota_exhausted',
              message:
                `本周期预算已用尽（${fmtCny(used.costCny)} / ${fmtCny(quotaCny)}）。` +
                '充值或提额后可在管理面板「重置额度」立刻恢复，不必等下个周期',
              limit: quotaCny,
              used: used.costCny,
            },
            identity,
            durationUs: duration(),
          };
        }
      }

      /* ---------- 并发闸门 ---------- */
      const limiter = this.limiters.get(rec.id) ?? new ConcurrencyLimiter(policy.maxConcurrency ?? 32);
      this.limiters.set(rec.id, limiter);
      if (policy.maxConcurrency !== null && policy.maxConcurrency > 0 && limiter.active >= policy.maxConcurrency) {
        return {
          ok: false,
          error: {
            code: 'too_many_concurrent',
            message: `并发数超过本层上限 ${policy.maxConcurrency}，请降低并发或等待在途请求完成`,
            limit: policy.maxConcurrency,
          },
          identity,
          durationUs: duration(),
        };
      }
      const release = await limiter.acquire(opts.signal);
      return { ok: true, identity, policy, release, durationUs: duration() };
    } catch (err) {
      // fail-open 的边界：鉴权层自身异常必须放行？不行——鉴权是安全边界。
      // 正确做法是：异常时拒绝（fail-closed），但明确归因为 relay_internal_error 并计入度量。
      this.logger.error('auth.internal_error', { error: err instanceof Error ? err.message : String(err) });
      return {
        ok: false,
        error: { code: 'internal', message: '中转站鉴权层内部错误，请稍后重试（已在日志中标记）' },
        durationUs: duration(),
      };
    }
  }

  /** 本周期用量（用于管理看板与升级提示）。周期起点 = 最近一次额度重置，或 30 天前。 */
  usageForKey(
    keyId: string,
    now = Date.now(),
  ): {
    tokens: number;
    costCny: number;
    requests: number;
    quota: number | null;
    quotaCny: number | null;
    windowStart: number;
    quotaUsedPct: number | null;
    quotaCnyUsedPct: number | null;
  } {
    const rec = this.findRecord(keyId);
    const resetAt = this.store.lastQuotaResetAt(keyId);
    const windowStart = Math.max(now - QUOTA_PERIOD_MS, resetAt);
    const snap = this.store.quotaSnapshot(keyId, windowStart);
    const quota = rec ? this.quotaFor(rec) : null;
    const quotaCny = rec ? this.quotaCnyFor(rec) : null;
    return {
      ...snap,
      quota,
      quotaCny,
      windowStart,
      quotaUsedPct: quota && quota > 0 ? Math.min(1, snap.tokens / quota) : null,
      quotaCnyUsedPct: quotaCny && quotaCny > 0 ? Math.min(1, snap.costCny / quotaCny) : null,
    };
  }

  concurrencySnapshot(): { keyId: string; active: number; waiting: number; limit: number }[] {
    return [...this.limiters.entries()].map(([keyId, l]) => ({ keyId, ...l.stats() }));
  }

  /**
   * P2 修复：批量获取所有 key 的 usage（消除 N+1 查询）
   * 一次 DB 查询获取所有 key 的聚合数据，而非逐个查询
   */
  usageForAll(
    keyIds: string[],
    now = Date.now(),
  ): Map<string, {
    tokens: number;
    costCny: number;
    requests: number;
    quota: number | null;
    quotaCny: number | null;
    windowStart: number;
    quotaUsedPct: number | null;
    quotaCnyUsedPct: number | null;
  }> {
    const result = new Map();
    if (keyIds.length === 0) return result;
    // P2-N1 修复：为每个 key 使用各自的 windowStart（与 usageForKey 同口径）
    // v410 修复：重置时间改为**一次批量取回**。此前循环里逐 key 调 lastQuotaResetAt，
    // 每个 key 跑一条 `SELECT ... WHERE kind='quota.reset' ... LIMIT 500` 并把最多 500 行
    // 解析一遍——332 key 实测 72ms/请求，是 /keys 吞吐被锁在 ~46 req/s 的真凶
    // （额度聚合本身只要 7ms）。语义不变，查询次数 N→1。
    const resetMap = this.store.lastQuotaResetForAll(keyIds);
    const windowStarts = new Map<string, number>();
    for (const keyId of keyIds) {
      const resetAt = resetMap.get(keyId) ?? 0;
      windowStarts.set(keyId, Math.max(now - QUOTA_PERIOD_MS, resetAt));
    }
    const snapshots = this.store.quotaSnapshotForAll(keyIds, windowStarts);
    // P2-N2 修复：构建 keyId → record 索引，将 findRecord 降为 O(1)
    const recordMap = new Map<string, { tokens: number; costCny: number; requests: number; quota: number | null; quotaCny: number | null }>();
    for (const rec of this.byHash.values()) {
      recordMap.set(rec.id, { tokens: 0, costCny: 0, requests: 0, quota: this.quotaFor(rec), quotaCny: this.quotaCnyFor(rec) });
    }
    for (const keyId of keyIds) {
      const snap = snapshots.get(keyId) ?? { tokens: 0, costCny: 0, requests: 0 };
      const rec = recordMap.get(keyId);
      const quota = rec?.quota ?? null;
      const quotaCny = rec?.quotaCny ?? null;
      const windowStart = windowStarts.get(keyId) ?? now;
      result.set(keyId, {
        ...snap,
        quota,
        quotaCny,
        windowStart,
        quotaUsedPct: quota && quota > 0 ? Math.min(1, snap.tokens / quota) : null,
        quotaCnyUsedPct: quotaCny && quotaCny > 0 ? Math.min(1, snap.costCny / quotaCny) : null,
      });
    }
    return result;
  }

  /* ---------------- 鉴权失败台账 ---------------- */

  /**
   * 记一次被拒的鉴权尝试。
   * 只保存指纹与头形态；不保存明文，也不因为"记台账"而让鉴权变慢或变成 fail-closed。
   */
  private recordReject(code: AuthFailure['code'], authorization: string | undefined, path: string | undefined): void {
    try {
      const raw = (authorization ?? '').trim();
      const token = extractBearer(authorization);
      const headerForm: AuthRejectRecord['headerForm'] = raw === '' ? 'none' : /^Bearer\s+/i.test(raw) ? 'bearer' : 'bare';
      const rec: AuthRejectRecord = {
        at: Date.now(),
        code,
        fingerprint: token ? fingerprintOf(token) : '',
        keyLength: token?.length ?? 0,
        headerForm,
        path: path ?? '',
      };
      this.rejects.push(rec);
      if (this.rejects.length > KeyRegistry.REJECT_RING) this.rejects.splice(0, this.rejects.length - KeyRegistry.REJECT_RING);
      this.rejectTotal++;

      const ck = `${code}:${rec.fingerprint}`;
      const cur = this.rejectCounts.get(ck);
      if (cur) {
        cur.count++;
        cur.lastAt = rec.at;
      } else {
        this.rejectCounts.set(ck, { count: 1, firstAt: rec.at, lastAt: rec.at, keyLength: rec.keyLength, headerForm });
        // 每种新的错 key 各记一条：这是排查"用户到底拿的哪个 key"的第一现场
        this.logger.warn('auth.rejected', {
          code,
          fingerprint: rec.fingerprint || '(无 key)',
          keyLength: rec.keyLength,
          headerForm,
          path: rec.path,
          hint: '拿这个指纹去 /admin 的「客户 Key」页比对已签发 key 的指纹',
        });
      }
      // 同一种错 key 刷屏时按 100 次折一条日志，避免把日志写爆
      if (!cur && this.rejectTotal % 100 === 0) {
        this.logger.warn('auth.rejected_rollup', { total: this.rejectTotal, distinct: this.rejectCounts.size });
      }
    } catch {
      /* fail-open：台账坏了也不能影响鉴权结论 */
    }
  }

  authRejections(limit = 50): {
    total: number;
    distinct: number;
    byCode: { code: AuthFailure['code']; count: number }[];
    groups: AuthRejectGroup[];
    recent: AuthRejectRecord[];
  } {
    const issued = new Set([...this.byHash.values()].map((r) => r.hash.slice(0, 8)));
    const groups: AuthRejectGroup[] = [...this.rejectCounts.entries()]
      .map(([ck, v]) => {
        const idx = ck.indexOf(':');
        const code = ck.slice(0, idx) as AuthFailure['code'];
        const fp = ck.slice(idx + 1);
        return { code, fingerprint: fp, ...v, matchesIssuedKey: fp !== '' && issued.has(fp) };
      })
      .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
    const byCodeMap = new Map<AuthFailure['code'], number>();
    for (const g of groups) byCodeMap.set(g.code, (byCodeMap.get(g.code) ?? 0) + g.count);
    return {
      total: this.rejectTotal,
      distinct: groups.length,
      byCode: [...byCodeMap.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
      groups,
      recent: this.rejects.slice(-limit).reverse(),
    };
  }

  /**
   * 自检：把"用户手上那个 key"换算成指纹并回答"它是不是这里签发的"。
   * 明文只在这一次调用里出现，不落盘、不进日志、不进台账。
   */
  resolveSecret(secret: string): {
    found: boolean;
    fingerprint: string;
    status: 'ok' | 'key_disabled' | 'expired_key' | 'not_issued';
    key?: KeyView;
  } {
    const fp = fingerprintOf(secret);
    const rec = this.byHash.get(hashKey(secret));
    if (!rec) return { found: false, fingerprint: fp, status: 'not_issued' };
    const expired = rec.expiresAt !== undefined && Date.now() > rec.expiresAt;
    return {
      found: true,
      fingerprint: fp,
      status: !rec.enabled ? 'key_disabled' : expired ? 'expired_key' : 'ok',
      key: this.toView(rec),
    };
  }
}

/**
 * 从候选里挑一个"最像"的模型名，用于拼写建议。
 * 用编辑距离；差距太大（超过名字长度的一半）就不猜，免得给出更误导的建议。
 */
export function nearestModel(input: string, candidates: string[]): string | undefined {
  const dist = (a: string, b: string): number => {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 24) return 99;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n]!;
  };
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    // 除了整名比较，还要比"候选的前缀"：手误常发生在型号族名上
    // （用户写 `agens`，真名是 `agnes-3.0-flash`，整名距离 10 会直接被长度守卫挡掉）。
    const prefix = c.slice(0, Math.max(input.length, 1));
    const score = Math.min(dist(input, c), dist(input, prefix));
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (!best) return undefined;
  const limit = Math.max(2, Math.floor(input.length / 2));
  return bestScore <= limit ? best : undefined;
}

/**
 * 金额格式化：小额预算（如 ¥0.0001）用 toFixed(2) 会被抹成 "¥0.00"，
 * 看起来像"没设额度"。按量级自适应小数位。
 */
export function fmtCny(v: number): string {
  if (!Number.isFinite(v)) return '¥?';
  const abs = Math.abs(v);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return `¥${v.toFixed(digits)}`;
}

/** 生成一个形如 sk-relay-xxxx 的客户端 key（32 字节随机，base64url） */
export function generateKey(prefix = 'sk-relay'): string {
  const bytes = randomBytes(24);
  return `${prefix}-${bytes.toString('base64url')}`;
}

export function hashKey(key: string): string {
  return sha256Hex(`relay-key:${key}`);
}

/**
 * key 指纹 = 哈希前 8 位十六进制（与 KeyView.hashPrefix 完全同口径）。
 * 8 位十六进制对高熵随机 key 不可逆，但足够让"用户手上的 key"和"网关签发的 key"对上号。
 */
export function fingerprintOf(key: string): string {
  return hashKey(key).slice(0, 8);
}

export function extractBearer(header?: string): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (m) return m[1]!.trim();
  // 兼容部分客户端直接把 key 放在 Authorization 里
  if (!header.includes(' ')) return header.trim();
  return undefined;
}

/** 把鉴权失败翻译成给客户端的可执行建议 */
export function authFailureSuggestion(error: AuthFailure): { action: string; retryAfterMs?: number } {
  switch (error.code) {
    case 'rate_limited':
      return { action: 'retry_with_backoff', retryAfterMs: error.retryAfterMs };
    case 'too_many_concurrent':
      return { action: 'retry_with_backoff', retryAfterMs: 500 };
    case 'quota_exhausted':
      return { action: 'top_up_balance' };
    case 'expired_key':
    case 'invalid_key':
    case 'missing_key':
    case 'key_disabled':
      return { action: 'fix_credentials' };
    case 'model_not_allowed':
    case 'model_not_found':
      // 两者的动作都是"换个模型名"，但原因不同（没开通 vs 写错了），
      // 所以文案由 message 说清，动作保持一致。
      return { action: 'switch_model' };
    default:
      return { action: 'retry_same' };
  }
}
