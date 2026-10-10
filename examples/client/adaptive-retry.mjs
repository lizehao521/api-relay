/**
 * 把「失败归因」用起来的客户端示例（零依赖，复制即可用）。
 *
 * 核心思想：中转站在错误体里给了你 `relay_attribution.suggested_next`，
 * 你的代码不该再去 parse 上游的错误文本——直接执行它给的动作。
 *
 * 这就是"错误的可执行化"：把 raw error → 一行代码。
 *
 * 运行：
 *   RELAY_BASE=http://127.0.0.1:8787 RELAY_KEY=sk-relay-pro-demo node examples/client/adaptive-retry.mjs
 */

const BASE = process.env.RELAY_BASE ?? 'http://127.0.0.1:8787';
const KEY = process.env.RELAY_KEY ?? 'sk-relay-pro-demo';
const MODEL = process.env.RELAY_MODEL ?? 'mock-small';

/** 中转站可投递的动作 → 客户端该做什么 */
const HANDLERS = {
  retry_with_backoff: '等 retryAfterMs 后重发同一请求',
  wait_and_retry: '等 retryAfterMs 后重发',
  retry_same: '立即重发（要求幂等）',
  reduce_context: '裁剪 messages / 文档后重发',
  raise_max_tokens: '提高输出上限后重发',
  switch_model: '换模型后重发',
  rewrite_input: '改写输入（内容安全触发，原样重发必然再失败）',
  top_up_balance: '给上游充值（中转站侧问题，可联系运营）',
  fix_credentials: '修 key（中转站侧问题）',
  fix_request: '修请求结构（不要重试）',
  abort: '停止，不要重试',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 一次调用；把归因结论翻译成"下一步"。
 * @returns {{ok: boolean, body?: any, attribution?: any, attempts: number}}
 */
export async function callWithAttribution(payload, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 4;
  const messages = [...payload.messages];
  const model = payload.model ?? MODEL;
  let attempt = 0;

  for (;;) {
    attempt++;
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        // 想让中转站证明"它没改你的数据"，带上这个 nonce（非流式有效）
        ...(opts.verify ? { 'x-relay-verify-nonce': crypto.randomUUID() } : {}),
        // 万一预检误拦，这行是逃生舱
        ...(opts.bypassPrecheck ? { 'x-relay-precheck': 'off' } : {}),
      },
      body: JSON.stringify({ ...payload, model, messages }),
    });

    const text = await res.text();
    if (res.ok) {
      return { ok: true, body: JSON.parse(text), attempts: attempt };
    }

    const parsed = safeJson(text);
    const attribution = parsed?.error?.relay_attribution;

    // 极端情况：中转站没给归因（free 层）。退回"状态码 + Retry-After"的通用策略。
    if (!attribution) {
      if (res.status === 429 && attempt < maxAttempts) {
        await sleep(Number(res.headers.get('retry-after') ?? 1) * 1000);
        continue;
      }
      return { ok: false, body: parsed ?? { raw: text }, attempts: attempt };
    }

    console.log(
      `  [第 ${attempt} 次] ${res.status} ${attribution.failure_reason}` +
        `｜可恢复=${attribution.recoverable}｜建议=${attribution.suggested_next.action}` +
        `（${HANDLERS[attribution.suggested_next.action] ?? '未知动作'}）`,
    );

    const { action, retryAfterMs } = attribution.suggested_next;

    switch (action) {
      case 'retry_with_backoff':
      case 'wait_and_retry': {
        if (attempt >= maxAttempts) return { ok: false, body: parsed, attribution, attempts: attempt };
        await sleep(retryAfterMs ?? 1000);
        continue;
      }
      case 'retry_same': {
        if (attempt >= maxAttempts) return { ok: false, body: parsed, attribution, attempts: attempt };
        await sleep(200);
        continue;
      }
      case 'reduce_context': {
        // 真实实现里应该按 token 预算裁剪；这里只演示"少带一半历史"
        if (attempt >= maxAttempts || messages.length <= 1) return { ok: false, body: parsed, attribution, attempts: attempt };
        const keep = Math.max(1, Math.floor(messages.length / 2));
        messages.splice(0, messages.length - keep);
        console.log(`  → 裁剪上下文至 ${messages.length} 条消息后重发`);
        continue;
      }
      case 'switch_model': {
        if (attempt >= maxAttempts) return { ok: false, body: parsed, attribution, attempts: attempt };
        // 中转站自己发的"无可用上游"（upstream=relay）时，换模型也救不了当前配置：
        // 这是运营侧问题，客户端应该停下来并把错误报给用户/告警，而不是继续换。
        if (attribution.upstream === 'relay') {
          console.error('  → 没有可用上游（运营侧问题），停止自动重试');
          return { ok: false, body: parsed, attribution, attempts: attempt };
        }
        // 从 GET /v1/models 里挑一个与当前不同的模型（真实实现应维护自己的降级链 + 成本顺序）
        const fallback = opts.fallbackModel ?? (await pickFallbackModel(model));
        if (!fallback || fallback === model || (opts.triedModels ?? []).includes(fallback)) {
          return { ok: false, body: parsed, attribution, attempts: attempt };
        }
        console.log(`  → 切换模型 ${model} → ${fallback}`);
        return callWithAttribution(
          { ...payload, model: fallback, messages },
          { ...opts, maxAttempts: maxAttempts - attempt, triedModels: [...(opts.triedModels ?? []), model] },
        );
      }
      case 'top_up_balance':
      case 'fix_credentials':
        console.error('  → 这是中转站/上游侧的账号问题，请联系运营；重试无意义');
        return { ok: false, body: parsed, attribution, attempts: attempt };
      case 'rewrite_input':
        console.error('  → 触发内容安全策略，需要改写输入；原样重发必然再失败');
        return { ok: false, body: parsed, attribution, attempts: attempt };
      case 'fix_request':
        console.error('  → 请求结构非法，请修正后重试；不要自动重发');
        return { ok: false, body: parsed, attribution, attempts: attempt };
      case 'abort':
      default:
        return { ok: false, body: parsed, attribution, attempts: attempt };
    }
  }
}

/** 从 /v1/models 里挑一个可用的替代模型 */
async function pickFallbackModel(current) {
  try {
    const res = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } });
    const body = await res.json();
    const ids = (body.data ?? []).map((m) => m.id).filter((id) => id !== current);
    return ids[0];
  } catch {
    return undefined;
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */

import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`base=${BASE} model=${MODEL}`);
  const result = await callWithAttribution({
    model: MODEL,
    messages: [{ role: 'user', content: '你好，请用一句话介绍你自己' }],
  });
  console.log('\n结果：', result.ok ? '成功' : '失败');
  if (result.ok) console.log('内容：', result.body?.choices?.[0]?.message?.content);
  else console.log('最终错误：', JSON.stringify(result.body, null, 2).slice(0, 800));
  console.log('总尝试次数：', result.attempts);
  console.log('\n提示：把 model 换成 mock-429 / mock-503 / mock-balance 可以看到不同归因路径。');
}
