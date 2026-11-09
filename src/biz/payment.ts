/**
 * 支付适配层。
 *
 * 接口只暴露两件事：下单拿支付入口、验异步通知。
 * mock 用于本地完整演示；alipay 走当面付预下单（alipay.trade.precreate）+ 异步通知验签，
 * 签名/验签全部用 node:crypto，不引入 SDK，保持零运行时依赖。
 *
 * 真实沙箱联调需要商家 APPID 与密钥（配置里只允许 {ENV:...} 插值），
 * 在拿到密钥前，这里能证明的是「请求参数与签名可被公钥验过、通知校验与幂等都成立」，
 * 不能证明支付宝侧真的收了钱——文档里必须如实这么写。
 */

import { createPrivateKey, createPublicKey, createSign, createVerify, type KeyObject } from 'node:crypto';

export interface PaymentOrderInput {
  id: string;
  amountCny: number;
  subject: string;
}

export interface PaymentIntent {
  /** qr = 需要展示二维码让商家扫；redirect = 直接打开一个收银台页面 */
  kind: 'qr' | 'redirect';
  /** 二维码内容或收银台 URL */
  payUrl: string;
  providerTradeNo?: string;
}

export interface NotifyResult {
  ok: boolean;
  orderId?: string;
  tradeNo?: string;
  amountCny?: number;
  reason?: string;
}

export interface PaymentProvider {
  readonly id: 'mock' | 'alipay';
  createPayment(order: PaymentOrderInput): Promise<PaymentIntent>;
  verifyNotify(rawBody: string): Promise<NotifyResult>;
}

/* ------------------------------------------------------------------ *
 * mock
 * ------------------------------------------------------------------ */

export class MockPaymentProvider implements PaymentProvider {
  readonly id = 'mock' as const;

  constructor(private readonly linkToken: (orderId: string) => string) {}

  async createPayment(order: PaymentOrderInput): Promise<PaymentIntent> {
    return { kind: 'redirect', payUrl: `/pay/${encodeURIComponent(order.id)}?t=${encodeURIComponent(this.linkToken(order.id))}` };
  }

  async verifyNotify(): Promise<NotifyResult> {
    return { ok: false, reason: 'mock 支付没有异步通知，请在收银台点击完成支付' };
  }
}

/* ------------------------------------------------------------------ *
 * alipay
 * ------------------------------------------------------------------ */

export interface AlipayProviderOptions {
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  gateway: string;
  notifyUrl: string;
  sellerId?: string;
}

interface AlipayResponse {
  code?: string;
  msg?: string;
  sub_code?: string;
  sub_msg?: string;
  qr_code?: string;
  out_trade_no?: string;
  trade_no?: string;
}

export class AlipayProvider implements PaymentProvider {
  readonly id = 'alipay' as const;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(private readonly opts: AlipayProviderOptions) {
    this.privateKey = privateKeyFromBase64(opts.privateKey);
    this.publicKey = publicKeyFromBase64(opts.alipayPublicKey);
  }

  async createPayment(order: PaymentOrderInput): Promise<PaymentIntent> {
    const params: Record<string, string> = {
      app_id: this.opts.appId,
      method: 'alipay.trade.precreate',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: formatTimestamp(new Date()),
      version: '1.0',
      notify_url: this.opts.notifyUrl,
      biz_content: JSON.stringify({
        out_trade_no: order.id,
        total_amount: order.amountCny.toFixed(2),
        subject: order.subject,
        timeout_express: '30m',
        ...(this.opts.sellerId ? { seller_id: this.opts.sellerId } : {}),
      }),
    };
    params['sign'] = rsa2Sign(params, this.privateKey);
    const res = await fetch(this.opts.gateway, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`支付宝网关 HTTP ${res.status}: ${text.slice(0, 200)}`);
    let parsed: { alipay_trade_precreate_response?: AlipayResponse } & AlipayResponse;
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new Error(`支付宝网关返回非 JSON: ${text.slice(0, 200)}`);
    }
    const body = parsed.alipay_trade_precreate_response ?? parsed;
    if (body.code !== '10000' || !body.qr_code) {
      throw new Error(`支付宝预下单失败: ${body.sub_code ?? body.code ?? 'unknown'} ${body.sub_msg ?? body.msg ?? ''}`.trim());
    }
    return { kind: 'qr', payUrl: body.qr_code, ...(body.out_trade_no ? { providerTradeNo: body.out_trade_no } : {}) };
  }

  async verifyNotify(rawBody: string): Promise<NotifyResult> {
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(rawBody)) params[k] = v;
    const sign = params['sign'];
    if (!sign) return { ok: false, reason: '通知缺少 sign' };
    if (!rsa2Verify(params, sign, this.publicKey)) return { ok: false, reason: '通知验签失败' };
    if (params['app_id'] !== this.opts.appId) return { ok: false, reason: 'app_id 不匹配' };
    const status = params['trade_status'];
    if (status !== 'TRADE_SUCCESS' && status !== 'TRADE_FINISHED') {
      return { ok: false, reason: `交易状态不是成功: ${status ?? 'unknown'}` };
    }
    const amount = Number(params['total_amount']);
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: '通知金额非法' };
    return {
      ok: true,
      orderId: params['out_trade_no'] ?? '',
      tradeNo: params['trade_no'] ?? '',
      amountCny: amount,
    };
  }
}

/* ------------------------------------------------------------------ *
 * RSA2 工具
 * ------------------------------------------------------------------ */

export function rsa2Sign(params: Record<string, string>, key: KeyObject): string {
  const signer = createSign('RSA-SHA256');
  signer.update(signContent(params));
  signer.end();
  return signer.sign(key, 'base64');
}

export function rsa2Verify(params: Record<string, string>, sign: string, key: KeyObject): boolean {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(signContent(params));
  verifier.end();
  try {
    return verifier.verify(key, sign, 'base64');
  } catch {
    return false;
  }
}

/** 参与签名的原文：去掉 sign 与空值，按 key 字典序拼 k=v&k=v */
export function signContent(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

export function privateKeyFromBase64(input: string): KeyObject {
  const body = input.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  for (const type of ['PRIVATE KEY', 'RSA PRIVATE KEY'] as const) {
    try {
      return createPrivateKey({ key: pem(type, body), format: 'pem' });
    } catch {
      /* 试下一种 */
    }
  }
  try {
    return createPrivateKey({ key: Buffer.from(body, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    return createPrivateKey({ key: Buffer.from(body, 'base64'), format: 'der', type: 'pkcs1' });
  }
}

export function publicKeyFromBase64(input: string): KeyObject {
  const body = input.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  for (const type of ['PUBLIC KEY', 'RSA PUBLIC KEY'] as const) {
    try {
      return createPublicKey({ key: pem(type, body), format: 'pem' });
    } catch {
      /* 试下一种 */
    }
  }
  try {
    return createPublicKey({ key: Buffer.from(body, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return createPublicKey({ key: Buffer.from(body, 'base64'), format: 'der', type: 'pkcs1' });
  }
}

function pem(type: string, body: string): string {
  const wrapped = body.replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${type}-----\n${wrapped}\n-----END ${type}-----`;
}

function formatTimestamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  // 支付宝要求 Asia/Shanghai 时间；服务器时区不可控，这里按 UTC+8 手算。
  const t = new Date(d.getTime() + 8 * 3_600_000);
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}
