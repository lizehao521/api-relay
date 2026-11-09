/**
 * 扫码次数包业务服务。
 *
 * 定位：挂在网关前面的**业务闸门**，不碰引擎里的鉴权/路由/计费。
 *   - 商家：买包（下单 → 支付 → 出码）、看核销、撤销、打印。
 *   - 顾客：扫码 → 签名 Cookie 会话 → 对话/画图 → 每成功一次扣一次。
 *
 * 两条刻意为之的边界：
 *   1. **relay key 不入库、不出页面**：由 `sk_pk_ + HMAC(种子, code)` 确定性派生，
 *      顾客拿不到；真正的次数闸门在本文件，quotaCny 只是毛利止损的兜底。
 *   2. **失败不计次**：调用前预留名额（used + inflight < total），只有 2xx 且
 *      流没有被中途掐断才 `incrementUsed`；失败回滚预留。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BusinessConfig, MachinePayConfig, PackConfig, RelayConfig } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { Engine } from '../gateway/engine.js';
import type { KeyRegistry } from '../gateway/keys.js';
import type { EngineResult } from '../gateway/protocol.js';
import { shortId, timeSafeEqual } from '../util/index.js';
import { AdminAuth } from '../admin/auth.js';
import { createBizStore, type BizCode, type BizMerchant, type BizOrder, type BizSlip, type BizStore } from './store.js';
import { findPack, packPrice, resolvePacks } from './catalog.js';
import { codeKeyId, generateCode, normalizeCode } from './codes.js';
import { SESSION_COOKIE, SessionSigner, parseCookie, sessionCookie } from './sessions.js';
import { qrSvg } from './qr.js';
import { AlipayProvider, MockPaymentProvider, type PaymentIntent, type PaymentProvider } from './payment.js';
import {
  AlipayMachinePayProvider,
  MockMachinePayProvider,
  formatPayBefore,
  parsePaymentProof,
  type MachinePayProvider,
} from './machinePay.js';
import { consoleHtml, customerHtml, errorPage, labelHtml, payHtml, printHtml } from './pages.js';

/** 执行租约：进程崩溃留下的 processing 超过这个时间可被重新领取 */
const MACHINE_LEASE_MS = 5 * 60 * 1000;

/** 平台外卖单号：去掉 # 与空白后，3~40 位字母数字（允许 - 与 _） */
const EXTERNAL_NO_RE = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;

function normalizeExternalNo(raw: string): string {
  return raw.trim().replace(/^#+/, '').replace(/\s+/g, '').toUpperCase();
}

export interface BizServiceOptions {
  config: RelayConfig;
  business: BusinessConfig;
  logger: Logger;
  engine: Engine;
  keys: KeyRegistry;
  store?: BizStore;
}

interface CodeState {
  ok: boolean;
  status: number;
  message?: string;
  record?: BizCode;
}

/** 管理台与商家台共用一个控制台页面，服务端按令牌分辨身份 */
type Actor =
  | { kind: 'admin' }
  | { kind: 'merchant'; merchant: BizMerchant };

export class BizService {
  private readonly logger: Logger;
  private readonly business: BusinessConfig;
  private readonly packs: PackConfig[];
  private readonly store: BizStore;
  private readonly signer: SessionSigner;
  private readonly payment: PaymentProvider;
  private readonly machinePay: MachinePayConfig | undefined;
  private readonly machinePayProvider: MachinePayProvider | undefined;
  private readonly adminAuth: AdminAuth;
  private readonly seed: string;
  private readonly engine: Engine;
  private readonly keys: KeyRegistry;
  /** 码 → 正在生成中的调用数（进程内；重启清零，以库内 used 为准） */
  private readonly inflight = new Map<string, number>();

  constructor(private readonly opts: BizServiceOptions) {
    this.logger = opts.logger;
    this.business = opts.business;
    this.packs = resolvePacks(opts.business);
    this.store = opts.store ?? createBizStore(opts.config, opts.logger);
    this.engine = opts.engine;
    this.keys = opts.keys;
    this.seed = createHmac('sha256', 'api-relay-biz-v1')
      .update(opts.config.server.adminToken ?? 'local-admin')
      .update('|')
      .update(opts.config.storage.path)
      .digest('hex');
    this.signer = new SessionSigner(this.seed);
    this.adminAuth = new AdminAuth(opts.config.server.adminToken);
    this.payment = this.buildPayment();
    this.machinePay = this.business.machinePay?.enabled ? this.business.machinePay : undefined;
    this.machinePayProvider = this.machinePay ? this.buildMachinePay() : undefined;
  }

  get paymentProviderId(): 'mock' | 'alipay' {
    return this.payment.id;
  }

  get machinePayProviderId(): 'mock' | 'alipay' | undefined {
    return this.machinePayProvider?.id;
  }

  async init(): Promise<void> {
    await this.store.init();
    this.logger.info('biz.ready', {
      packs: this.packs.length,
      provider: this.payment.id,
      machinePay: this.machinePayProvider?.id ?? 'off',
      storage: 'ok',
    });
    if (this.machinePayProvider?.id === 'mock') {
      this.logger.warn('biz.machine_pay_mock', { note: '按量付费使用 mock：任何人都能用 402 演示链接免费拿凭证，仅限本地评审，上线前切 alipay' });
    }
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private buildPayment(): PaymentProvider {
    const cfg = this.business.payments;
    if (cfg.provider === 'alipay' && cfg.alipay) {
      if (!cfg.alipay.notifyUrl) {
        this.logger.warn('biz.alipay_missing_notify_url', { fallback: 'mock' });
        return new MockPaymentProvider((id) => this.mockLinkToken(id));
      }
      try {
        return new AlipayProvider({
          appId: cfg.alipay.appId,
          privateKey: cfg.alipay.privateKey,
          alipayPublicKey: cfg.alipay.alipayPublicKey,
          gateway: cfg.alipay.gateway ?? 'https://openapi.alipay.com/gateway.do',
          notifyUrl: cfg.alipay.notifyUrl,
          ...(cfg.alipay.sellerId ? { sellerId: cfg.alipay.sellerId } : {}),
        });
      } catch (err) {
        this.logger.error('biz.alipay_init_failed', { error: err instanceof Error ? err.message : String(err), fallback: 'mock' });
      }
    }
    return new MockPaymentProvider((id) => this.mockLinkToken(id));
  }

  private buildMachinePay(): MachinePayProvider | undefined {
    const cfg = this.machinePay;
    if (!cfg) return undefined;
    if (cfg.provider === 'mock') return new MockMachinePayProvider(this.seed);
    const a = this.business.payments.alipay;
    if (!a) {
      this.logger.error('biz.machine_pay_missing_alipay', { fallback: 'disabled' });
      return undefined;
    }
    try {
      return new AlipayMachinePayProvider({
        appId: a.appId,
        privateKey: a.privateKey,
        alipayPublicKey: a.alipayPublicKey,
        gateway: a.gateway ?? 'https://openapi.alipay.com/gateway.do',
      });
    } catch (err) {
      this.logger.error('biz.machine_pay_init_failed', { error: errText(err), fallback: 'disabled' });
      return undefined;
    }
  }

  /* ============================== 路由 ============================== */

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    headers: Record<string, string>,
    requestId: string,
  ): Promise<boolean> {
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && path === '/biz') {
      this.html(res, 200, consoleHtml());
      return true;
    }

    const customer = /^\/s\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && customer) {
      const code = decodeSafe(customer[1] ?? '');
      if (!code) {
        this.html(res, 404, errorPage('链接无效', '请重新扫描商家桌贴上的二维码。'));
        return true;
      }
      this.html(res, 200, customerHtml());
      return true;
    }

    const pay = /^\/pay\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && pay) {
      await this.serveMockCheckout(res, decodeSafe(pay[1] ?? ''), url);
      return true;
    }

    const qr = /^\/biz\/qr\/([^/]+)\.svg$/.exec(path);
    if (req.method === 'GET' && qr) {
      this.serveQr(res, decodeSafe(qr[1] ?? ''), headers);
      return true;
    }

    if (path === '/biz/api/alipay/notify' && req.method === 'POST') {
      await this.handleAlipayNotify(req, res);
      return true;
    }

    if (path.startsWith('/agent/')) {
      return this.handleAgent(req, res, path, headers, url);
    }

    const print = /^\/biz\/print\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && print) {
      const actor = this.actor(req, res, headers);
      if (!actor) return true;
      this.servePrint(res, decodeSafe(print[1] ?? ''), actor);
      return true;
    }

    const label = /^\/biz\/label\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && label) {
      const actor = this.actor(req, res, headers);
      if (!actor) return true;
      this.serveLabel(res, decodeSafe(label[1] ?? ''), actor, url, headers);
      return true;
    }

    if (path.startsWith('/biz/api/')) {
      return this.handleApi(req, res, path, headers, url);
    }

    if (path.startsWith('/biz') || path.startsWith('/s/') || path.startsWith('/pay/')) {
      this.json(res, 404, { error: { message: `未知业务端点 ${path}`, type: 'not_found_error', code: 'not_found' } });
      return true;
    }
    return false;
  }

  private async handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    headers: Record<string, string>,
    url: URL,
  ): Promise<boolean> {
    /* ---------- 顾客侧（Cookie 会话，无 admin token） ---------- */
    if (path === '/biz/api/session' && req.method === 'POST') {
      await this.handleSession(req, res, headers, url);
      return true;
    }
    if (path === '/biz/api/me' && req.method === 'GET') {
      this.handleMe(res, headers);
      return true;
    }
    if (path === '/biz/api/chat' && req.method === 'POST') {
      await this.handleChat(req, res, headers);
      return true;
    }
    if (path === '/biz/api/image' && req.method === 'POST') {
      await this.handleImage(req, res, headers);
      return true;
    }
    // mock 收银台是顾客侧（其实付钱的是商家）页面，凭链接里的签名 token 放行，不带 admin token。
    const mockPay = /^\/biz\/api\/orders\/([^/]+)\/mock-pay$/.exec(path);
    if (mockPay && req.method === 'POST') {
      await this.mockPay(req, res, decodeSafe(mockPay[1] ?? ''));
      return true;
    }

    /* ---------- 商家/管理员侧（令牌分辨身份） ---------- */
    const actor = this.actor(req, res, headers);
    if (!actor) return true;

    if (path === '/biz/api/whoami' && req.method === 'GET') {
      if (actor.kind === 'admin') {
        this.json(res, 200, { kind: 'admin', merchantName: this.business.merchantName ?? null });
      } else {
        const m = this.store.getMerchant(actor.merchant.id) ?? actor.merchant;
        this.json(res, 200, { kind: 'merchant', merchant: this.merchantView(m) });
      }
      return true;
    }

    if (path === '/biz/api/merchants') {
      if (!this.adminOnly(res, actor)) return true;
      if (req.method === 'GET') {
        this.json(res, 200, { merchants: this.store.listMerchants().map((m) => this.merchantView(m)) });
        return true;
      }
      if (req.method === 'POST') {
        await this.createMerchant(req, res);
        return true;
      }
    }

    const merchantAction = /^\/biz\/api\/merchants\/([^/]+)\/(rotate|disable|enable)$/.exec(path);
    if (merchantAction && req.method === 'POST') {
      if (!this.adminOnly(res, actor)) return true;
      this.merchantAction(res, decodeSafe(merchantAction[1] ?? ''), merchantAction[2] as 'rotate' | 'disable' | 'enable');
      return true;
    }

    if (path === '/biz/api/packs' && req.method === 'GET') {
      this.json(res, 200, {
        packs: this.packs.map((p) => ({
          id: p.id,
          name: p.name,
          uses: p.uses,
          priceCny: p.priceCny,
          models: p.models,
          validDays: p.validDays,
          ...(p.description ? { description: p.description } : {}),
        })),
      });
      return true;
    }

    if (path === '/biz/api/orders' && req.method === 'POST') {
      await this.createOrder(req, res, actor);
      return true;
    }
    if (path === '/biz/api/orders' && req.method === 'GET') {
      const merchantId = actor.kind === 'merchant' ? actor.merchant.id : undefined;
      const orders = this.store.listOrders(100, merchantId).map((o) => this.orderView(o));
      this.json(res, 200, { orders });
      return true;
    }

    const payLink = /^\/biz\/api\/orders\/([^/]+)\/pay-link$/.exec(path);
    if (payLink && req.method === 'GET') {
      await this.payLink(res, decodeSafe(payLink[1] ?? ''), actor);
      return true;
    }

    const orderCodes = /^\/biz\/api\/orders\/([^/]+)\/codes$/.exec(path);
    if (orderCodes && req.method === 'GET') {
      const orderId = decodeSafe(orderCodes[1] ?? '');
      const order = this.store.getOrder(orderId);
      if (!order || !this.canSeeOrder(actor, order)) {
        this.json(res, 404, { error: { message: '订单不存在', type: 'not_found_error', code: 'order_not_found' } });
        return true;
      }
      this.json(res, 200, { codes: this.store.listCodesByOrder(orderId).map((c) => this.codeView(c, url)) });
      return true;
    }

    const revoke = /^\/biz\/api\/codes\/([^/]+)\/revoke$/.exec(path);
    if (revoke && req.method === 'POST') {
      this.revokeCode(res, decodeSafe(revoke[1] ?? ''), actor);
      return true;
    }

    if (path === '/biz/api/slips/bind' && req.method === 'POST') {
      await this.bindSlip(req, res, actor, url, headers);
      return true;
    }

    if (path === '/biz/api/slips' && req.method === 'GET') {
      const scope = this.externalScope(actor);
      const limit = Number(url.searchParams.get('limit') ?? 20);
      this.json(res, 200, {
        slips: this.store.listSlips(scope, Number.isFinite(limit) ? limit : 20).map((s) => this.slipView(s, url)),
      });
      return true;
    }

    if (path === '/biz/api/summary' && req.method === 'GET') {
      const merchantId = actor.kind === 'merchant' ? actor.merchant.id : undefined;
      this.json(res, 200, this.store.summary(Date.now(), merchantId));
      return true;
    }

    this.json(res, 404, { error: { message: `未知业务接口 ${path}`, type: 'not_found_error', code: 'not_found' } });
    return true;
  }

  /* ======================== AI 按量付费（402） ======================== */

  private async handleAgent(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    headers: Record<string, string>,
    url: URL,
  ): Promise<boolean> {
    if (!this.machinePay || !this.machinePayProvider) {
      this.json(res, 404, {
        error: { message: 'AI 按量付费未启用（business.machinePay.enabled）', type: 'not_found_error', code: 'machine_pay_disabled' },
      });
      return true;
    }
    if (req.method === 'GET' && path === '/agent/mock-pay') {
      this.serveMockMachinePay(res, url);
      return true;
    }
    if (req.method === 'POST' && path === '/agent/v1/chat/completions') {
      await this.handleAgentChat(req, res, headers);
      return true;
    }
    this.json(res, 404, { error: { message: `未知按量付费端点 ${path}`, type: 'not_found_error', code: 'not_found' } });
    return true;
  }

  /**
   * Agent 按次付费链路：
   *   无 Payment-Proof → 402 + amtPaymentLink
   *   有 Payment-Proof → verify → 对账 → 领租约 → 调引擎 → 成功才 consumed
   * 失败（上游 5xx / 流中断）时订单退回 paid，同一张凭证可以重试。
   */
  private async handleAgentChat(req: IncomingMessage, res: ServerResponse, headers: Record<string, string>): Promise<void> {
    const cfg = this.machinePay;
    const provider = this.machinePayProvider;
    if (!cfg || !provider) return;

    const body = await this.readJson(req, res);
    if (!body) return;
    const messages = body['messages'];
    if (!Array.isArray(messages) || messages.length === 0) {
      this.json(res, 400, { error: { message: 'messages 不能为空', type: 'invalid_request_error', code: 'messages_required' } });
      return;
    }
    const requested = typeof body['model'] === 'string' ? body['model'] : '';
    const model = cfg.models.includes(requested) ? requested : cfg.models[0] ?? '';
    if (!model) {
      this.json(res, 503, { error: { message: '按量付费入口未配置可用模型', type: 'relay_internal_error', code: 'no_model' } });
      return;
    }

    const rawProof = headers['payment-proof'];
    if (!rawProof) {
      await this.issueMachineChallenge(res);
      return;
    }

    const proof = parsePaymentProof(rawProof);
    if (!proof) {
      this.paymentRequired(res, 'payment_proof_invalid', 'Payment-Proof 格式不正确，请重新获取支付凭证');
      return;
    }

    let verified;
    try {
      verified = await provider.verify(proof);
    } catch (err) {
      this.logger.warn('biz.machine_verify_failed', { error: errText(err) });
      this.json(res, 502, { error: { message: '支付凭证验证失败，请稍后重试', type: 'upstream_error', code: 'payment_verify_failed' } });
      return;
    }
    if (verified.upstreamError) {
      this.logger.warn('biz.machine_verify_upstream_failed', { reason: verified.reason });
      this.json(res, 502, { error: { message: '支付凭证验证服务暂不可用，请稍后重试', type: 'upstream_error', code: 'payment_verify_failed' } });
      return;
    }
    if (!verified.ok || verified.active !== true) {
      this.paymentRequired(res, 'payment_proof_invalid', verified.reason ?? '支付凭证无效或已过期，请重新支付');
      return;
    }

    const outTradeNo = verified.outTradeNo ?? '';
    const order = outTradeNo ? this.store.getMachineOrder(outTradeNo) : undefined;
    if (!order || order.serviceId !== this.machineServiceId()) {
      this.paymentRequired(res, 'payment_order_mismatch', '支付凭证对应的订单不存在');
      return;
    }
    if (!amountEquals(verified.amountCny, order.amountCny)) {
      this.paymentRequired(res, 'payment_amount_mismatch', '支付金额与订单不一致');
      return;
    }
    if (verified.tradeNo !== undefined && verified.tradeNo !== proof.tradeNo) {
      this.paymentRequired(res, 'payment_trade_mismatch', '支付凭证与交易号不一致');
      return;
    }
    if (cfg.resourceId && verified.resourceId !== undefined && verified.resourceId !== cfg.resourceId) {
      this.paymentRequired(res, 'payment_resource_mismatch', '支付凭证对应的资源与本次请求不一致');
      return;
    }
    if (!this.store.markMachinePaid(order.outTradeNo, proof.tradeNo, verified.resourceId, Date.now())) {
      this.paymentRequired(res, 'payment_trade_used', '该支付凭证已履约或状态不可用');
      return;
    }
    if (this.store.getMachineOrder(order.outTradeNo)?.status === 'consumed') {
      this.paymentRequired(res, 'payment_trade_used', '该支付凭证已履约，不能重复使用');
      return;
    }
    if (!this.store.leaseMachineOrder(order.outTradeNo, Date.now(), MACHINE_LEASE_MS)) {
      this.paymentRequired(res, 'payment_in_progress', '该支付凭证正在履约，请勿重复提交');
      return;
    }

    const payload: Record<string, unknown> = { model, messages, stream: body['stream'] === true };
    for (const key of ['temperature', 'top_p', 'max_tokens', 'stop']) {
      if (body[key] !== undefined) payload[key] = body[key];
    }
    const rawBody = new Uint8Array(Buffer.from(JSON.stringify(payload), 'utf8'));
    let ok = false;
    try {
      const out = await this.executeOnce(res, req, headers, this.machinePayKey(), rawBody, '/v1/chat/completions');
      ok = out.ok;
      this.logger.debug('biz.machine_pay_call', {
        outTradeNo: order.outTradeNo,
        tradeNo: proof.tradeNo,
        status: out.status ?? 0,
        counted: ok,
      });
    } finally {
      this.store.finishMachineOrder(order.outTradeNo, ok, Date.now());
    }
  }

  private async issueMachineChallenge(res: ServerResponse): Promise<void> {
    const cfg = this.machinePay;
    const provider = this.machinePayProvider;
    if (!cfg || !provider) return;
    const now = Date.now();
    const serviceId = this.machineServiceId();
    const amountCny = Number(cfg.priceCny.toFixed(2));
    let order = this.store.findOpenMachineOrder(serviceId, amountCny, now);
    if (!order) {
      const outTradeNo = this.newMachineOrderId();
      order = {
        outTradeNo,
        serviceId,
        amountCny,
        goodsName: cfg.goodsName ?? 'AI 调用（每次）',
        status: 'pending',
        createdAt: now,
        payBeforeAt: now + (cfg.payBeforeMinutes ?? 10) * 60_000,
      };
      this.store.createMachineOrder(order);
    }
    let amtPrePayId = order.amtPrePayId;
    if (!amtPrePayId) {
      try {
        const created = await provider.precreate({
          outTradeNo: order.outTradeNo,
          amountCny: order.amountCny,
          goodsName: order.goodsName,
          serviceId: order.serviceId,
          payBefore: formatPayBefore(order.payBeforeAt),
        });
        this.store.setMachinePrePayId(order.outTradeNo, created.amtPrePayId);
        amtPrePayId = created.amtPrePayId;
      } catch (err) {
        this.logger.error('biz.machine_precreate_failed', { error: errText(err) });
        this.json(res, 502, { error: { message: '创建支付账单失败，请稍后重试', type: 'upstream_error', code: 'precreate_failed' } });
        return;
      }
    }
    res.setHeader('amtPaymentLink', amtPrePayId);
    res.setHeader('cache-control', 'no-store');
    this.json(res, 402, {
      error: {
        message: `该接口按次计费 ¥${order.amountCny.toFixed(2)}，支付后凭 Payment-Proof 重试`,
        type: 'payment_required',
        code: 'payment_required',
        param: null,
      },
      payment: {
        provider: provider.id,
        serviceId: order.serviceId,
        amountCny: order.amountCny,
        outTradeNo: order.outTradeNo,
        amtPrePayId,
        payBefore: formatPayBefore(order.payBeforeAt),
        ...(provider.id === 'mock'
          ? { mockPayUrl: `/agent/mock-pay?order=${encodeURIComponent(order.outTradeNo)}&t=${encodeURIComponent(this.mockMachineToken(order.outTradeNo))}` }
          : {}),
      },
    });
  }

  /** mock 演示：签发一张能被 mock verify 认的支付凭证（仅 mock provider 存在） */
  private serveMockMachinePay(res: ServerResponse, url: URL): void {
    const provider = this.machinePayProvider;
    if (!(provider instanceof MockMachinePayProvider)) {
      this.json(res, 404, { error: { message: '当前不是 mock 按量付费模式', type: 'not_found_error', code: 'mock_pay_disabled' } });
      return;
    }
    const orderId = url.searchParams.get('order') ?? '';
    const token = url.searchParams.get('t') ?? '';
    if (!orderId || !token || !timeSafeEqual(token, this.mockMachineToken(orderId))) {
      this.json(res, 403, { error: { message: '演示支付链接无效', type: 'permission_error', code: 'mock_pay_token_invalid' } });
      return;
    }
    const order = this.store.getMachineOrder(orderId);
    if (!order) {
      this.json(res, 404, { error: { message: '订单不存在', type: 'not_found_error', code: 'order_not_found' } });
      return;
    }
    if (order.status === 'consumed') {
      this.json(res, 409, { error: { message: '该订单已履约，不能重复支付', type: 'invalid_request_error', code: 'order_consumed' } });
      return;
    }
    const tradeNo = order.status === 'pending' || !order.tradeNo
      ? `mock_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`
      : order.tradeNo;
    this.json(res, 200, {
      outTradeNo: order.outTradeNo,
      tradeNo,
      amountCny: order.amountCny,
      paymentProof: provider.makeProof(order.outTradeNo, order.amountCny, tradeNo),
      header: 'Payment-Proof',
    });
  }

  private machineServiceId(): string {
    return this.machinePay?.serviceId || 'mock-service';
  }

  private newMachineOrderId(): string {
    let id = `mp_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
    while (this.store.getMachineOrder(id)) id = `mp_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
    return id;
  }

  private mockMachineToken(outTradeNo: string): string {
    return createHmac('sha256', this.seed).update(`mock-machine:${outTradeNo}`).digest('base64url').slice(0, 24);
  }

  /** 按量付费的内部 key：调用方永远看不到；次数/金额闸门在 402 链路，不在 key 配额 */
  private machinePayKey(): string {
    const cfg = this.machinePay;
    if (!cfg) throw new Error('按量付费未启用');
    const serviceId = this.machineServiceId();
    const secret = `sk_pk_${createHmac('sha256', this.seed).update(`machine-key:${serviceId}`).digest('hex').slice(0, 32)}`;
    const existing = this.keys.resolveSecret(secret);
    if (existing.found && existing.key) {
      if (existing.status !== 'ok') {
        this.keys.update(existing.key.id, { enabled: true, allowedModels: cfg.models }, 'machine-pay');
      }
      return secret;
    }
    this.keys.create({
      secret,
      label: `machine-pay:${serviceId}`,
      tier: 'standard',
      tenantId: `machine_${serviceId}`,
      allowedModels: cfg.models,
      actor: 'machine-pay',
    });
    return secret;
  }

  private paymentRequired(res: ServerResponse, code: string, message: string): void {
    res.setHeader('cache-control', 'no-store');
    this.json(res, 402, { error: { message, type: 'payment_required', code, param: null } });
  }

  /* ============================ 商家侧 ============================ */

  private async createOrder(req: IncomingMessage, res: ServerResponse, actor: Actor): Promise<void> {
    const body = await this.readJson(req, res);
    if (!body) return;
    const packId = typeof body['packId'] === 'string' ? body['packId'] : '';
    const pack = findPack(this.packs, packId);
    if (!pack) {
      this.json(res, 400, { error: { message: `套餐不存在: ${packId || '(空)'}`, type: 'invalid_request_error', code: 'pack_not_found' } });
      return;
    }
    const rawQty = Number(body['quantity'] ?? 1);
    const quantity = Number.isFinite(rawQty) ? Math.floor(rawQty) : 1;
    if (quantity < 1 || quantity > 20) {
      this.json(res, 400, { error: { message: '购买数量需在 1~20 之间', type: 'invalid_request_error', code: 'invalid_quantity' } });
      return;
    }
    // 商家令牌下单时名字与归属由服务端决定，请求体里的 merchantName 一律忽略。
    const merchantName = (
      actor.kind === 'merchant'
        ? actor.merchant.name
        : typeof body['merchantName'] === 'string' && body['merchantName'].trim()
          ? body['merchantName'].trim()
          : this.business.merchantName ?? '外卖 AI 商家'
    ).slice(0, 60);

    const now = Date.now();
    let orderId = newOrderId(now);
    while (this.store.getOrder(orderId)) orderId = newOrderId(now);
    const order: BizOrder = {
      id: orderId,
      ...(actor.kind === 'merchant' ? { merchantId: actor.merchant.id } : {}),
      merchantName,
      packId: pack.id,
      packName: pack.name,
      quantity,
      unitPriceCny: pack.priceCny,
      amountCny: packPrice(pack, quantity),
      usesTotal: pack.uses,
      validDays: pack.validDays,
      models: [...pack.models],
      status: 'pending',
      provider: this.payment.id,
      createdAt: now,
    };
    this.store.createOrder(order);

    let intent: PaymentIntent;
    try {
      intent = await this.payment.createPayment({
        id: order.id,
        amountCny: order.amountCny,
        subject: `${pack.name} × ${quantity}`,
      });
    } catch (err) {
      // 订单已落库，支付入口可以稍后用「去支付」重试；错误要说清订单号。
      this.logger.warn('biz.payment_create_failed', { orderId: order.id, error: errText(err) });
      this.json(res, 502, {
        error: {
          message: `订单 ${order.id} 已创建，但支付入口创建失败：${errText(err)}。可在订单列表点「去支付」重试。`,
          type: 'upstream_error',
          code: 'payment_create_failed',
        },
      });
      return;
    }

    this.json(res, 200, {
      order: this.orderView(order),
      payment: {
        ...intent,
        ...(intent.kind === 'qr' ? { payQrSvg: qrSvg(intent.payUrl) } : {}),
      },
    });
    this.logger.info('biz.order_created', { orderId: order.id, packId: pack.id, quantity, amountCny: order.amountCny });
  }

  private async payLink(res: ServerResponse, orderId: string, actor: Actor): Promise<void> {
    const order = this.store.getOrder(orderId);
    if (!order || !this.canSeeOrder(actor, order)) {
      this.json(res, 404, { error: { message: '订单不存在', type: 'not_found_error', code: 'order_not_found' } });
      return;
    }
    if (order.status !== 'pending') {
      this.json(res, 409, { error: { message: '订单已支付或已取消，无需再次支付', type: 'invalid_request_error', code: 'order_not_pending' } });
      return;
    }
    try {
      const intent = await this.payment.createPayment({
        id: order.id,
        amountCny: order.amountCny,
        subject: `${order.packName} × ${order.quantity}`,
      });
      this.json(res, 200, {
        order: this.orderView(order),
        payment: { ...intent, ...(intent.kind === 'qr' ? { payQrSvg: qrSvg(intent.payUrl) } : {}) },
      });
    } catch (err) {
      this.json(res, 502, { error: { message: `支付入口创建失败：${errText(err)}`, type: 'upstream_error', code: 'payment_create_failed' } });
    }
  }

  private async mockPay(req: IncomingMessage, res: ServerResponse, orderId: string): Promise<void> {
    if (this.payment.id !== 'mock') {
      this.json(res, 409, { error: { message: '当前不是 mock 支付模式', type: 'invalid_request_error', code: 'mock_disabled' } });
      return;
    }
    const body = await this.readJson(req, res);
    if (!body) return;
    const order = this.store.getOrder(orderId);
    if (!order) {
      this.json(res, 404, { error: { message: '订单不存在', type: 'not_found_error', code: 'order_not_found' } });
      return;
    }
    const token = typeof body['t'] === 'string' ? body['t'] : '';
    if (!safeEqual(token, this.mockLinkToken(order.id))) {
      this.json(res, 403, { error: { message: '支付链接无效或已过期，请回商家台重新发起支付', type: 'permission_error', code: 'bad_pay_token' } });
      return;
    }
    if (order.status === 'cancelled') {
      this.json(res, 409, { error: { message: '订单已取消', type: 'invalid_request_error', code: 'order_cancelled' } });
      return;
    }
    if (order.status === 'pending') {
      const paidAt = Date.now();
      this.store.markPaid(order.id, `mock_${order.id}`, paidAt);
      const paid = this.store.getOrder(order.id) ?? { ...order, status: 'paid' as const, paidAt };
      this.ensureCodes(paid);
      this.logger.info('biz.order_paid', { orderId: order.id, provider: 'mock' });
    } else {
      this.ensureCodes(order);
    }
    const latest = this.store.getOrder(order.id) ?? order;
    this.json(res, 200, { ok: true, order: this.orderView(latest) });
  }

  private async handleAlipayNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await this.readRaw(req, res, 512 * 1024);
    if (raw === undefined) return;
    const result = await this.payment.verifyNotify(raw);
    if (!result.ok || !result.orderId) {
      this.logger.warn('biz.notify_rejected', { reason: result.reason ?? 'unknown' });
      this.text(res, 400, 'failure');
      return;
    }
    const order = this.store.getOrder(result.orderId);
    if (!order) {
      this.logger.warn('biz.notify_unknown_order', { orderId: result.orderId });
      this.text(res, 200, 'failure');
      return;
    }
    if (Math.abs(order.amountCny - (result.amountCny ?? -1)) > 0.001) {
      this.logger.warn('biz.notify_amount_mismatch', { orderId: order.id, expected: order.amountCny, got: result.amountCny });
      this.text(res, 200, 'failure');
      return;
    }
    if (order.status === 'pending') {
      this.store.markPaid(order.id, result.tradeNo ?? '', Date.now());
      this.logger.info('biz.order_paid', { orderId: order.id, provider: 'alipay' });
    }
    const latest = this.store.getOrder(order.id) ?? order;
    this.ensureCodes(latest);
    // 支付宝要求纯文本 success，重复通知同样回 success（幂等）
    this.text(res, 200, 'success');
  }

  private ensureCodes(order: BizOrder): BizCode[] {
    const existing = this.store.listCodesByOrder(order.id);
    if (existing.length > 0) return existing;
    if (order.status !== 'paid') return [];
    const now = order.paidAt ?? Date.now();
    const expiresAt = now + order.validDays * 86_400_000;
    const codes: BizCode[] = [];
    for (let i = 0; i < order.quantity; i++) {
      let code = generateCode();
      for (let retry = 0; retry < 5 && this.store.getCode(code); retry++) code = generateCode();
      if (this.store.getCode(code)) throw new Error('核销码生成冲突，请重试');
      codes.push({
        code,
        orderId: order.id,
        packId: order.packId,
        merchantName: order.merchantName,
        usesTotal: order.usesTotal,
        usesUsed: 0,
        keyId: codeKeyId(code),
        createdAt: now,
        expiresAt,
      });
    }
    this.store.createCodes(codes);
    this.logger.info('biz.codes_issued', { orderId: order.id, count: codes.length });
    return codes;
  }

  private externalScope(actor: Actor): string {
    return actor.kind === 'merchant' ? actor.merchant.id : '';
  }

  /**
   * 外卖单码：一个平台订单号换一个码。
   * 重复录入直接返回原绑定（reused=true），不会把池子里的码再吃掉一个。
   */
  private async bindSlip(
    req: IncomingMessage,
    res: ServerResponse,
    actor: Actor,
    url: URL,
    headers: Record<string, string>,
  ): Promise<void> {
    const body = await this.readJson(req, res);
    if (!body) return;
    const externalNo = normalizeExternalNo(typeof body['externalOrderNo'] === 'string' ? body['externalOrderNo'] : '');
    if (!EXTERNAL_NO_RE.test(externalNo)) {
      this.json(res, 400, {
        error: {
          message: '订单号格式不对：去掉 # 和空格后需为 3~40 位字母、数字、- 或 _',
          type: 'invalid_request_error',
          code: 'invalid_external_no',
        },
      });
      return;
    }
    const scope = this.externalScope(actor);
    const now = Date.now();
    const existing = this.store.getSlip(scope, externalNo);
    if (existing) {
      this.respondSlip(res, existing, true, scope, now, url, headers);
      return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const rec = this.store.findBindableCode(scope, now);
      if (!rec) {
        this.json(res, 409, {
          error: {
            message: '没有可绑定的码：先购买「外卖单码」包，且码未撤销、未过期、还有剩余次数',
            type: 'invalid_request_error',
            code: 'slip_pool_empty',
          },
        });
        return;
      }
      const bound = this.store.bindSlip({
        code: rec.code,
        merchantId: scope,
        externalNo,
        orderId: rec.orderId,
        createdAt: now,
      });
      if (bound) {
        const slip = this.store.getSlip(scope, externalNo);
        if (slip) {
          this.logger.info('biz.slip_bound', {
            code: slip.code,
            orderId: slip.orderId,
            externalNo,
            merchantId: scope || null,
          });
          this.respondSlip(res, slip, false, scope, now, url, headers);
          return;
        }
      }
      // 并发下同一单号可能刚被另一请求绑走：返回已存在的绑定
      const raced = this.store.getSlip(scope, externalNo);
      if (raced) {
        this.respondSlip(res, raced, true, scope, now, url, headers);
        return;
      }
    }
    this.json(res, 409, {
      error: { message: '并发绑定冲突，请重试', type: 'invalid_request_error', code: 'slip_bind_conflict' },
    });
  }

  private respondSlip(
    res: ServerResponse,
    slip: BizSlip,
    reused: boolean,
    scope: string,
    now: number,
    url: URL,
    headers: Record<string, string>,
  ): void {
    this.json(res, 200, {
      reused,
      slip: this.slipView(slip, url, headers),
      pool: { remaining: this.store.countBindableCodes(scope, now) },
    });
  }

  private slipView(s: BizSlip, url?: URL, headers?: Record<string, string>): Record<string, unknown> {
    const rec = this.store.getCode(s.code);
    const order = this.store.getOrder(s.orderId);
    return {
      externalNo: s.externalNo,
      code: s.code,
      orderId: s.orderId,
      boundAt: s.createdAt,
      merchantName: rec?.merchantName ?? order?.merchantName ?? '',
      packName: order?.packName ?? '',
      usesTotal: rec?.usesTotal ?? 0,
      usesUsed: rec?.usesUsed ?? 0,
      remaining: rec ? Math.max(0, rec.usesTotal - rec.usesUsed) : 0,
      expiresAt: rec?.expiresAt ?? 0,
      scanPath: `/s/${s.code}`,
      ...(url ? { scanUrl: `${this.publicBase(url, headers)}/s/${s.code}` } : {}),
      labelPath: `/biz/label/${encodeURIComponent(s.code)}`,
    };
  }

  private serveLabel(
    res: ServerResponse,
    rawCode: string,
    actor: Actor,
    url: URL,
    headers: Record<string, string>,
  ): void {
    const code = normalizeCode(rawCode);
    const rec = code ? this.store.getCode(code) : undefined;
    const order = rec ? this.store.getOrder(rec.orderId) : undefined;
    if (!rec || !order || !this.canSeeOrder(actor, order)) {
      this.html(res, 404, errorPage('标签对应的码不存在', '请刷新商家台后重试。'));
      return;
    }
    const pack = findPack(this.packs, rec.packId);
    const slip = this.store.getSlipByCode(rec.code);
    this.html(
      res,
      200,
      labelHtml({
        code: rec.code,
        scanUrl: `${this.publicBase(url, headers)}/s/${rec.code}`,
        externalNo: slip?.externalNo,
        packName: pack?.name ?? order.packName,
        merchantName: rec.merchantName,
        usesTotal: rec.usesTotal,
        expiresAt: rec.expiresAt,
      }),
    );
  }

  private revokeCode(res: ServerResponse, rawCode: string, actor: Actor): void {
    const code = normalizeCode(rawCode);
    if (!code) {
      this.json(res, 400, { error: { message: '核销码格式不正确', type: 'invalid_request_error', code: 'invalid_code' } });
      return;
    }
    const rec = this.store.getCode(code);
    if (!rec) {
      this.json(res, 404, { error: { message: '核销码不存在', type: 'not_found_error', code: 'code_not_found' } });
      return;
    }
    const order = this.store.getOrder(rec.orderId);
    if (!order || !this.canSeeOrder(actor, order)) {
      this.json(res, 404, { error: { message: '核销码不存在', type: 'not_found_error', code: 'code_not_found' } });
      return;
    }
    const revoked = this.store.revokeCode(code, Date.now());
    if (revoked) {
      try {
        this.keys.revoke(rec.keyId, 'biz');
      } catch {
        /* 还没懒创建过 key 或 key 已被清理：撤销以码状态为准 */
      }
    }
    this.json(res, 200, { ok: true, alreadyRevoked: !revoked });
  }

  /* ============================ 顾客侧 ============================ */

  private async handleSession(req: IncomingMessage, res: ServerResponse, headers: Record<string, string>, url: URL): Promise<void> {
    const body = await this.readJson(req, res);
    if (!body) return;
    const code = normalizeCode(typeof body['code'] === 'string' ? body['code'] : '');
    if (!code) {
      this.json(res, 400, { error: { message: '核销码格式不正确，请重新扫码', type: 'invalid_request_error', code: 'invalid_code' } });
      return;
    }
    const state = this.codeState(code);
    if (!state.ok || !state.record) {
      this.json(res, state.status, { error: { message: state.message ?? '该码不可用', type: 'invalid_request_error', code: 'code_unusable' } });
      return;
    }
    const rec = state.record;
    try {
      await this.ensureKey(rec);
    } catch (err) {
      this.logger.error('biz.key_ensure_failed', { orderId: rec.orderId, error: errText(err) });
      this.json(res, 500, { error: { message: '生成访问凭证失败，请稍后重试', type: 'relay_internal_error', code: 'key_create_failed' } });
      return;
    }
    this.store.markSeen(code, Date.now());
    const { token, session } = this.signer.sign(code, this.business.sessionTtlHours);
    const secure = this.isHttps(headers, url);
    res.setHeader('set-cookie', sessionCookie(token, this.business.sessionTtlHours, secure));
    this.json(res, 200, { ...this.sessionInfo(rec), sid: session.sid });
  }

  private handleMe(res: ServerResponse, headers: Record<string, string>): void {
    const session = this.customerSession(headers);
    if (!session) {
      this.json(res, 401, { error: { message: '会话已过期，请重新扫码', type: 'authentication_error', code: 'session_expired' } });
      return;
    }
    const rec = this.store.getCode(session.code);
    if (!rec) {
      this.json(res, 410, { error: { message: '核销码不存在，请联系商家', type: 'invalid_request_error', code: 'code_not_found' } });
      return;
    }
    if (rec.revokedAt !== undefined) {
      this.json(res, 410, { error: { message: '该码已被商家撤销', type: 'invalid_request_error', code: 'code_revoked' } });
      return;
    }
    if (rec.expiresAt <= Date.now()) {
      this.json(res, 410, { error: { message: '该码已过期，请联系商家续购', type: 'invalid_request_error', code: 'code_expired' } });
      return;
    }
    this.json(res, 200, this.sessionInfo(rec));
  }

  private async handleChat(req: IncomingMessage, res: ServerResponse, headers: Record<string, string>): Promise<void> {
    const session = this.customerSession(headers);
    if (!session) {
      this.json(res, 401, { error: { message: '会话已过期，请重新扫码', type: 'authentication_error', code: 'session_expired' } });
      return;
    }
    const state = this.codeState(session.code);
    if (!state.ok || !state.record) {
      this.json(res, state.status, { error: { message: state.message ?? '该码不可用', type: 'invalid_request_error', code: 'code_unusable' } });
      return;
    }
    const rec = state.record;
    const body = await this.readJson(req, res);
    if (!body) return;
    const messages = body['messages'];
    if (!Array.isArray(messages) || messages.length === 0) {
      this.json(res, 400, { error: { message: 'messages 不能为空', type: 'invalid_request_error', code: 'messages_required' } });
      return;
    }
    const order = this.store.getOrder(rec.orderId);
    const allowed = order?.models ?? [];
    const requested = typeof body['model'] === 'string' ? body['model'] : '';
    const model = allowed.includes(requested) ? requested : allowed[0] ?? '';
    if (!model) {
      this.json(res, 503, { error: { message: '该次数包未绑定可用模型，请联系商家', type: 'relay_internal_error', code: 'no_model' } });
      return;
    }

    let secret: string;
    try {
      secret = await this.ensureKey(rec);
    } catch (err) {
      this.logger.error('biz.key_ensure_failed', { orderId: rec.orderId, error: errText(err) });
      this.json(res, 500, { error: { message: '访问凭证不可用，请稍后重试', type: 'relay_internal_error', code: 'key_create_failed' } });
      return;
    }

    if (!this.reserve(rec.code)) {
      this.json(res, 402, { error: { message: '次数已用完，请联系商家续购', type: 'insufficient_quota', code: 'uses_exhausted' } });
      return;
    }

    const payload: Record<string, unknown> = {
      model,
      messages,
      stream: body['stream'] === true,
    };
    for (const key of ['temperature', 'top_p', 'max_tokens', 'stop']) {
      if (body[key] !== undefined) payload[key] = body[key];
    }
    const rawBody = new Uint8Array(Buffer.from(JSON.stringify(payload), 'utf8'));
    await this.forward(res, req, headers, secret, rawBody, '/v1/chat/completions', rec);
  }

  private async handleImage(req: IncomingMessage, res: ServerResponse, headers: Record<string, string>): Promise<void> {
    const session = this.customerSession(headers);
    if (!session) {
      this.json(res, 401, { error: { message: '会话已过期，请重新扫码', type: 'authentication_error', code: 'session_expired' } });
      return;
    }
    const state = this.codeState(session.code);
    if (!state.ok || !state.record) {
      this.json(res, state.status, { error: { message: state.message ?? '该码不可用', type: 'invalid_request_error', code: 'code_unusable' } });
      return;
    }
    const rec = state.record;
    const body = await this.readJson(req, res);
    if (!body) return;
    const prompt = typeof body['prompt'] === 'string' ? body['prompt'].trim() : '';
    if (!prompt) {
      this.json(res, 400, { error: { message: 'prompt 不能为空', type: 'invalid_request_error', code: 'prompt_required' } });
      return;
    }
    const order = this.store.getOrder(rec.orderId);
    const allowed = order?.models ?? [];
    // 一次调用固定生成 1 张：卖的是「次」，n>1 会让一次扣费产出多张图。
    const model = allowed.find((m) => m.includes('image')) ?? allowed[0] ?? '';
    if (!model) {
      this.json(res, 503, { error: { message: '该次数包未绑定可用模型，请联系商家', type: 'relay_internal_error', code: 'no_model' } });
      return;
    }
    let secret: string;
    try {
      secret = await this.ensureKey(rec);
    } catch (err) {
      this.logger.error('biz.key_ensure_failed', { orderId: rec.orderId, error: errText(err) });
      this.json(res, 500, { error: { message: '访问凭证不可用，请稍后重试', type: 'relay_internal_error', code: 'key_create_failed' } });
      return;
    }
    if (!this.reserve(rec.code)) {
      this.json(res, 402, { error: { message: '次数已用完，请联系商家续购', type: 'insufficient_quota', code: 'uses_exhausted' } });
      return;
    }
    const size = typeof body['size'] === 'string' && /^\d{3,4}x\d{3,4}$/.test(body['size']) ? body['size'] : '1024x1024';
    const payload = { model, prompt: prompt.slice(0, 2000), n: 1, size };
    const rawBody = new Uint8Array(Buffer.from(JSON.stringify(payload), 'utf8'));
    await this.forward(res, req, headers, secret, rawBody, '/v1/images/generations', rec, true);
  }

  /**
   * 转发到引擎并把结果写回客户端。成功（2xx 且流未被掐断）才扣次。
   * 图片响应里的 mock 外链会替换成内联占位图，否则演示页是一排破图。
   */
  private async forward(
    res: ServerResponse,
    req: IncomingMessage,
    headers: Record<string, string>,
    secret: string,
    rawBody: Uint8Array,
    path: string,
    rec: BizCode,
    image = false,
  ): Promise<void> {
    try {
      const out = await this.executeOnce(res, req, headers, secret, rawBody, path, image, rec.code);
      if (out.ok) this.store.incrementUsed(rec.code);
      this.logger.debug('biz.call_done', { orderId: rec.orderId, status: out.status ?? 0, counted: out.ok, path });
    } finally {
      // 无论成败都释放预留：成功时 used 已在同一 tick 内 +1，失败时名额原样退回
      this.release(rec.code);
    }
  }

  /**
   * 单次调引擎并写回响应，不做业务计量。
   * 次数包（forward）与按量付费（handleAgentChat）共用，区别只在外面怎么记账。
   */
  private async executeOnce(
    res: ServerResponse,
    req: IncomingMessage,
    headers: Record<string, string>,
    secret: string,
    rawBody: Uint8Array,
    path: string,
    image = false,
    bizCode?: string,
  ): Promise<{ ok: boolean; status?: number }> {
    const controller = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);
    try {
      const result = await this.engine.handle({
        method: 'POST',
        path,
        headers: {
          authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
          'user-agent': headers['user-agent'] ?? 'biz-portal',
          ...(bizCode ? { 'x-biz-code': bizCode } : {}),
        },
        rawBody,
        signal: controller.signal,
        requestId: `req_biz_${shortId(12)}`,
      });
      const ok = await this.writeEngineResult(res, result, image);
      return { ok, status: result.status };
    } catch (err) {
      this.logger.warn('biz.call_failed', { ...(bizCode ? { bizCode } : {}), error: errText(err) });
      if (!res.headersSent) {
        this.json(res, 502, { error: { message: '上游调用失败，请稍后重试（本次不计次）', type: 'upstream_error', code: 'upstream_error' } });
        return { ok: false, status: 502 };
      }
      if (!res.writableEnded && !res.destroyed) res.destroy();
      return { ok: false };
    } finally {
      res.removeListener('close', onClose);
    }
  }

  private async writeEngineResult(res: ServerResponse, result: EngineResult, image: boolean): Promise<boolean> {
    if (result.kind === 'json') {
      let body = result.body;
      let ok = result.status >= 200 && result.status < 300;
      if (image && ok) {
        try {
          const parsed = JSON.parse(body) as { data?: Array<{ url?: string }> };
          if (!Array.isArray(parsed.data) || parsed.data.length === 0) {
            ok = false;
          } else {
            for (const item of parsed.data) {
              if (typeof item.url === 'string' && item.url.startsWith('https://mock.local/')) item.url = demoImageDataUri(item.url);
            }
            body = JSON.stringify(parsed);
          }
        } catch {
          ok = false;
        }
      }
      for (const [k, v] of Object.entries(result.headers)) {
        try {
          res.setHeader(k, v);
        } catch {
          /* 非法头名忽略 */
        }
      }
      if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
      res.writeHead(result.status);
      res.end(body);
      return ok;
    }

    for (const [k, v] of Object.entries(result.headers)) {
      try {
        res.setHeader(k, v);
      } catch {
        /* ignore */
      }
    }
    res.writeHead(result.status);
    const reader = result.stream.getReader();
    let bytes = 0;
    let aborted = false;
    try {
      for (;;) {
        if (res.destroyed || res.writableEnded) {
          aborted = true;
          break;
        }
        if (result.deadlineAt !== undefined && Date.now() > result.deadlineAt) {
          aborted = true;
          this.logger.warn('biz.stream_deadline', {});
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytes += value.byteLength;
          if (!res.write(Buffer.from(value))) await waitDrain(res);
        }
      }
      if (!res.destroyed) res.end();
    } catch {
      aborted = true;
      if (!res.writableEnded) res.destroy();
    } finally {
      if (aborted) void Promise.resolve(reader.cancel()).catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
      try {
        await result.onEnd({ bytes, aborted, transcriptChars: 0 });
      } catch (err) {
        this.logger.warn('biz.stream_onend_failed', { error: errText(err) });
      }
    }
    return !aborted && result.status >= 200 && result.status < 300;
  }

  /* ============================ 凭证 ============================ */

  /** 码 → relay key 明文（确定性派生，不入库）；懒创建并把 keyId 回填到码上 */
  private async ensureKey(rec: BizCode): Promise<string> {
    const secret = this.keySecret(rec.code);
    const order = this.store.getOrder(rec.orderId);
    const allowedModels = order?.models ?? [];
    const quotaCny = Math.max(0.01, Number(((order?.unitPriceCny ?? 0) * this.business.costCapRatio).toFixed(2)));
    const existing = this.keys.resolveSecret(secret);
    if (existing.found && existing.key) {
      if (existing.status === 'ok') {
        if (rec.keyId !== existing.key.id) this.store.setKeyId(rec.code, existing.key.id);
        return secret;
      }
      const updated = this.keys.update(
        existing.key.id,
        {
          enabled: true,
          expiresAt: rec.expiresAt,
          quotaCny,
          ...(allowedModels.length > 0 ? { allowedModels } : {}),
        },
        'biz',
      );
      if (rec.keyId !== updated.id) this.store.setKeyId(rec.code, updated.id);
      return secret;
    }
    const created = this.keys.create({
      secret,
      label: `biz:${rec.code}`,
      tier: 'standard',
      tenantId: `biz_${rec.orderId}`,
      ...(allowedModels.length > 0 ? { allowedModels } : {}),
      expiresAt: rec.expiresAt,
      quotaCny,
      actor: 'biz',
    });
    if (rec.keyId !== created.record.id) this.store.setKeyId(rec.code, created.record.id);
    return secret;
  }

  private keySecret(code: string): string {
    return `sk_pk_${createHmac('sha256', this.seed).update(`relay-key:${code}`).digest('hex').slice(0, 32)}`;
  }

  private mockLinkToken(orderId: string): string {
    return createHmac('sha256', this.seed).update(`mock-pay:${orderId}`).digest('base64url').slice(0, 24);
  }

  /* ============================ 小工具 ============================ */

  private codeState(code: string): CodeState {
    const rec = this.store.getCode(code);
    if (!rec) return { ok: false, status: 410, message: '核销码不存在，请确认是否扫对了桌贴' };
    if (rec.revokedAt !== undefined) return { ok: false, status: 410, message: '该码已被商家撤销，请联系商家' };
    if (rec.expiresAt <= Date.now()) return { ok: false, status: 410, message: '该码已过期，请联系商家续购' };
    if (rec.usesUsed >= rec.usesTotal) return { ok: false, status: 402, message: '次数已用完，请联系商家续购' };
    return { ok: true, status: 200, record: rec };
  }

  private reserve(code: string): boolean {
    const rec = this.store.getCode(code);
    if (!rec) return false;
    const busy = this.inflight.get(code) ?? 0;
    if (rec.usesUsed + busy >= rec.usesTotal) return false;
    this.inflight.set(code, busy + 1);
    return true;
  }

  private release(code: string): void {
    const busy = this.inflight.get(code) ?? 0;
    if (busy <= 1) this.inflight.delete(code);
    else this.inflight.set(code, busy - 1);
  }

  private sessionInfo(rec: BizCode): Record<string, unknown> {
    const order = this.store.getOrder(rec.orderId);
    return {
      code: rec.code,
      merchantName: rec.merchantName,
      packName: order?.packName ?? 'AI 次数包',
      usesTotal: rec.usesTotal,
      usesUsed: rec.usesUsed,
      remaining: Math.max(0, rec.usesTotal - rec.usesUsed),
      expiresAt: rec.expiresAt,
      models: order?.models ?? [],
    };
  }

  private customerSession(headers: Record<string, string>): ReturnType<SessionSigner['verify']> {
    return this.signer.verify(parseCookie(headers['cookie'], SESSION_COOKIE));
  }

  /**
   * 令牌分辨身份：商家令牌先查（高效防猜测、避免被管理面限流误锁），
   * 其余交给 AdminAuth（含本机无令牌体验模式与失败限流）。
   */
  private actor(req: IncomingMessage, res: ServerResponse, headers: Record<string, string>): Actor | undefined {
    const provided = headers['x-merchant-token'] ?? headers['x-admin-token'] ?? extractBearerToken(headers['authorization']);
    if (provided) {
      const merchant = this.store.findMerchantByTokenHash(hashMerchantToken(provided));
      if (merchant && merchant.disabledAt === undefined) return { kind: 'merchant', merchant };
    }
    const r = this.adminAuth.authorize(req, headers);
    if (r.ok) return { kind: 'admin' };
    this.json(res, 401, { error: { message: r.reason ?? '令牌无效', type: 'authentication_error', code: 'biz_token_invalid' } });
    return undefined;
  }

  private adminOnly(res: ServerResponse, actor: Actor): boolean {
    if (actor.kind === 'admin') return true;
    this.json(res, 403, { error: { message: '该接口仅管理员可用', type: 'permission_error', code: 'admin_required' } });
    return false;
  }

  private canSeeOrder(actor: Actor, order: BizOrder): boolean {
    return actor.kind === 'admin' || order.merchantId === actor.merchant.id;
  }

  private merchantView(m: BizMerchant): Record<string, unknown> {
    const orders = this.store.listOrders(500, m.id);
    return {
      id: m.id,
      name: m.name,
      ...(m.note ? { note: m.note } : {}),
      createdAt: m.createdAt,
      ...(m.disabledAt !== undefined ? { disabledAt: m.disabledAt } : {}),
      orderCount: orders.length,
      paidOrderCount: orders.filter((o) => o.status === 'paid').length,
      revenueCny: orders.reduce((s, o) => s + (o.status === 'paid' ? o.amountCny : 0), 0),
    };
  }

  private async createMerchant(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req, res);
    if (!body) return;
    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    if (!name || name.length > 60) {
      this.json(res, 400, { error: { message: '商家名称需为 1~60 个字符', type: 'invalid_request_error', code: 'invalid_merchant_name' } });
      return;
    }
    const note = typeof body['note'] === 'string' ? body['note'].trim().slice(0, 120) : '';
    const now = Date.now();
    let id = shortId(10, 'mch');
    while (this.store.getMerchant(id)) id = shortId(10, 'mch');
    const token = newMerchantToken();
    this.store.createMerchant({
      id,
      name,
      tokenHash: hashMerchantToken(token),
      ...(note ? { note } : {}),
      createdAt: now,
    });
    const created = this.store.getMerchant(id);
    if (!created) {
      this.json(res, 500, { error: { message: '商家创建失败', type: 'relay_internal_error', code: 'merchant_create_failed' } });
      return;
    }
    this.logger.info('biz.merchant_created', { merchantId: id });
    this.json(res, 200, {
      merchant: this.merchantView(created),
      token,
      consolePath: `/biz?t=${encodeURIComponent(token)}`,
    });
  }

  private merchantAction(res: ServerResponse, id: string, action: 'rotate' | 'disable' | 'enable'): void {
    const merchant = this.store.getMerchant(id);
    if (!merchant) {
      this.json(res, 404, { error: { message: '商家不存在', type: 'not_found_error', code: 'merchant_not_found' } });
      return;
    }
    if (action === 'rotate') {
      const token = newMerchantToken();
      this.store.rotateMerchantToken(id, hashMerchantToken(token));
      const latest = this.store.getMerchant(id);
      this.logger.info('biz.merchant_token_rotated', { merchantId: id });
      this.json(res, 200, {
        ok: true,
        merchant: latest ? this.merchantView(latest) : this.merchantView(merchant),
        token,
        consolePath: `/biz?t=${encodeURIComponent(token)}`,
      });
      return;
    }
    const changed = action === 'disable' ? this.store.disableMerchant(id, Date.now()) : this.store.enableMerchant(id);
    const latest = this.store.getMerchant(id);
    this.logger.info(`biz.merchant_${action}`, { merchantId: id, changed });
    this.json(res, 200, { ok: true, changed, merchant: latest ? this.merchantView(latest) : this.merchantView(merchant) });
  }

  private orderView(order: BizOrder): Record<string, unknown> {
    return {
      id: order.id,
      ...(order.merchantId ? { merchantId: order.merchantId } : {}),
      merchantName: order.merchantName,
      packId: order.packId,
      packName: order.packName,
      quantity: order.quantity,
      unitPriceCny: order.unitPriceCny,
      amountCny: order.amountCny,
      usesTotal: order.usesTotal,
      validDays: order.validDays,
      models: order.models,
      status: order.status,
      provider: order.provider,
      createdAt: order.createdAt,
      ...(order.paidAt !== undefined ? { paidAt: order.paidAt } : {}),
      codes: this.store.listCodesByOrder(order.id).map((c) => this.codeView(c)),
    };
  }

  private codeView(rec: BizCode, url?: URL): Record<string, unknown> {
    return {
      code: rec.code,
      orderId: rec.orderId,
      packId: rec.packId,
      merchantName: rec.merchantName,
      usesTotal: rec.usesTotal,
      usesUsed: rec.usesUsed,
      remaining: Math.max(0, rec.usesTotal - rec.usesUsed),
      createdAt: rec.createdAt,
      expiresAt: rec.expiresAt,
      ...(rec.revokedAt !== undefined ? { revokedAt: rec.revokedAt } : {}),
      ...(rec.firstSeenAt !== undefined ? { firstSeenAt: rec.firstSeenAt } : {}),
      scanPath: `/s/${rec.code}`,
      ...(url ? { scanUrl: `${this.publicBase(url, undefined)}/s/${rec.code}` } : {}),
    };
  }

  /* ---------- HTTP 基元 ---------- */

  private serveQr(res: ServerResponse, rawCode: string, headers: Record<string, string>): void {
    const code = normalizeCode(rawCode);
    if (!code || !this.store.getCode(code)) {
      this.text(res, 404, '二维码对应的核销码不存在');
      return;
    }
    const base = this.business.publicBaseUrl ?? `http://${headers['host'] ?? 'localhost'}`;
    const svg = qrSvg(`${base.replace(/\/+$/, '')}/s/${code}`);
    res.writeHead(200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=300',
    });
    res.end(svg);
  }

  private async serveMockCheckout(res: ServerResponse, orderId: string, url: URL): Promise<void> {
    const order = this.store.getOrder(orderId);
    if (!order) {
      this.html(res, 404, errorPage('订单不存在', '请回商家台重新发起支付。'));
      return;
    }
    if (order.status === 'paid') {
      res.writeHead(302, { location: `/biz?paid=${encodeURIComponent(order.id)}` });
      res.end();
      return;
    }
    const token = url.searchParams.get('t') ?? '';
    if (this.payment.id !== 'mock' || !safeEqual(token, this.mockLinkToken(order.id))) {
      this.html(res, 403, errorPage('支付链接无效', '请回商家台重新发起支付。'));
      return;
    }
    this.html(res, 200, payHtml(order.id, token, order.amountCny, `${order.packName} × ${order.quantity}`));
  }

  private servePrint(res: ServerResponse, orderId: string, actor: Actor): void {
    const order = this.store.getOrder(orderId);
    if (!order || !this.canSeeOrder(actor, order)) {
      this.html(res, 404, errorPage('订单不存在', '请刷新商家台后重试。'));
      return;
    }
    const codes = this.store.listCodesByOrder(order.id);
    if (codes.length === 0) {
      this.html(res, 409, errorPage('还没有核销码', '订单支付成功后才会出码。'));
      return;
    }
    const pack = findPack(this.packs, order.packId);
    this.html(res, 200, printHtml(order, codes, pack));
  }

  private publicBase(url: URL, headers?: Record<string, string>): string {
    if (this.business.publicBaseUrl) return this.business.publicBaseUrl.replace(/\/+$/, '');
    const host = headers?.['host'] ?? url.host;
    return `${url.protocol}//${host}`.replace(/\/+$/, '');
  }

  private isHttps(headers: Record<string, string>, url: URL): boolean {
    if (headers['x-forwarded-proto'] === 'https') return true;
    if (this.business.publicBaseUrl?.startsWith('https://')) return true;
    return url.protocol === 'https:';
  }

  private html(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  }

  private text(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  }

  private async readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
    const raw = await this.readRaw(req, res, this.opts.config.server.maxBodyBytes);
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not object');
      return parsed as Record<string, unknown>;
    } catch {
      this.json(res, 400, { error: { message: '请求体必须是 JSON 对象', type: 'invalid_request_error', code: 'invalid_json' } });
      return undefined;
    }
  }

  private async readRaw(req: IncomingMessage, res: ServerResponse, limit: number): Promise<string | undefined> {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        const buf = chunk as Buffer;
        total += buf.byteLength;
        if (total > limit) {
          req.destroy();
          this.json(res, 413, { error: { message: `请求体超过上限 ${limit} 字节`, type: 'request_too_large', code: 'request_too_large' } });
          return undefined;
        }
        chunks.push(buf);
      }
    } catch {
      if (!res.headersSent) this.json(res, 400, { error: { message: '读取请求体失败', type: 'invalid_request_error', code: 'body_read_failed' } });
      return undefined;
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function newOrderId(now: number): string {
  return `ord_${now.toString(36)}${randomBytes(3).toString('hex')}`;
}

function newMerchantToken(): string {
  return `mch_${randomBytes(24).toString('base64url')}`;
}

function hashMerchantToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 管理面与商家面共用：X-Admin-Token / X-Merchant-Token / Authorization: Bearer */
function extractBearerToken(header?: string): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : header.trim();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
}

/** 金额按分比较：verify 返回的是字符串元，浮点直接 !== 会把 0.01 判成不等 */
function amountEquals(a: number | undefined, b: number): boolean {
  if (a === undefined || !Number.isFinite(a)) return false;
  return Math.round(a * 100) === Math.round(b * 100);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

async function waitDrain(res: ServerResponse): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      res.off('error', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
    res.once('error', done);
  });
}

const DEMO_COLORS: ReadonlyArray<readonly [string, string]> = [
  ['#1677ff', '#7cc4ff'],
  ['#7c3aed', '#f0abfc'],
  ['#0f9d58', '#a7f3d0'],
  ['#ea580c', '#fdba74'],
];

/** mock 上游返回的是假 URL；替换成同色系的内联占位图，演示页才不是一排破图 */
function demoImageDataUri(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const pair = DEMO_COLORS[h % DEMO_COLORS.length] ?? DEMO_COLORS[0]!;
  const [from, to] = pair;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
    `</linearGradient></defs>` +
    `<rect width="512" height="512" fill="url(#g)"/>` +
    `<circle cx="256" cy="206" r="88" fill="rgba(255,255,255,.38)"/>` +
    `<path d="M0 392 Q128 300 256 372 T512 332 V512 H0 Z" fill="rgba(255,255,255,.28)"/>` +
    `<text x="256" y="472" font-family="sans-serif" font-size="24" fill="#ffffff" text-anchor="middle" opacity="0.9">演示图 · mock</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
