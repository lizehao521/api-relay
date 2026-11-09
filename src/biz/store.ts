/**
 * 扫码次数包业务库：订单与核销码。
 *
 * 与度量库（relay.db）分开一个文件，理由是写入节奏完全不同：
 * meter 每个请求都写，业务库只在「下单 / 支付 / 每成功一次调用」时写。
 * 放同一个 SQLite 文件会和 meter 的批量落盘抢锁，而业务库根本不需要那份吞吐。
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BusinessConfig, RelayConfig } from '../core/types.js';

export type OrderStatus = 'pending' | 'paid' | 'cancelled';

/**
 * AI 按量付费订单状态：
 *   pending → paid（verify 通过）→ processing（已领租约，正在调模型）→ consumed
 * 调用失败时 processing 退回 paid，允许用同一张支付凭证重试；崩溃留下的
 * processing 在租约过期后可被重新领取。
 */
export type MachinePayStatus = 'pending' | 'paid' | 'processing' | 'consumed';

export interface BizMachinePayOrder {
  /** 商户订单号（我们生成，支付宝预下单与 verify 对账都用它） */
  outTradeNo: string;
  serviceId: string;
  amountCny: number;
  goodsName: string;
  status: MachinePayStatus;
  amtPrePayId?: string;
  /** 支付宝交易号；全表唯一，同一笔钱只能履约一次 */
  tradeNo?: string;
  resourceId?: string;
  createdAt: number;
  payBeforeAt: number;
  paidAt?: number;
  startedAt?: number;
  consumedAt?: number;
}

/**
 * 商家账号。令牌只存 SHA-256，明文只在创建/轮换时返回一次。
 * 管理员之外的商家只能看到 merchant_id 等于自己的订单与核销码。
 */
export interface BizMerchant {
  id: string;
  name: string;
  tokenHash: string;
  note?: string;
  createdAt: number;
  disabledAt?: number;
}

export interface BizOrder {
  id: string;
  /** 缺省 = 管理员自营/历史订单，商家账号看不到 */
  merchantId?: string;
  merchantName: string;
  packId: string;
  packName: string;
  quantity: number;
  unitPriceCny: number;
  amountCny: number;
  /** 下单时的套餐快照：之后改配置不能影响已售出的包 */
  usesTotal: number;
  validDays: number;
  models: string[];
  status: OrderStatus;
  provider: 'mock' | 'alipay';
  providerTradeNo?: string;
  createdAt: number;
  paidAt?: number;
}

export interface BizCode {
  code: string;
  orderId: string;
  packId: string;
  merchantName: string;
  usesTotal: number;
  usesUsed: number;
  keyId: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  firstSeenAt?: number;
}

/**
 * 外卖单码：把已有核销码绑定到一张平台外卖单上。
 * 同一个商家（'' = 管理员自营）的同一个外部单号只能绑一个码；一个码也只能绑一次。
 * 重复录入同一单号返回原绑定，不再消耗池子里的码。
 */
export interface BizSlip {
  code: string;
  /** 归属商家；'' = 管理员自营订单 */
  merchantId: string;
  externalNo: string;
  orderId: string;
  createdAt: number;
}

export interface BizSummary {
  orderCount: number;
  paidOrderCount: number;
  revenueCny: number;
  codeCount: number;
  activeCodeCount: number;
  usesSold: number;
  usesUsed: number;
}

export interface BizStore {
  init(): Promise<void>;
  close(): Promise<void>;

  createMerchant(m: BizMerchant): void;
  getMerchant(id: string): BizMerchant | undefined;
  findMerchantByTokenHash(hash: string): BizMerchant | undefined;
  listMerchants(): BizMerchant[];
  rotateMerchantToken(id: string, tokenHash: string): boolean;
  disableMerchant(id: string, at: number): boolean;
  enableMerchant(id: string): boolean;

  createOrder(order: BizOrder): void;
  getOrder(id: string): BizOrder | undefined;
  /** merchantId 缺省 = 管理员视角（全部订单） */
  listOrders(limit: number, merchantId?: string): BizOrder[];
  /** 只有 pending → paid 是有效迁移；重复通知返回 false */
  markPaid(id: string, providerTradeNo: string, paidAt: number): boolean;

  createCodes(codes: BizCode[]): void;
  getCode(code: string): BizCode | undefined;
  listCodesByOrder(orderId: string): BizCode[];
  listCodes(limit: number): BizCode[];
  revokeCode(code: string, at: number): boolean;
  /** 成功调用 +1；返回 false 表示码不存在 */
  incrementUsed(code: string): boolean;
  markSeen(code: string, at: number): void;
  /** 首次扫码懒创建 relay key 后回填 keyId */
  setKeyId(code: string, keyId: string): void;
  /** merchantId 缺省 = 管理员视角（全部） */
  summary(now: number, merchantId?: string): BizSummary;

  /** 绑定外部单号；返回 false = 该单号已绑或该码已被占用 */
  bindSlip(slip: BizSlip): boolean;
  getSlip(merchantId: string, externalNo: string): BizSlip | undefined;
  getSlipByCode(code: string): BizSlip | undefined;
  listSlips(merchantId: string, limit: number): BizSlip[];
  /** 最早的一个未绑定、未撤销、未过期、还有剩余次数的码 */
  findBindableCode(merchantId: string, now: number): BizCode | undefined;
  countBindableCodes(merchantId: string, now: number): number;

  createMachineOrder(o: BizMachinePayOrder): void;
  getMachineOrder(outTradeNo: string): BizMachinePayOrder | undefined;
  /** 复用同一服务、同一价格的未过期 pending 单，避免调用方反复 402 时刷单 */
  findOpenMachineOrder(serviceId: string, amountCny: number, now: number): BizMachinePayOrder | undefined;
  setMachinePrePayId(outTradeNo: string, amtPrePayId: string): void;
  /** 落账并绑定支付宝交易号；返回 false = 单不存在 / 状态不对 / 该交易号已履约过 */
  markMachinePaid(outTradeNo: string, tradeNo: string, resourceId: string | undefined, at: number): boolean;
  /** 领取执行租约；staleMs 之前的 processing 视为崩溃残留，可重新领取 */
  leaseMachineOrder(outTradeNo: string, at: number, staleMs: number): boolean;
  /** 执行结束：成功 → consumed；失败 → 退回 paid，允许同一凭证重试 */
  finishMachineOrder(outTradeNo: string, ok: boolean, at: number): void;
}

interface Row {
  [key: string]: unknown;
}

function parseModels(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

function merchantFromRow(r: Row): BizMerchant {
  return {
    id: String(r['id']),
    name: String(r['name']),
    tokenHash: String(r['token_hash']),
    ...(r['note'] !== null && r['note'] !== undefined ? { note: String(r['note']) } : {}),
    createdAt: Number(r['created_at']),
    ...(r['disabled_at'] !== null && r['disabled_at'] !== undefined ? { disabledAt: Number(r['disabled_at']) } : {}),
  };
}

function orderFromRow(r: Row): BizOrder {
  return {
    id: String(r['id']),
    ...(r['merchant_id'] !== null && r['merchant_id'] !== undefined ? { merchantId: String(r['merchant_id']) } : {}),
    merchantName: String(r['merchant_name']),
    packId: String(r['pack_id']),
    packName: String(r['pack_name']),
    quantity: Number(r['quantity']),
    unitPriceCny: Number(r['unit_price_cny']),
    amountCny: Number(r['amount_cny']),
    usesTotal: Number(r['uses_total']),
    validDays: Number(r['valid_days']),
    models: parseModels(r['models_json']),
    status: String(r['status']) as OrderStatus,
    provider: String(r['provider']) as 'mock' | 'alipay',
    ...(r['provider_trade_no'] ? { providerTradeNo: String(r['provider_trade_no']) } : {}),
    createdAt: Number(r['created_at']),
    ...(r['paid_at'] !== null && r['paid_at'] !== undefined ? { paidAt: Number(r['paid_at']) } : {}),
  };
}

function slipFromRow(r: Row): BizSlip {
  return {
    code: String(r['code']),
    merchantId: String(r['merchant_id'] ?? ''),
    externalNo: String(r['external_no']),
    orderId: String(r['order_id']),
    createdAt: Number(r['created_at']),
  };
}

function memorySlipKey(merchantId: string, externalNo: string): string {
  return `${merchantId}\u0000${externalNo}`;
}

function machineOrderFromRow(r: Row): BizMachinePayOrder {
  return {
    outTradeNo: String(r['out_trade_no']),
    serviceId: String(r['service_id']),
    amountCny: Number(r['amount_cny']),
    goodsName: String(r['goods_name']),
    status: String(r['status']) as MachinePayStatus,
    ...(r['amt_pre_pay_id'] ? { amtPrePayId: String(r['amt_pre_pay_id']) } : {}),
    ...(r['trade_no'] ? { tradeNo: String(r['trade_no']) } : {}),
    ...(r['resource_id'] ? { resourceId: String(r['resource_id']) } : {}),
    createdAt: Number(r['created_at']),
    payBeforeAt: Number(r['pay_before_at']),
    ...(r['paid_at'] !== null && r['paid_at'] !== undefined ? { paidAt: Number(r['paid_at']) } : {}),
    ...(r['started_at'] !== null && r['started_at'] !== undefined ? { startedAt: Number(r['started_at']) } : {}),
    ...(r['consumed_at'] !== null && r['consumed_at'] !== undefined ? { consumedAt: Number(r['consumed_at']) } : {}),
  };
}

function codeFromRow(r: Row): BizCode {
  return {
    code: String(r['code']),
    orderId: String(r['order_id']),
    packId: String(r['pack_id']),
    merchantName: String(r['merchant_name']),
    usesTotal: Number(r['uses_total']),
    usesUsed: Number(r['uses_used']),
    keyId: String(r['key_id']),
    createdAt: Number(r['created_at']),
    expiresAt: Number(r['expires_at']),
    ...(r['revoked_at'] !== null && r['revoked_at'] !== undefined ? { revokedAt: Number(r['revoked_at']) } : {}),
    ...(r['first_seen_at'] !== null && r['first_seen_at'] !== undefined ? { firstSeenAt: Number(r['first_seen_at']) } : {}),
  };
}

export function resolveBizPath(config: RelayConfig): string {
  const explicit = config.business?.storagePath;
  if (explicit) return explicit;
  if (config.storage.driver === 'memory' || config.storage.path === ':memory:') return ':memory:';
  return join(dirname(config.storage.path), 'biz.db');
}

export function createBizStore(config: RelayConfig, logger: { warn: (event: string, meta?: Record<string, unknown>) => void }): BizStore {
  const path = resolveBizPath(config);
  if (config.storage.driver === 'memory' || path === ':memory:') return new MemoryBizStore();
  return new SqliteBizStore(path, logger);
}

/* ------------------------------------------------------------------ *
 * SQLite
 * ------------------------------------------------------------------ */

interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
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
CREATE TABLE IF NOT EXISTS biz_merchant (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  note TEXT,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_biz_merchant_created ON biz_merchant(created_at);

CREATE TABLE IF NOT EXISTS biz_order (
  id TEXT PRIMARY KEY,
  merchant_id TEXT,
  merchant_name TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  pack_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price_cny REAL NOT NULL,
  amount_cny REAL NOT NULL,
  uses_total INTEGER NOT NULL DEFAULT 0,
  valid_days INTEGER NOT NULL DEFAULT 90,
  models_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_trade_no TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_biz_order_created ON biz_order(created_at);
CREATE INDEX IF NOT EXISTS idx_biz_order_merchant ON biz_order(merchant_id, created_at);

CREATE TABLE IF NOT EXISTS biz_code (
  code TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  merchant_name TEXT NOT NULL,
  uses_total INTEGER NOT NULL,
  uses_used INTEGER NOT NULL DEFAULT 0,
  key_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  first_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_biz_code_order ON biz_code(order_id);
CREATE INDEX IF NOT EXISTS idx_biz_code_created ON biz_code(created_at);

CREATE TABLE IF NOT EXISTS biz_slip (
  code TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  external_no TEXT NOT NULL,
  order_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_biz_slip_external ON biz_slip(merchant_id, external_no);
CREATE INDEX IF NOT EXISTS idx_biz_slip_created ON biz_slip(merchant_id, created_at);

CREATE TABLE IF NOT EXISTS biz_machine_order (
  out_trade_no TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  amount_cny REAL NOT NULL,
  goods_name TEXT NOT NULL,
  status TEXT NOT NULL,
  amt_pre_pay_id TEXT,
  trade_no TEXT,
  resource_id TEXT,
  created_at INTEGER NOT NULL,
  pay_before_at INTEGER NOT NULL,
  paid_at INTEGER,
  started_at INTEGER,
  consumed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_biz_machine_trade ON biz_machine_order(trade_no) WHERE trade_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_biz_machine_status ON biz_machine_order(status, pay_before_at);
`;

export class SqliteBizStore implements BizStore {
  private db: SqliteDatabase | undefined;

  constructor(
    private readonly path: string,
    private readonly logger: { warn: (event: string, meta?: Record<string, unknown>) => void },
  ) {}

  async init(): Promise<void> {
    const mod = (await import('node:sqlite')) as unknown as SqliteModule;
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new mod.DatabaseSync(this.path);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA busy_timeout = 3000;');
    db.exec(SCHEMA);
    // 轻量迁移：早期开发库的 biz_order 还没有套餐快照三列与商家归属列。
    for (const ddl of [
      "ALTER TABLE biz_order ADD COLUMN uses_total INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE biz_order ADD COLUMN valid_days INTEGER NOT NULL DEFAULT 90",
      "ALTER TABLE biz_order ADD COLUMN models_json TEXT NOT NULL DEFAULT '[]'",
      'ALTER TABLE biz_order ADD COLUMN merchant_id TEXT',
    ]) {
      try {
        db.exec(ddl);
      } catch {
        /* 列已存在 */
      }
    }
    this.db = db;
  }

  async close(): Promise<void> {
    try {
      this.db?.close();
    } catch (err) {
      this.logger.warn('biz.store_close_failed', { error: err instanceof Error ? err.message : String(err) });
    }
    this.db = undefined;
  }

  private require(): SqliteDatabase {
    if (!this.db) throw new Error('业务库尚未初始化');
    return this.db;
  }

  createMerchant(m: BizMerchant): void {
    this.require()
      .prepare('INSERT INTO biz_merchant (id, name, token_hash, note, created_at, disabled_at) VALUES (?,?,?,?,?,?)')
      .run(m.id, m.name, m.tokenHash, m.note ?? null, m.createdAt, m.disabledAt ?? null);
  }

  getMerchant(id: string): BizMerchant | undefined {
    const row = this.require().prepare('SELECT * FROM biz_merchant WHERE id = ?').get(id);
    return row ? merchantFromRow(row) : undefined;
  }

  findMerchantByTokenHash(hash: string): BizMerchant | undefined {
    const row = this.require().prepare('SELECT * FROM biz_merchant WHERE token_hash = ?').get(hash);
    return row ? merchantFromRow(row) : undefined;
  }

  listMerchants(): BizMerchant[] {
    return this.require()
      .prepare('SELECT * FROM biz_merchant ORDER BY created_at DESC')
      .all()
      .map(merchantFromRow);
  }

  rotateMerchantToken(id: string, tokenHash: string): boolean {
    const res = this.require().prepare('UPDATE biz_merchant SET token_hash = ? WHERE id = ?').run(tokenHash, id);
    return res.changes > 0;
  }

  disableMerchant(id: string, at: number): boolean {
    const res = this.require()
      .prepare('UPDATE biz_merchant SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL')
      .run(at, id);
    return res.changes > 0;
  }

  enableMerchant(id: string): boolean {
    const res = this.require()
      .prepare('UPDATE biz_merchant SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL')
      .run(id);
    return res.changes > 0;
  }

  createOrder(o: BizOrder): void {
    this.require()
      .prepare(
        `INSERT INTO biz_order (id, merchant_id, merchant_name, pack_id, pack_name, quantity, unit_price_cny, amount_cny, uses_total, valid_days, models_json, status, provider, provider_trade_no, created_at, paid_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        o.id, o.merchantId ?? null, o.merchantName, o.packId, o.packName, o.quantity, o.unitPriceCny, o.amountCny,
        o.usesTotal, o.validDays, JSON.stringify(o.models),
        o.status, o.provider, o.providerTradeNo ?? null, o.createdAt, o.paidAt ?? null,
      );
  }

  getOrder(id: string): BizOrder | undefined {
    const row = this.require().prepare('SELECT * FROM biz_order WHERE id = ?').get(id);
    return row ? orderFromRow(row) : undefined;
  }

  listOrders(limit: number, merchantId?: string): BizOrder[] {
    const n = Math.max(1, Math.min(500, limit));
    const rows = merchantId
      ? this.require().prepare('SELECT * FROM biz_order WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?').all(merchantId, n)
      : this.require().prepare('SELECT * FROM biz_order ORDER BY created_at DESC LIMIT ?').all(n);
    return rows.map(orderFromRow);
  }

  markPaid(id: string, providerTradeNo: string, paidAt: number): boolean {
    const res = this.require()
      .prepare("UPDATE biz_order SET status='paid', provider_trade_no=?, paid_at=? WHERE id=? AND status='pending'")
      .run(providerTradeNo, paidAt, id);
    return res.changes > 0;
  }

  createCodes(codes: BizCode[]): void {
    const db = this.require();
    const stmt = db.prepare(
      `INSERT INTO biz_code (code, order_id, pack_id, merchant_name, uses_total, uses_used, key_id, created_at, expires_at, revoked_at, first_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    db.exec('BEGIN');
    try {
      for (const c of codes) {
        stmt.run(c.code, c.orderId, c.packId, c.merchantName, c.usesTotal, c.usesUsed, c.keyId, c.createdAt, c.expiresAt, c.revokedAt ?? null, c.firstSeenAt ?? null);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  getCode(code: string): BizCode | undefined {
    const row = this.require().prepare('SELECT * FROM biz_code WHERE code = ?').get(code);
    return row ? codeFromRow(row) : undefined;
  }

  listCodesByOrder(orderId: string): BizCode[] {
    return this.require()
      .prepare('SELECT * FROM biz_code WHERE order_id = ? ORDER BY created_at ASC')
      .all(orderId)
      .map(codeFromRow);
  }

  listCodes(limit: number): BizCode[] {
    return this.require()
      .prepare('SELECT * FROM biz_code ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(1000, limit)))
      .map(codeFromRow);
  }

  revokeCode(code: string, at: number): boolean {
    const res = this.require()
      .prepare('UPDATE biz_code SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL')
      .run(at, code);
    return res.changes > 0;
  }

  incrementUsed(code: string): boolean {
    const res = this.require().prepare('UPDATE biz_code SET uses_used = uses_used + 1 WHERE code = ?').run(code);
    return res.changes > 0;
  }

  markSeen(code: string, at: number): void {
    this.require().prepare('UPDATE biz_code SET first_seen_at = COALESCE(first_seen_at, ?) WHERE code = ?').run(at, code);
  }

  setKeyId(code: string, keyId: string): void {
    this.require().prepare('UPDATE biz_code SET key_id = ? WHERE code = ?').run(keyId, code);
  }

  summary(now: number, merchantId?: string): BizSummary {
    const db = this.require();
    const o = (merchantId
      ? db.prepare(
          `SELECT COUNT(*) AS n,
                  COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END), 0) AS paidN,
                  COALESCE(SUM(CASE WHEN status='paid' THEN amount_cny ELSE 0 END), 0) AS rev
           FROM biz_order WHERE merchant_id = ?`,
        ).get(merchantId)
      : db.prepare(
          `SELECT COUNT(*) AS n,
                  COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END), 0) AS paidN,
                  COALESCE(SUM(CASE WHEN status='paid' THEN amount_cny ELSE 0 END), 0) AS rev
           FROM biz_order`,
        ).get()) ?? {};
    const c = (merchantId
      ? db.prepare(
          `SELECT COUNT(*) AS n,
                  COALESCE(SUM(c.uses_total), 0) AS sold,
                  COALESCE(SUM(c.uses_used), 0) AS used,
                  COALESCE(SUM(CASE WHEN c.revoked_at IS NULL AND c.expires_at > ? AND c.uses_used < c.uses_total THEN 1 ELSE 0 END), 0) AS active
           FROM biz_code c JOIN biz_order o ON o.id = c.order_id
           WHERE o.merchant_id = ?`,
        ).get(now, merchantId)
      : db.prepare(
          `SELECT COUNT(*) AS n,
                  COALESCE(SUM(uses_total), 0) AS sold,
                  COALESCE(SUM(uses_used), 0) AS used,
                  COALESCE(SUM(CASE WHEN revoked_at IS NULL AND expires_at > ? AND uses_used < uses_total THEN 1 ELSE 0 END), 0) AS active
           FROM biz_code`,
        ).get(now)) ?? {};
    return {
      orderCount: Number(o['n'] ?? 0),
      paidOrderCount: Number(o['paidN'] ?? 0),
      revenueCny: Number(o['rev'] ?? 0),
      codeCount: Number(c['n'] ?? 0),
      activeCodeCount: Number(c['active'] ?? 0),
      usesSold: Number(c['sold'] ?? 0),
      usesUsed: Number(c['used'] ?? 0),
    };
  }

  bindSlip(s: BizSlip): boolean {
    try {
      const res = this.require()
        .prepare('INSERT INTO biz_slip (code, merchant_id, external_no, order_id, created_at) VALUES (?,?,?,?,?)')
        .run(s.code, s.merchantId, s.externalNo, s.orderId, s.createdAt);
      return res.changes > 0;
    } catch {
      // 外部单号或码已被占用
      return false;
    }
  }

  getSlip(merchantId: string, externalNo: string): BizSlip | undefined {
    const row = this.require()
      .prepare('SELECT * FROM biz_slip WHERE merchant_id = ? AND external_no = ?')
      .get(merchantId, externalNo);
    return row ? slipFromRow(row) : undefined;
  }

  getSlipByCode(code: string): BizSlip | undefined {
    const row = this.require().prepare('SELECT * FROM biz_slip WHERE code = ?').get(code);
    return row ? slipFromRow(row) : undefined;
  }

  listSlips(merchantId: string, limit: number): BizSlip[] {
    return this.require()
      .prepare('SELECT * FROM biz_slip WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(merchantId, Math.max(1, Math.min(200, limit)))
      .map(slipFromRow);
  }

  findBindableCode(merchantId: string, now: number): BizCode | undefined {
    const row = this.require()
      .prepare(
        `SELECT c.* FROM biz_code c
         JOIN biz_order o ON o.id = c.order_id
         LEFT JOIN biz_slip s ON s.code = c.code
         WHERE COALESCE(o.merchant_id, '') = ?
           AND c.revoked_at IS NULL AND c.expires_at > ? AND c.uses_used < c.uses_total
           AND s.code IS NULL
         ORDER BY c.created_at ASC LIMIT 1`,
      )
      .get(merchantId, now);
    return row ? codeFromRow(row) : undefined;
  }

  countBindableCodes(merchantId: string, now: number): number {
    const row = this.require()
      .prepare(
        `SELECT COUNT(*) AS n FROM biz_code c
         JOIN biz_order o ON o.id = c.order_id
         LEFT JOIN biz_slip s ON s.code = c.code
         WHERE COALESCE(o.merchant_id, '') = ?
           AND c.revoked_at IS NULL AND c.expires_at > ? AND c.uses_used < c.uses_total
           AND s.code IS NULL`,
      )
      .get(merchantId, now);
    return Number(row?.['n'] ?? 0);
  }

  createMachineOrder(o: BizMachinePayOrder): void {
    this.require()
      .prepare(
        `INSERT INTO biz_machine_order (out_trade_no, service_id, amount_cny, goods_name, status, amt_pre_pay_id, trade_no, resource_id, created_at, pay_before_at, paid_at, started_at, consumed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        o.outTradeNo, o.serviceId, o.amountCny, o.goodsName, o.status, o.amtPrePayId ?? null, o.tradeNo ?? null,
        o.resourceId ?? null, o.createdAt, o.payBeforeAt, o.paidAt ?? null, o.startedAt ?? null, o.consumedAt ?? null,
      );
  }

  getMachineOrder(outTradeNo: string): BizMachinePayOrder | undefined {
    const row = this.require().prepare('SELECT * FROM biz_machine_order WHERE out_trade_no = ?').get(outTradeNo);
    return row ? machineOrderFromRow(row) : undefined;
  }

  findOpenMachineOrder(serviceId: string, amountCny: number, now: number): BizMachinePayOrder | undefined {
    const row = this.require()
      .prepare(
        `SELECT * FROM biz_machine_order
         WHERE service_id = ? AND ABS(amount_cny - ?) < 0.0001 AND status = 'pending' AND pay_before_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(serviceId, amountCny, now);
    return row ? machineOrderFromRow(row) : undefined;
  }

  setMachinePrePayId(outTradeNo: string, amtPrePayId: string): void {
    this.require().prepare('UPDATE biz_machine_order SET amt_pre_pay_id = ? WHERE out_trade_no = ?').run(amtPrePayId, outTradeNo);
  }

  markMachinePaid(outTradeNo: string, tradeNo: string, resourceId: string | undefined, at: number): boolean {
    const db = this.require();
    const existing = this.getMachineOrder(outTradeNo);
    if (existing?.tradeNo === tradeNo && (existing.status === 'paid' || existing.status === 'processing' || existing.status === 'consumed')) {
      return true;
    }
    try {
      const res = db
        .prepare("UPDATE biz_machine_order SET status='paid', trade_no=?, resource_id=?, paid_at=? WHERE out_trade_no=? AND status='pending'")
        .run(tradeNo, resourceId ?? null, at, outTradeNo);
      return res.changes > 0;
    } catch {
      // trade_no 已被另一张单占用：同一笔支付不能履约两次
      return false;
    }
  }

  leaseMachineOrder(outTradeNo: string, at: number, staleMs: number): boolean {
    const res = this.require()
      .prepare(
        `UPDATE biz_machine_order SET status='processing', started_at=?
         WHERE out_trade_no = ?
           AND (status = 'paid' OR (status = 'processing' AND started_at IS NOT NULL AND started_at < ?))`,
      )
      .run(at, outTradeNo, at - staleMs);
    return res.changes > 0;
  }

  finishMachineOrder(outTradeNo: string, ok: boolean, at: number): void {
    if (ok) {
      this.require()
        .prepare("UPDATE biz_machine_order SET status='consumed', consumed_at=? WHERE out_trade_no=? AND status='processing'")
        .run(at, outTradeNo);
    } else {
      this.require()
        .prepare("UPDATE biz_machine_order SET status='paid', started_at=NULL WHERE out_trade_no=? AND status='processing'")
        .run(outTradeNo);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 内存实现（测试 / storage=memory）
 * ------------------------------------------------------------------ */

export class MemoryBizStore implements BizStore {
  private orders = new Map<string, BizOrder>();
  private codes = new Map<string, BizCode>();
  private merchants = new Map<string, BizMerchant>();
  private machineOrders = new Map<string, BizMachinePayOrder>();
  private slips = new Map<string, BizSlip>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  createMerchant(m: BizMerchant): void {
    this.merchants.set(m.id, { ...m });
  }
  getMerchant(id: string): BizMerchant | undefined {
    const m = this.merchants.get(id);
    return m ? { ...m } : undefined;
  }
  findMerchantByTokenHash(hash: string): BizMerchant | undefined {
    for (const m of this.merchants.values()) if (m.tokenHash === hash) return { ...m };
    return undefined;
  }
  listMerchants(): BizMerchant[] {
    return [...this.merchants.values()].sort((a, b) => b.createdAt - a.createdAt).map((m) => ({ ...m }));
  }
  rotateMerchantToken(id: string, tokenHash: string): boolean {
    const m = this.merchants.get(id);
    if (!m) return false;
    m.tokenHash = tokenHash;
    return true;
  }
  disableMerchant(id: string, at: number): boolean {
    const m = this.merchants.get(id);
    if (!m || m.disabledAt !== undefined) return false;
    m.disabledAt = at;
    return true;
  }
  enableMerchant(id: string): boolean {
    const m = this.merchants.get(id);
    if (!m || m.disabledAt === undefined) return false;
    delete m.disabledAt;
    return true;
  }

  createOrder(o: BizOrder): void {
    this.orders.set(o.id, { ...o, models: [...o.models] });
  }
  getOrder(id: string): BizOrder | undefined {
    const o = this.orders.get(id);
    return o ? { ...o, models: [...o.models] } : undefined;
  }
  listOrders(limit: number, merchantId?: string): BizOrder[] {
    return [...this.orders.values()]
      .filter((o) => merchantId === undefined || o.merchantId === merchantId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((o) => ({ ...o, models: [...o.models] }));
  }
  markPaid(id: string, providerTradeNo: string, paidAt: number): boolean {
    const o = this.orders.get(id);
    if (!o || o.status !== 'pending') return false;
    o.status = 'paid';
    o.providerTradeNo = providerTradeNo;
    o.paidAt = paidAt;
    return true;
  }
  createCodes(codes: BizCode[]): void {
    for (const c of codes) this.codes.set(c.code, { ...c });
  }
  getCode(code: string): BizCode | undefined {
    const c = this.codes.get(code);
    return c ? { ...c } : undefined;
  }
  listCodesByOrder(orderId: string): BizCode[] {
    return [...this.codes.values()].filter((c) => c.orderId === orderId).sort((a, b) => a.createdAt - b.createdAt).map((c) => ({ ...c }));
  }
  listCodes(limit: number): BizCode[] {
    return [...this.codes.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map((c) => ({ ...c }));
  }
  revokeCode(code: string, at: number): boolean {
    const c = this.codes.get(code);
    if (!c || c.revokedAt !== undefined) return false;
    c.revokedAt = at;
    return true;
  }
  incrementUsed(code: string): boolean {
    const c = this.codes.get(code);
    if (!c) return false;
    c.usesUsed += 1;
    return true;
  }
  markSeen(code: string, at: number): void {
    const c = this.codes.get(code);
    if (c && c.firstSeenAt === undefined) c.firstSeenAt = at;
  }
  setKeyId(code: string, keyId: string): void {
    const c = this.codes.get(code);
    if (c) c.keyId = keyId;
  }
  summary(now: number, merchantId?: string): BizSummary {
    const orders = [...this.orders.values()].filter((o) => merchantId === undefined || o.merchantId === merchantId);
    const scoped = [...this.codes.values()].filter((c) => {
      if (merchantId === undefined) return true;
      return this.orders.get(c.orderId)?.merchantId === merchantId;
    });
    return {
      orderCount: orders.length,
      paidOrderCount: orders.filter((o) => o.status === 'paid').length,
      revenueCny: orders.reduce((s, o) => s + (o.status === 'paid' ? o.amountCny : 0), 0),
      codeCount: scoped.length,
      activeCodeCount: scoped.filter((c) => c.revokedAt === undefined && c.expiresAt > now && c.usesUsed < c.usesTotal).length,
      usesSold: scoped.reduce((s, c) => s + c.usesTotal, 0),
      usesUsed: scoped.reduce((s, c) => s + c.usesUsed, 0),
    };
  }

  bindSlip(s: BizSlip): boolean {
    if (this.slips.has(memorySlipKey(s.merchantId, s.externalNo))) return false;
    for (const other of this.slips.values()) if (other.code === s.code) return false;
    this.slips.set(memorySlipKey(s.merchantId, s.externalNo), { ...s });
    return true;
  }
  getSlip(merchantId: string, externalNo: string): BizSlip | undefined {
    const s = this.slips.get(memorySlipKey(merchantId, externalNo));
    return s ? { ...s } : undefined;
  }
  getSlipByCode(code: string): BizSlip | undefined {
    for (const s of this.slips.values()) if (s.code === code) return { ...s };
    return undefined;
  }
  listSlips(merchantId: string, limit: number): BizSlip[] {
    return [...this.slips.values()]
      .filter((s) => s.merchantId === merchantId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((s) => ({ ...s }));
  }
  findBindableCode(merchantId: string, now: number): BizCode | undefined {
    const bound = new Set([...this.slips.values()].map((s) => s.code));
    return [...this.codes.values()]
      .filter((c) => {
        if (bound.has(c.code) || c.revokedAt !== undefined) return false;
        if (c.expiresAt <= now || c.usesUsed >= c.usesTotal) return false;
        return (this.orders.get(c.orderId)?.merchantId ?? '') === merchantId;
      })
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => ({ ...c }))[0];
  }
  countBindableCodes(merchantId: string, now: number): number {
    const bound = new Set([...this.slips.values()].map((s) => s.code));
    let n = 0;
    for (const c of this.codes.values()) {
      if (bound.has(c.code) || c.revokedAt !== undefined || c.expiresAt <= now || c.usesUsed >= c.usesTotal) continue;
      if ((this.orders.get(c.orderId)?.merchantId ?? '') === merchantId) n++;
    }
    return n;
  }

  createMachineOrder(o: BizMachinePayOrder): void {
    this.machineOrders.set(o.outTradeNo, { ...o });
  }
  getMachineOrder(outTradeNo: string): BizMachinePayOrder | undefined {
    const o = this.machineOrders.get(outTradeNo);
    return o ? { ...o } : undefined;
  }
  findOpenMachineOrder(serviceId: string, amountCny: number, now: number): BizMachinePayOrder | undefined {
    let found: BizMachinePayOrder | undefined;
    for (const o of this.machineOrders.values()) {
      if (o.serviceId !== serviceId || Math.abs(o.amountCny - amountCny) >= 0.0001) continue;
      if (o.status !== 'pending' || o.payBeforeAt <= now) continue;
      if (!found || o.createdAt > found.createdAt) found = o;
    }
    return found ? { ...found } : undefined;
  }
  setMachinePrePayId(outTradeNo: string, amtPrePayId: string): void {
    const o = this.machineOrders.get(outTradeNo);
    if (o) o.amtPrePayId = amtPrePayId;
  }
  markMachinePaid(outTradeNo: string, tradeNo: string, resourceId: string | undefined, at: number): boolean {
    const o = this.machineOrders.get(outTradeNo);
    if (!o) return false;
    if (o.tradeNo === tradeNo && o.status !== 'pending') return true;
    if (o.status !== 'pending') return false;
    for (const other of this.machineOrders.values()) {
      if (other.outTradeNo !== outTradeNo && other.tradeNo === tradeNo) return false;
    }
    o.status = 'paid';
    o.tradeNo = tradeNo;
    if (resourceId !== undefined) o.resourceId = resourceId;
    o.paidAt = at;
    return true;
  }
  leaseMachineOrder(outTradeNo: string, at: number, staleMs: number): boolean {
    const o = this.machineOrders.get(outTradeNo);
    if (!o) return false;
    const reclaimable = o.status === 'processing' && o.startedAt !== undefined && o.startedAt < at - staleMs;
    if (o.status !== 'paid' && !reclaimable) return false;
    o.status = 'processing';
    o.startedAt = at;
    return true;
  }
  finishMachineOrder(outTradeNo: string, ok: boolean, at: number): void {
    const o = this.machineOrders.get(outTradeNo);
    if (!o || o.status !== 'processing') return;
    if (ok) {
      o.status = 'consumed';
      o.consumedAt = at;
    } else {
      o.status = 'paid';
      delete o.startedAt;
    }
  }
}
