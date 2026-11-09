/**
 * AI 按量付费（支付宝 Machine Pay / HTTP 402）测试。
 *
 * 守的边界：
 *   1. mock 全链路：402 → 演示支付 → Payment-Proof → 才允许打到上游；
 *   2. 金额 / 订单号不符、凭证重放、上游失败后同一凭证重试；
 *   3. 支付宝适配器：请求签名可被网关验过、响应验签、未签名响应绝不采信；
 *   4. 订单状态机跨 SQLite 重启，同一 trade_no 只能履约一次。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac, createSign, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, memoryConfig, type App } from '../app.js';
import { MockUpstream } from '../mock/upstream.js';
import { Logger } from '../core/logger.js';
import type { AlipayConfig, BusinessConfig, MachinePayConfig, ProviderConfig } from '../core/types.js';
import { SqliteBizStore } from '../biz/store.js';
import { rsa2Verify } from '../biz/payment.js';
import {
  MockMachinePayProvider,
  encodePaymentProof,
  extractJsonNode,
  parsePaymentProof,
} from '../biz/machinePay.js';
import { rmTmp } from './testcleanup.js';

const silent = new Logger('error', () => undefined);
const ADMIN = 'machine-pay-admin';

interface Harness {
  app: App;
  mock: MockUpstream;
  base: string;
  close: () => Promise<void>;
}

async function harness(opts: {
  machinePay?: Partial<MachinePayConfig>;
  alipay?: AlipayConfig;
  autoRetry?: number;
} = {}): Promise<Harness> {
  const mock = new MockUpstream({ port: 0, logger: silent });
  const bound = await mock.listen();
  const providers: ProviderConfig[] = [
    {
      id: 'mock',
      label: 'mock 上游',
      protocol: 'openai',
      baseUrl: bound.url,
      apiKey: 'mock-key',
      models: ['mock-small'],
      priority: 10,
    },
  ];
  const business: BusinessConfig = {
    enabled: true,
    merchantName: '按次测试',
    sessionTtlHours: 12,
    costCapRatio: 0.9,
    packs: [{ id: 'chat-3', name: '对话 3 次', uses: 3, priceCny: 3, models: ['mock-small'], validDays: 30 }],
    payments: opts.alipay ? { provider: 'mock', alipay: opts.alipay } : { provider: 'mock' },
    machinePay: {
      enabled: true,
      provider: 'mock',
      serviceId: 'API-TEST',
      priceCny: 0.01,
      goodsName: 'AI 调用（每次）',
      payBeforeMinutes: 10,
      models: ['mock-small'],
      ...opts.machinePay,
    },
  };
  const config = memoryConfig({ providers, business, logLevel: 'error' });
  config.server.adminToken = ADMIN;
  if (opts.autoRetry !== undefined) config.lossReduction.attribution.autoRetry = opts.autoRetry;
  const app = await createApp(config, silent);
  const start = await app.start();
  return {
    app,
    mock,
    base: start.url,
    close: async () => {
      await app.shutdown();
      await mock.close();
    },
  };
}

interface ChatRes {
  status: number;
  text: string;
  json: any;
  headers: { get(name: string): string | null };
}

async function chat(h: Harness, headers: Record<string, string> = {}): Promise<ChatRes> {
  const res = await fetch(`${h.base}/agent/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json, headers: res.headers };
}

async function demoPay(h: Harness, mockPayUrl: string): Promise<{ paymentProof: string; tradeNo: string }> {
  const res = await fetch(new URL(mockPayUrl, h.base));
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text) as { paymentProof: string; tradeNo: string };
  assert.ok(body.paymentProof);
  assert.ok(body.tradeNo);
  return body;
}

function chatCalls(h: Harness): number {
  return h.mock.received.filter((r) => r.path.endsWith('/chat/completions')).length;
}

/** 与服务端相同的 seed 推导（只用于测试里替调用方签 mock 凭证） */
function bizSeed(adminToken: string, storagePath: string): string {
  return createHmac('sha256', 'api-relay-biz-v1').update(adminToken).update('|').update(storagePath).digest('hex');
}

/* ------------------------------------------------------------------ *
 * 1. mock 全链路
 * ------------------------------------------------------------------ */

test('machine pay: 402 → 演示支付 → 凭证重试，未支付不得打到上游', async () => {
  const h = await harness();
  try {
    const first = await chat(h);
    assert.equal(first.status, 402, first.text);
    assert.match(first.headers.get('amtPaymentLink') ?? '', /^amtpp_mock_mp_/);
    assert.equal(first.json.error.code, 'payment_required');
    const payment = first.json.payment as { outTradeNo: string; amountCny: number; mockPayUrl: string; payBefore: string };
    assert.equal(payment.amountCny, 0.01);
    assert.match(payment.payBefore, /\+08:00$/);
    assert.match(payment.mockPayUrl, /^\/agent\/mock-pay\?/);
    assert.equal(chatCalls(h), 0, '未支付不得打到上游');

    // 再次无凭证：复用同一张待付单，不刷单
    const second = await chat(h);
    assert.equal(second.status, 402);
    assert.equal(second.json.payment.outTradeNo, payment.outTradeNo);
    assert.equal(second.headers.get('amtPaymentLink'), first.headers.get('amtPaymentLink'));

    const cred = await demoPay(h, payment.mockPayUrl);
    const ok = await chat(h, { 'Payment-Proof': cred.paymentProof });
    assert.equal(ok.status, 200, ok.text);
    assert.match(ok.text, /mock 上游/);
    assert.equal(chatCalls(h), 1);

    // 同一凭证重放：已 consumed，拒绝且不再打上游
    const replay = await chat(h, { 'Payment-Proof': cred.paymentProof });
    assert.equal(replay.status, 402);
    assert.equal(replay.json.error.code, 'payment_trade_used');
    assert.equal(chatCalls(h), 1);

    // 履约完成后再来：开新单
    const third = await chat(h);
    assert.equal(third.status, 402);
    assert.notEqual(third.json.payment.outTradeNo, payment.outTradeNo);
  } finally {
    await h.close();
  }
});

test('machine pay: 金额不符 / 订单不存在 / 凭证格式非法一律 402 且不打上游', async () => {
  const h = await harness();
  try {
    const first = await chat(h);
    assert.equal(first.status, 402);
    const outTradeNo: string = first.json.payment.outTradeNo;
    const provider = new MockMachinePayProvider(bizSeed(ADMIN, ':memory:'));

    const wrongAmount = await chat(h, { 'Payment-Proof': provider.makeProof(outTradeNo, 0.02, 'mock_trade_amount') });
    assert.equal(wrongAmount.status, 402);
    assert.equal(wrongAmount.json.error.code, 'payment_amount_mismatch');

    const missingOrder = await chat(h, { 'Payment-Proof': provider.makeProof('mp_missing', 0.01, 'mock_trade_missing') });
    assert.equal(missingOrder.status, 402);
    assert.equal(missingOrder.json.error.code, 'payment_order_mismatch');

    const malformed = await chat(h, { 'Payment-Proof': 'this-is-not-a-proof' });
    assert.equal(malformed.status, 402);
    assert.equal(malformed.json.error.code, 'payment_proof_invalid');

    assert.equal(chatCalls(h), 0);
  } finally {
    await h.close();
  }
});

test('machine pay: 上游失败不计履约，同一凭证可以重试', async () => {
  const h = await harness({ autoRetry: 0 });
  try {
    const first = await chat(h);
    const payment = first.json.payment as { mockPayUrl: string };
    const cred = await demoPay(h, payment.mockPayUrl);

    h.mock.setForcedScenario({ status: 500, body: { error: { message: 'boom' } } });
    const failed = await chat(h, { 'Payment-Proof': cred.paymentProof });
    assert.ok(failed.status >= 500, `期望上游失败，实际 ${failed.status}`);

    h.mock.setForcedScenario(undefined);
    const retry = await chat(h, { 'Payment-Proof': cred.paymentProof });
    assert.equal(retry.status, 200, retry.text);
    assert.match(retry.text, /mock 上游/);
    assert.equal(chatCalls(h), 2, '失败那次也打到了上游，重试成功再打一次');

    const after = await chat(h, { 'Payment-Proof': cred.paymentProof });
    assert.equal(after.status, 402);
    assert.equal(after.json.error.code, 'payment_trade_used');
    assert.equal(chatCalls(h), 2);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * 2. 支付宝适配器
 * ------------------------------------------------------------------ */

interface Keys {
  priv: string;
  pub: string;
  privKey: KeyObject;
  pubKey: KeyObject;
}

function keyPair(): Keys {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    priv: privateKey,
    pub: publicKey,
    privKey: createPrivateKey(privateKey),
    pubKey: createPublicKey(publicKey),
  };
}

function signRaw(text: string, key: KeyObject): string {
  const signer = createSign('RSA-SHA256');
  signer.update(text);
  signer.end();
  return signer.sign(key, 'base64');
}

test('machine pay: 支付宝预下单签名/响应验签/金额与重放全断言', async () => {
  const keys = keyPair();
  const precreateSeen: Record<string, string>[] = [];
  let verifyMode: 'ok' | 'amount_mismatch' | 'unsigned' = 'ok';
  let verifyCalls = 0;
  let lastOutTradeNo = '';

  const gateway = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) params[k] = v;
    if (!rsa2Verify(params, params['sign'] ?? '', keys.pubKey)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request sign' }));
      return;
    }
    const biz = JSON.parse(params['biz_content'] ?? '{}') as Record<string, string>;
    let nodeName: string;
    let node: string;
    if (params['method'] === 'alipay.aipay.agent.payment.precreate') {
      precreateSeen.push(biz);
      lastOutTradeNo = biz['out_trade_no'] ?? '';
      nodeName = 'alipay_aipay_agent_payment_precreate_response';
      node = JSON.stringify({ code: '10000', msg: 'Success', amt_pre_pay_id: 'amt_pre_pay_test_1' });
    } else {
      verifyCalls++;
      nodeName = 'alipay_aipay_agent_payment_verify_response';
      node = JSON.stringify({
        code: '10000',
        msg: 'Success',
        active: true,
        amount: verifyMode === 'amount_mismatch' ? '0.02' : '0.01',
        out_trade_no: lastOutTradeNo,
        trade_no: biz['trade_no'] ?? '',
        resource_id: 'out_res_id_test',
      });
    }
    const signed = verifyMode === 'unsigned' && params['method']?.includes('.verify')
      ? `{"${nodeName}":${node}}`
      : `{"${nodeName}":${node},"sign":"${signRaw(node, keys.privKey)}"}`;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(signed);
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()));
  const addr = gateway.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;

  const h = await harness({
    machinePay: { provider: 'alipay', serviceId: 'API-TEST', priceCny: 0.01 },
    alipay: {
      appId: '2021000000000000',
      privateKey: keys.priv,
      alipayPublicKey: keys.pub,
      gateway: `http://127.0.0.1:${port}/gateway.do`,
      notifyUrl: 'https://relay.example.com/biz/api/alipay/notify',
    },
  });
  try {
    const first = await chat(h);
    assert.equal(first.status, 402, first.text);
    assert.equal(first.headers.get('amtPaymentLink'), 'amt_pre_pay_test_1');
    assert.equal(precreateSeen.length, 1);
    const biz = precreateSeen[0]!;
    assert.equal(biz['out_trade_no'], first.json.payment.outTradeNo);
    assert.equal(biz['amount'], '0.01');
    assert.equal(biz['currency'], 'CNY');
    assert.equal(biz['service_id'], 'API-TEST');
    assert.match(biz['pay_before'] ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);

    const proof = encodePaymentProof({
      tradeNo: '2026110922001400000000000001',
      paymentProof: 'proof-body-from-alipay',
      clientSession: 'client-session',
    });
    const ok = await chat(h, { 'Payment-Proof': proof });
    assert.equal(ok.status, 200, ok.text);
    assert.match(ok.text, /mock 上游/);
    assert.equal(chatCalls(h), 1);
    assert.equal(verifyCalls, 1);

    // 同一凭证重放
    const replay = await chat(h, { 'Payment-Proof': proof });
    assert.equal(replay.status, 402);
    assert.equal(replay.json.error.code, 'payment_trade_used');
    assert.equal(chatCalls(h), 1);

    // 新单 + 金额不符
    const again = await chat(h);
    assert.equal(again.status, 402);
    assert.equal(precreateSeen.length, 2);
    verifyMode = 'amount_mismatch';
    const mismatch = await chat(h, { 'Payment-Proof': proof });
    assert.equal(mismatch.status, 402);
    assert.equal(mismatch.json.error.code, 'payment_amount_mismatch');
    assert.equal(chatCalls(h), 1);

    // 响应未签名：绝不采信
    verifyMode = 'unsigned';
    const unsigned = await chat(h, { 'Payment-Proof': proof });
    assert.equal(unsigned.status, 502);
    assert.equal(unsigned.json.error.code, 'payment_verify_failed');
    assert.equal(chatCalls(h), 1);
  } finally {
    await h.close();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
});

/* ------------------------------------------------------------------ *
 * 3. 存储状态机
 * ------------------------------------------------------------------ */

test('machine pay: 订单状态机跨重启，trade_no 全局唯一', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-mp-'));
  const path = join(dir, 'biz.db');
  const base = {
    serviceId: 'API-TEST',
    amountCny: 0.01,
    goodsName: 'AI 调用（每次）',
    status: 'pending' as const,
    createdAt: 1000,
    payBeforeAt: 999_999,
  };
  try {
    const store = new SqliteBizStore(path, silent);
    await store.init();
    store.createMachineOrder({ ...base, outTradeNo: 'mp_1' });
    assert.equal(store.markMachinePaid('mp_1', 'TRADE_1', 'res_1', 2000), true);
    assert.equal(store.markMachinePaid('mp_1', 'TRADE_1', 'res_1', 2001), true, '重复 verify 必须幂等');
    assert.equal(store.leaseMachineOrder('mp_1', 3000, 60_000), true);
    assert.equal(store.leaseMachineOrder('mp_1', 3001, 60_000), false, 'processing 期间不能重复领取');
    store.finishMachineOrder('mp_1', false, 4000);
    assert.equal(store.getMachineOrder('mp_1')?.status, 'paid', '失败退回 paid 允许重试');
    assert.equal(store.leaseMachineOrder('mp_1', 5000, 60_000), true);
    store.finishMachineOrder('mp_1', true, 6000);
    assert.equal(store.getMachineOrder('mp_1')?.status, 'consumed');
    assert.equal(store.leaseMachineOrder('mp_1', 7000, 60_000), false);

    store.createMachineOrder({ ...base, outTradeNo: 'mp_2' });
    assert.equal(store.markMachinePaid('mp_2', 'TRADE_1', undefined, 8000), false, '同一笔支付不能履约两次');
    assert.equal(store.getMachineOrder('mp_2')?.status, 'pending');
    await store.close();

    const reopened = new SqliteBizStore(path, silent);
    await reopened.init();
    assert.equal(reopened.getMachineOrder('mp_1')?.status, 'consumed');
    assert.equal(reopened.getMachineOrder('mp_1')?.tradeNo, 'TRADE_1');
    assert.equal(reopened.getMachineOrder('mp_2')?.status, 'pending');
    await reopened.close();
  } finally {
    await rmTmp(dir);
  }
});

/* ------------------------------------------------------------------ *
 * 4. 纯函数
 * ------------------------------------------------------------------ */

test('machine pay: 响应原文抽取与 Payment-Proof 解析', () => {
  const node = JSON.stringify({ x: '}{"y":1}', nested: { z: 2 } });
  const raw = `{"alipay_aipay_agent_payment_verify_response":${node},"sign":"s"}`;
  assert.equal(extractJsonNode(raw, 'alipay_aipay_agent_payment_verify_response'), node);
  assert.equal(extractJsonNode(raw, 'missing'), undefined);

  const encoded = encodePaymentProof({ tradeNo: 'T1', paymentProof: 'P1', clientSession: 'C1' });
  assert.deepEqual(parsePaymentProof(encoded), { tradeNo: 'T1', paymentProof: 'P1', clientSession: 'C1' });
  assert.equal(parsePaymentProof('not-base64!!'), undefined);
  assert.equal(parsePaymentProof(Buffer.from('{"protocol":{}}', 'utf8').toString('base64')), undefined);
  assert.equal(parsePaymentProof(Buffer.from('{"protocol":{"trade_no":"T","payment_proof":"P"}}', 'utf8').toString('base64'))?.tradeNo, 'T');
});
