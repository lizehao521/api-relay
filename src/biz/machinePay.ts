/**
 * AI 按量付费（支付宝 Machine Pay / HTTP 402）。
 *
 * 协议（与支付宝文档一致）：
 *   1. 调用方没有 `Payment-Proof` → 预下单，返回 402 + `amtPaymentLink: <amt_pre_pay_id>`；
 *   2. 调用方支付后带 `Payment-Proof` 重试 → 调 verify，核对 active / amount /
 *      out_trade_no / trade_no / resource_id；
 *   3. 全部对上才交付资源。
 *
 * 两条刻意的安全边界：
 *   - **响应必须验签**。放行资源的判据是 verify 的业务字段，不是 HTTP 200；
 *     只信响应体而不验签，等于把「谁付了钱」交给一个可被替换的响应。
 *   - `payment_proof` 只当凭据传递，不落库；落库的是支付宝订单号与商户订单号。
 */

import { createHmac, createVerify, type KeyObject } from 'node:crypto';
import { privateKeyFromBase64, publicKeyFromBase64, rsa2Sign } from './payment.js';
import { timeSafeEqual } from '../util/index.js';

export interface MachinePayPrecreateInput {
  outTradeNo: string;
  amountCny: number;
  goodsName: string;
  serviceId: string;
  /** ISO-8601 +08:00，支付宝要求不超过当前时间 12 小时 */
  payBefore: string;
  memo?: string;
}

export interface MachinePayVerifyInput {
  tradeNo: string;
  paymentProof: string;
  clientSession?: string;
}

export interface MachinePayVerifyResult {
  /** 接口调用成功且响应验签通过；业务字段仍要由调用方逐项核对 */
  ok: boolean;
  active?: boolean;
  amountCny?: number;
  outTradeNo?: string;
  resourceId?: string;
  tradeNo?: string;
  reason?: string;
  /**
   * 验签层/传输层故障（网关 5xx、响应未签名、超时）。
   * 这不该让调用方以为自己的凭证无效，错误码按上游故障回 502。
   */
  upstreamError?: boolean;
}

export interface MachinePayProvider {
  readonly id: 'mock' | 'alipay';
  precreate(input: MachinePayPrecreateInput): Promise<{ amtPrePayId: string }>;
  verify(input: MachinePayVerifyInput): Promise<MachinePayVerifyResult>;
}

/* ------------------------------------------------------------------ *
 * Payment-Proof
 * ------------------------------------------------------------------ */

export interface PaymentProof {
  tradeNo: string;
  paymentProof: string;
  clientSession?: string;
}

/**
 * 解析 `Payment-Proof`：Base64(JSON)，结构见支付宝文档
 * `{ protocol: { payment_proof, trade_no }, method?: { client_session } }`。
 * 解析失败一律返回 undefined，不做「尽量猜」——猜错就是把坏凭证当凭证。
 */
export function parsePaymentProof(raw: string | undefined): PaymentProof | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  if (!text || text.length > 8192) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const protocol = parsed['protocol'];
  if (!isRecord(protocol)) return undefined;
  const tradeNo = protocol['trade_no'];
  const paymentProof = protocol['payment_proof'];
  if (typeof tradeNo !== 'string' || !tradeNo || tradeNo.length > 64) return undefined;
  if (typeof paymentProof !== 'string' || !paymentProof || paymentProof.length > 4096) return undefined;
  const method = parsed['method'];
  const clientSession = isRecord(method) && typeof method['client_session'] === 'string' ? method['client_session'] : undefined;
  return {
    tradeNo,
    paymentProof,
    ...(clientSession && clientSession.length <= 4096 ? { clientSession } : {}),
  };
}

/** 构造标准 Payment-Proof 请求头值（mock 演示与测试共用） */
export function encodePaymentProof(proof: PaymentProof): string {
  return Buffer.from(
    JSON.stringify({
      protocol: { payment_proof: proof.paymentProof, trade_no: proof.tradeNo },
      ...(proof.clientSession ? { method: { client_session: proof.clientSession } } : {}),
    }),
    'utf8',
  ).toString('base64');
}

/* ------------------------------------------------------------------ *
 * mock（本地演示 / 测试）
 * ------------------------------------------------------------------ */

/**
 * mock 不是「假支付」，而是把支付宝替换成一把本地 HMAC 钥匙：
 * 凭证仍然由服务端签发、仍要过 verify，链路与真实模式一致。
 */
export class MockMachinePayProvider implements MachinePayProvider {
  readonly id = 'mock' as const;

  constructor(private readonly secret: string) {}

  async precreate(input: MachinePayPrecreateInput): Promise<{ amtPrePayId: string }> {
    return { amtPrePayId: `amtpp_mock_${input.outTradeNo}` };
  }

  async verify(input: MachinePayVerifyInput): Promise<MachinePayVerifyResult> {
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(input.paymentProof, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, reason: 'mock 支付凭证格式不正确' };
    }
    if (!isRecord(payload)) return { ok: false, reason: 'mock 支付凭证格式不正确' };
    const outTradeNo = payload['out_trade_no'];
    const amount = payload['amount'];
    const tradeNo = payload['trade_no'];
    const sig = payload['sig'];
    if (typeof outTradeNo !== 'string' || typeof amount !== 'string' || typeof tradeNo !== 'string' || typeof sig !== 'string') {
      return { ok: false, reason: 'mock 支付凭证字段不全' };
    }
    if (!timeSafeEqual(sig, this.sign(outTradeNo, amount, tradeNo))) {
      return { ok: false, reason: 'mock 支付凭证签名不正确' };
    }
    if (tradeNo !== input.tradeNo) return { ok: false, reason: 'mock 支付凭证与交易号不一致' };
    const amountCny = Number(amount);
    if (!Number.isFinite(amountCny) || amountCny <= 0) return { ok: false, reason: 'mock 支付金额非法' };
    return { ok: true, active: true, amountCny, outTradeNo, tradeNo };
  }

  /** 生成一份完整的 `Payment-Proof` 请求头值 */
  makeProof(outTradeNo: string, amountCny: number, tradeNo: string): string {
    const amount = amountCny.toFixed(2);
    const inner = Buffer.from(
      JSON.stringify({ out_trade_no: outTradeNo, amount, trade_no: tradeNo, sig: this.sign(outTradeNo, amount, tradeNo) }),
      'utf8',
    ).toString('base64url');
    return encodePaymentProof({ tradeNo, paymentProof: inner, clientSession: 'mock-client' });
  }

  private sign(outTradeNo: string, amount: string, tradeNo: string): string {
    return createHmac('sha256', this.secret).update(`${outTradeNo}|${amount}|${tradeNo}`).digest('base64url');
  }
}

/* ------------------------------------------------------------------ *
 * alipay
 * ------------------------------------------------------------------ */

export interface AlipayMachinePayOptions {
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  gateway: string;
}

interface AlipayNode {
  [key: string]: unknown;
}

export class AlipayMachinePayProvider implements MachinePayProvider {
  readonly id = 'alipay' as const;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(private readonly opts: AlipayMachinePayOptions) {
    this.privateKey = privateKeyFromBase64(opts.privateKey);
    this.publicKey = publicKeyFromBase64(opts.alipayPublicKey);
  }

  async precreate(input: MachinePayPrecreateInput): Promise<{ amtPrePayId: string }> {
    const node = await this.call(
      'alipay.aipay.agent.payment.precreate',
      {
        pay_before: input.payBefore,
        amount: input.amountCny.toFixed(2),
        goods_name: input.goodsName.slice(0, 32),
        service_id: input.serviceId,
        out_trade_no: input.outTradeNo,
        currency: 'CNY',
        ...(input.memo ? { memo: input.memo.slice(0, 32) } : {}),
      },
      'alipay_aipay_agent_payment_precreate_response',
    );
    const id = node['amt_pre_pay_id'];
    if (node['code'] !== '10000' || typeof id !== 'string' || !id) {
      throw new Error(`按量付费预下单失败: ${text(node['sub_code']) ?? text(node['code']) ?? 'unknown'} ${text(node['sub_msg']) ?? text(node['msg']) ?? ''}`.trim());
    }
    return { amtPrePayId: id };
  }

  async verify(input: MachinePayVerifyInput): Promise<MachinePayVerifyResult> {
    let node: AlipayNode;
    try {
      node = await this.call(
        'alipay.aipay.agent.payment.verify',
        {
          trade_no: input.tradeNo,
          payment_proof: input.paymentProof,
          ...(input.clientSession ? { client_session: input.clientSession } : {}),
        },
        'alipay_aipay_agent_payment_verify_response',
      );
    } catch (err) {
      return { ok: false, upstreamError: true, reason: err instanceof Error ? err.message : String(err) };
    }
    if (node['code'] !== '10000') {
      return { ok: false, reason: `支付凭证验证失败: ${text(node['sub_code']) ?? text(node['code']) ?? 'unknown'} ${text(node['sub_msg']) ?? text(node['msg']) ?? ''}`.trim() };
    }
    const amount = Number(node['amount']);
    return {
      ok: true,
      active: node['active'] === true || node['active'] === 'true',
      ...(Number.isFinite(amount) ? { amountCny: amount } : {}),
      ...(typeof node['out_trade_no'] === 'string' ? { outTradeNo: node['out_trade_no'] } : {}),
      ...(typeof node['resource_id'] === 'string' ? { resourceId: node['resource_id'] } : {}),
      ...(typeof node['trade_no'] === 'string' ? { tradeNo: node['trade_no'] } : {}),
    };
  }

  private async call(method: string, biz: Record<string, string>, responseNode: string): Promise<AlipayNode> {
    const params: Record<string, string> = {
      app_id: this.opts.appId,
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: formatTimestamp(new Date()),
      version: '1.0',
      biz_content: JSON.stringify(biz),
    };
    params['sign'] = rsa2Sign(params, this.privateKey);
    const res = await fetch(this.opts.gateway, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`支付宝网关 HTTP ${res.status}: ${raw.slice(0, 200)}`);
    let parsed: AlipayNode;
    try {
      parsed = JSON.parse(raw) as AlipayNode;
    } catch {
      throw new Error(`支付宝网关返回非 JSON: ${raw.slice(0, 200)}`);
    }
    const sign = parsed['sign'];
    const nodeRaw = extractJsonNode(raw, responseNode);
    if (typeof sign !== 'string' || !sign || !nodeRaw) {
      throw new Error('支付宝响应缺少 sign 或业务节点，拒绝采信');
    }
    if (!verifyRawNode(nodeRaw, sign, this.publicKey)) {
      throw new Error('支付宝响应验签失败');
    }
    const node = parsed[responseNode];
    if (!isRecord(node)) throw new Error(`支付宝响应缺少 ${responseNode}`);
    return node;
  }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/**
 * 从原始响应文本里取出业务节点的**原始 JSON 子串**。
 * 支付宝同步响应的签名对象就是这段原文（不是重新序列化后的对象），
 * 所以必须按字符扫描，不能 `JSON.stringify(parsed[node])`——键序/空白都会变。
 */
export function extractJsonNode(text: string, nodeName: string): string | undefined {
  const key = `"${nodeName}"`;
  const at = text.indexOf(key);
  if (at < 0) return undefined;
  let colon = text.indexOf(':', at + key.length);
  if (colon < 0) return undefined;
  while (colon + 1 < text.length && /\s/.test(text[colon + 1]!)) colon++;
  if (text[colon + 1] !== '{') return undefined;
  const start = colon + 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

export function verifyRawNode(rawNode: string, sign: string, key: KeyObject): boolean {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(rawNode);
  verifier.end();
  try {
    return verifier.verify(key, sign, 'base64');
  } catch {
    return false;
  }
}

/** ISO-8601 +08:00（支付宝 pay_before 的格式要求） */
export function formatPayBefore(ms: number): string {
  const t = new Date(ms + 8 * 3_600_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+08:00`;
}

function formatTimestamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const t = new Date(d.getTime() + 8 * 3_600_000);
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
