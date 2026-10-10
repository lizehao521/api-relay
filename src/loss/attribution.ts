/**
 * P3 失败归因（transmission-loss-reduction pattern-007 / 013）
 *
 * 唯一入口 `classifyFailure(input, nowMs)` 是**纯函数**：
 * 相同输入必得相同输出（nowMs 显式传入），因此可安全记忆化。
 * 但注意：本函数依赖 attempt/retryAfter 参与退避计算，缓存键必须包含这两个字段
 * （见 classifyCacheKey）。SKILL.md P6 的教训：记忆化前先确认纯函数性。
 *
 * 铁律：
 * - fail-open：任何内部异常都返回 unknown 归因，绝不抛出。
 * - 不改写成功响应：归因卡片只在错误路径生成，由 delivery 层决定放在哪。
 * - 建议必须"可执行"：每个 action 都要能被 Agent 直接翻译成一行动作。
 */

import type {
  AttributionCard,
  ClassifyInput,
  FailureReason,
  QuickAction,
  SuggestedNext,
} from '../core/types.js';
import { condenseErrorText, monotonicUs, safeJsonParse, truncate } from '../util/index.js';

interface Rule {
  id: string;
  reason: FailureReason;
  /** 命中即认为匹配（对 bodyText 与 headers 拼接后的文本执行） */
  patterns: RegExp[];
  /** 可选的状态码约束 */
  status?: (s: number) => boolean;
  /** 可选：上游错误对象里的 type/code 精确值 */
  codes?: string[];
  recoverable: boolean;
  action: QuickAction;
  confidence: number;
  message: (ctx: RuleCtx) => string;
  /** 该规则是否允许中转站自动重试（配合 lossReduction.attribution.retryableReasons 再过滤） */
  autoRetryable: boolean;
}

interface RuleCtx {
  providerId: string;
  model: string;
  status: number;
  text: string;
  retryAfterMs?: number;
  attempt: number;
}

/* ------------------------------------------------------------------ *
 * 上游错误码特征串（来源见 docs/research/02-上游协议与错误契约.md）
 * 这里是"归因的第一道也是唯一一道语义翻译"。
 * ------------------------------------------------------------------ */

const RULES: Rule[] = [
  /* ---------------- 限流 / 配额 ---------------- */
  {
    id: 'quota.balance',
    reason: 'quota_exhausted',
    // 余额不足在不同上游用不同状态码表达：402（DeepSeek/OpenRouter/SiliconFlow）、
    // 403、429（伪装成限流）、甚至 400（SiliconFlow 实测）。因此状态码只做弱约束。
    status: (s) => s === 400 || s === 402 || s === 403 || s === 429,
    patterns: [
      /insufficient\s+(balance|quota|credits?|funds?)/i,
      /(balance|credit|funds?)\s+(is\s+)?(insufficient|too\s+low|exhausted|depleted)/i,
      /(余额|额度|quota)\s*(不足|已用尽|用完)/,
      /insufficient_user_quota/i,
      /billing\s+(hard\s+)?limit/i,
      /exceeded\s+your\s+current\s+quota/i,
      /账户欠费/,
    ],
    recoverable: false,
    action: 'top_up_balance',
    confidence: 0.95,
    autoRetryable: false,
    message: () => '上游账户余额/配额不足（上游侧限流，不是你的请求有问题）',
  },
  {
    id: 'quota.rate_limit',
    reason: 'rate_limited',
    status: (s) => s === 429,
    patterns: [],
    recoverable: true,
    action: 'retry_with_backoff',
    confidence: 0.9,
    autoRetryable: true,
    message: (c) =>
      c.retryAfterMs
        ? `触发上游速率限制（${c.providerId}），上游要求约 ${Math.ceil(c.retryAfterMs / 1000)} 秒后重试`
        : `触发上游速率限制（${c.providerId}），建议指数退避后重试`,
  },
  {
    id: 'quota.rate_limit_text',
    reason: 'rate_limited',
    status: () => true,
    patterns: [
      /rate\s*limit/i,
      /too\s+many\s+requests/i,
      /requests?\s+per\s+(minute|second|day)/i,
      /请求(过于)?频繁|限流|tpm\s*limit|rpm\s*limit/i,
      /concurrency\s+limit/i,
    ],
    recoverable: true,
    action: 'retry_with_backoff',
    confidence: 0.8,
    autoRetryable: true,
    message: (c) => `上游限流（${c.providerId}），建议退避重试`,
  },

  /* ---------------- 鉴权 / 权限 ---------------- */
  {
    id: 'auth.invalid',
    reason: 'auth_invalid',
    status: (s) => s === 401,
    // 国内厂商大量用中文错误文案，纯英文正则必然漏判（Agnes 就是"无效的令牌"）
    patterns: [/无效的?令牌/, /令牌无效/, /密钥无效/, /认证失败/, /鉴权失败/, /未提供令牌/, /invalid\s+token/i, /unauthorized/i],
    recoverable: false,
    action: 'fix_credentials',
    confidence: 0.95,
    autoRetryable: false,
    message: () => '上游拒绝鉴权：中转站持有的上游密钥无效或已过期（与你的客户端 key 无关）',
  },
  {
    id: 'auth.permission',
    reason: 'permission_denied',
    status: (s) => s === 403,
    patterns: [/无权限/, /权限不足/, /禁止访问/, /未授权/, /forbidden/i, /do(es)?\s+not\s+have\s+(permission|access)/i, /not\s+authorized\s+to\s+(access|use)/i],
    // 可恢复 + 建议换模型：403 绝大多数是**模型级**的（这个 key 没开通这个模型），
    // 换一个模型就能成 —— 实测 Agnes 的 key 调 pro 全系列 403，但 flash 正常。
    // 若把它当成"凭据问题"，客户端就会去折腾 key，而正确的动作是换模型。
    recoverable: true,
    action: 'switch_model',
    confidence: 0.8,
    autoRetryable: false,
    message: (c) => `上游拒绝访问（403，${c.providerId}）：该密钥没有这个模型的权限，或触发了风控。注意这是**模型级**问题——同一个 key 的其他模型通常仍可用`,
  },

  /* ---------------- 模型相关 ---------------- */
  {
    id: 'model.not_found',
    reason: 'model_not_found',
    status: (s) => s === 404,
    patterns: [/model[^]{0,40}not\s*(found|exist)/i, /no\s+such\s+model/i, /模型不存在|未找到模型/],
    recoverable: true,
    action: 'switch_model',
    confidence: 0.9,
    autoRetryable: false,
    message: (c) => `上游（${c.providerId}）不认识模型 ${c.model}，建议改用本网关 /v1/models 列出的可用模型`,
  },
  {
    id: 'model.overloaded',
    reason: 'model_overloaded',
    status: (s) => s === 503 || s === 529 || s === 500,
    patterns: [/overload/i, /server\s+is\s+busy/i, /capacity/i, /过载|繁忙/],
    recoverable: true,
    action: 'retry_with_backoff',
    confidence: 0.85,
    autoRetryable: true,
    message: (c) => `上游模型过载（${c.providerId}），建议短暂退避或切换到其他上游`,
  },

  /* ---------------- 上下文 / 长度 ---------------- */
  {
    id: 'context.length',
    reason: 'context_length_exceeded',
    status: () => true,
    patterns: [
      /context\s*length/i,
      /maximum\s+context/i,
      /too\s+(many|long)\s+tokens/i,
      /reduce\s+the\s+length/i,
      /(超过|超出)(最大)?(上下文|长度|token)/i,
      /max_tokens.*(exceed|too\s+large)/i,
    ],
    recoverable: true,
    action: 'reduce_context',
    confidence: 0.9,
    autoRetryable: false,
    message: () => '输入超出模型上下文窗口：需要裁剪历史消息/文档，或换用长上下文模型',
  },

  /* ---------------- 内容安全 ---------------- */
  {
    id: 'content.filter',
    reason: 'content_filtered',
    status: (s) => s === 400 || s === 403 || s === 422,
    patterns: [
      /content\s*(policy|filter|moderation)/i,
      /(安全|内容)(策略|审核|过滤)/,
      /sensitive|敏感/,
      /data_inspection_failed/i,
      /risk\s*control|风控/,
      /flagged/i,
    ],
    recoverable: false,
    action: 'rewrite_input',
    confidence: 0.85,
    autoRetryable: false,
    message: () => '触发上游内容安全策略：需要改写输入，原样重试不会成功',
  },

  /* ---------------- 请求格式（含工具调用） ---------------- */
  {
    id: 'request.tool_call',
    reason: 'tool_call_invalid',
    status: (s) => s === 400 || s === 422,
    patterns: [
      /tool_call/i,
      /function[^]{0,20}(name|argument)/i,
      /invalid\s+tool/i,
      /tool\s+not\s+found/i,
      /arguments[^]{0,20}(json|parse)/i,
    ],
    recoverable: true,
    action: 'fix_request',
    confidence: 0.8,
    autoRetryable: false,
    message: () => '上游判定 tool_calls 结构非法（id/name/arguments 不匹配或 arguments 不是合法 JSON）',
  },
  {
    id: 'request.invalid',
    reason: 'invalid_request',
    status: (s) => s === 400 || s === 404 || s === 422,
    patterns: [],
    recoverable: false,
    action: 'fix_request',
    confidence: 0.7,
    autoRetryable: false,
    message: () => '上游判定请求格式非法：请检查 messages/参数类型/必填字段',
  },
  {
    id: 'request.payload_too_large',
    reason: 'invalid_request',
    status: (s) => s === 413,
    patterns: [],
    recoverable: true,
    action: 'reduce_context',
    confidence: 0.85,
    autoRetryable: false,
    message: () => '请求体超过上游体积上限：需要减少附件/历史消息',
  },

  /* ---------------- 上游不可用 ---------------- */
  {
    id: 'upstream.5xx',
    reason: 'upstream_unavailable',
    status: (s) => s >= 500 && s !== 529,
    patterns: [],
    recoverable: true,
    action: 'retry_with_backoff',
    confidence: 0.85,
    autoRetryable: true,
    message: (c) => `上游（${c.providerId}）返回 ${c.status}：属上游侧故障，建议退避重试或切上游`,
  },
];

/* ------------------------------------------------------------------ *
 * 网络层错误码
 * ------------------------------------------------------------------ */

const NETWORK_RULES: { codes: string[]; reason: FailureReason; recoverable: boolean; action: QuickAction; message: string }[] = [
  {
    codes: ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR'],
    reason: 'upstream_timeout',
    recoverable: true,
    action: 'retry_with_backoff',
    message: '上游响应超时：建议缩小上下文后重试，或切换到备用上游',
  },
  {
    codes: ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET'],
    reason: 'network_error',
    recoverable: true,
    action: 'retry_with_backoff',
    message: '与上游的网络连接失败：属链路问题，建议退避重试',
  },
];

/* ------------------------------------------------------------------ *
 * 退避时长解析
 * ------------------------------------------------------------------ */

/** 解析 Retry-After（秒或 HTTP 日期）以及响应体内的 "try again in 1.2s" 之类表述 */
export function parseRetryAfterMs(headers?: Record<string, string>, bodyText?: string): number | undefined {
  const raw = headers?.['retry-after'] ?? headers?.['x-ratelimit-reset-requests'] ?? headers?.['x-ratelimit-reset-tokens'];
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      // x-ratelimit-reset-* 可能是 "1s" / "6m0s" 形式
      return Math.min(seconds * 1000, 10 * 60_000);
    }
    const dur = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/i.exec(raw.trim());
    if (dur) {
      const v = Number(dur[1]);
      const unit = dur[2]!.toLowerCase();
      const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
      return Math.min(v * mult, 10 * 60_000);
    }
    const composite = /(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(raw.trim());
    if (composite && (composite[1] || composite[2])) {
      const ms = (Number(composite[1] ?? 0) * 60 + Number(composite[2] ?? 0)) * 1000;
      if (ms > 0) return Math.min(ms, 10 * 60_000);
    }
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 10 * 60_000));
  }
  if (bodyText) {
    const m = /(?:try\s+again|retry|重试)[^\d]{0,20}(\d+(?:\.\d+)?)\s*(ms|s|秒|分钟|m\b)/i.exec(bodyText);
    if (m) {
      const v = Number(m[1]);
      const unit = m[2]!.toLowerCase();
      const mult = unit === 'ms' ? 1 : unit === 's' || unit === '秒' ? 1000 : 60_000;
      return Math.min(v * mult, 10 * 60_000);
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 主分类器
 * ------------------------------------------------------------------ */

function buildText(input: ClassifyInput): string {
  const parts: string[] = [];
  if (input.bodyText) parts.push(condenseErrorText(input.bodyText, 1200));
  if (input.networkError) parts.push(`${input.networkError.code ?? ''} ${input.networkError.message}`);
  if (input.relayError) parts.push(input.relayError.message);
  return parts.join(' \n ').toLowerCase();
}

/**
 * 抽取上游错误对象里的 code/type 特征串。
 *
 * 为什么要这么多形态（研究 02 结论 A）：
 * - 标准 OpenAI 形状：{"error":{"message","type","param","code"}}
 * - 智谱 GLM：{"error":{"code":"1001","message":"..."}}（缺 type/param）
 * - Kimi：{"error":{"type","message"}}（缺 code/param）
 * - SiliconFlow：**没有 error 包裹层**：{"code":20012,"message":"...","data":null}
 * - OpenRouter：error.code 是**数字 HTTP 状态码**，语义类型在 error.metadata.error_type
 */
function extractCodes(bodyText?: string): string[] {
  if (!bodyText) return [];
  const out: string[] = [];
  const parsed = safeJsonParse<Record<string, unknown>>(bodyText);
  if (parsed) {
    const err = parsed['error'];
    const containers: Record<string, unknown>[] = [];
    if (err && typeof err === 'object') containers.push(err as Record<string, unknown>);
    containers.push(parsed); // 兜底：无 error 包裹层（SiliconFlow / 部分自研上游）
    for (const c of containers) {
      pushCode(out, c['code']);
      pushCode(out, c['type']);
      pushCode(out, c['error_type']);
      const meta = c['metadata'];
      if (meta && typeof meta === 'object') {
        pushCode(out, (meta as Record<string, unknown>)['error_type']);
        pushCode(out, (meta as Record<string, unknown>)['raw']);
      }
    }
  }
  // 正则补捞：JSON 结构异常时仍能命中
  const m = /"code"\s*:\s*"?([A-Za-z0-9_.\-]+)"?/g;
  let hit: RegExpExecArray | null;
  while ((hit = m.exec(bodyText)) !== null) pushCode(out, hit[1]);
  const t = /"type"\s*:\s*"?([A-Za-z0-9_.\-]+)"?/g;
  while ((hit = t.exec(bodyText)) !== null) pushCode(out, hit[1]);
  return [...new Set(out)];
}

function pushCode(out: string[], value: unknown): void {
  if (value === undefined || value === null) return;
  const s = String(value).trim().toLowerCase();
  if (!s) return;
  // OpenRouter 风格：code 就是 HTTP 状态码，转成可控词表里的等价标签
  if (/^\d{3}$/.test(s)) {
    if (s === '429') out.push('rate_limit_exceeded');
    else if (s === '402') out.push('insufficient_quota');
    else if (s === '401') out.push('invalid_api_key');
    else if (s === '404') out.push('model_not_found');
    else if (s === '503' || s === '529') out.push('overloaded');
    return;
  }
  out.push(s);
}

export function classifyFailure(input: ClassifyInput, nowMs: number = Date.now()): AttributionCard {
  try {
    const status = input.httpStatus ?? 0;
    const text = buildText(input);
    const codes = extractCodes(input.bodyText);
    const retryAfterMs = parseRetryAfterMs(input.headers, input.bodyText);

    /* ---------- 成功响应（HTTP 200）里的过滤信号 ----------
     * 研究 02 结论 C：finish_reason=content_filter 出现在 200 响应里。
     * 这类情况不构成错误响应，因此本分类器只在"已判定为失败"时被调用；
     * 对 200 的过滤信号，我们只打标记、绝不改写响应体（见 docs/DESIGN.md §7.3）。
     */
    if (status === 200 && /content_filter/i.test(text)) {
      return {
        failure_reason: 'content_filtered',
        message: '上游以 HTTP 200 返回但 finish_reason=content_filter：内容被上游安全策略截断（响应体未被中转站改动）',
        suggested_next: { action: 'rewrite_input' },
        recoverable: false,
        upstream: input.providerId,
        confidence: 0.7,
        evidence: evidenceFor(input, status),
      };
    }

    // 客户端主动取消：这不是上游故障，不要误导客户端重试
    if (input.clientAborted) {
      return {
        failure_reason: 'client_aborted',
        message: '客户端已取消请求（连接断开），上游调用同步中止',
        suggested_next: { action: 'abort' },
        recoverable: false,
        upstream: input.providerId,
        confidence: 1,
      };
    }

    if (input.relayError) {
      return {
        failure_reason: 'relay_internal_error',
        message: `中转站内部错误：${truncate(input.relayError.message, 200)}（已按 fail-open 返回，未影响上游调用语义）`,
        suggested_next: { action: 'retry_same' },
        recoverable: true,
        upstream: 'relay',
        confidence: 0.6,
        evidence: input.relayError.stack ? [truncate(input.relayError.stack, 600)] : undefined,
      };
    }

    // 有网络层错误时优先按网络错误归因（上游可能连 HTTP 状态都没给）
    if (input.networkError) {
      const rule = NETWORK_RULES.find((r) => r.codes.includes((input.networkError!.code ?? '').toUpperCase()));
      const matched = rule ?? {
        reason: 'network_error' as FailureReason,
        recoverable: true,
        action: 'retry_with_backoff' as QuickAction,
        message: `与上游的连接异常：${truncate(input.networkError.message, 160)}`,
      };
      return {
        failure_reason: matched.reason,
        message: matched.message,
        suggested_next: {
          action: matched.action,
          ...(matched.action === 'retry_with_backoff' ? { retryAfterMs: retryAfterMs ?? backoffFor(input.attempt) } : {}),
        },
        recoverable: matched.recoverable,
        upstream: input.providerId,
        confidence: 0.85,
      };
    }

    // 规则匹配：先看 code 精确命中，再看文本
    let best: { rule: Rule; byCode: boolean } | undefined;
    for (const rule of RULES) {
      if (rule.status && status && !rule.status(status)) continue;
      if (!rule.status && status === 0) continue;
      const byCode = rule.codes ? codes.some((c) => rule.codes!.includes(c)) : false;
      if (byCode) {
        best = { rule, byCode: true };
        break;
      }
      if (rule.patterns.some((p) => p.test(text))) {
        if (!best || rule.confidence > best.rule.confidence) best = { rule, byCode: false };
      }
    }

    if (best) {
      const ctx: RuleCtx = {
        providerId: input.providerId,
        model: input.model,
        status,
        text,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        attempt: input.attempt,
      };
      const next: SuggestedNext = { action: best.rule.action };
      if (best.rule.action === 'retry_with_backoff' || best.rule.action === 'wait_and_retry') {
        next.retryAfterMs = retryAfterMs ?? backoffFor(input.attempt);
      }
      return {
        failure_reason: best.rule.reason,
        message: best.rule.message(ctx),
        suggested_next: next,
        recoverable: best.rule.recoverable,
        upstream: input.providerId,
        confidence: best.byCode ? Math.min(0.99, best.rule.confidence + 0.05) : best.rule.confidence,
        evidence: evidenceFor(input, status),
      };
    }

    // 无规则命中：按状态码兜底，绝不返回"未知"之外的猜测
    return fallbackByStatus(input, status, nowMs);
  } catch (err) {
    // fail-open 铁律：归因层自身异常不得影响主流程
    return {
      failure_reason: 'unknown',
      message: `归因层内部异常，已降级为透传：${truncate(err instanceof Error ? err.message : String(err), 160)}`,
      suggested_next: { action: 'retry_same' },
      recoverable: true,
      upstream: input.providerId,
      confidence: 0.1,
    };
  }
}

function fallbackByStatus(input: ClassifyInput, status: number, _nowMs: number): AttributionCard {
  const mk = (
    reason: FailureReason,
    message: string,
    action: QuickAction,
    recoverable: boolean,
    confidence: number,
  ): AttributionCard => {
    const next: SuggestedNext = { action };
    if (action === 'retry_with_backoff') next.retryAfterMs = backoffFor(input.attempt);
    return {
      failure_reason: reason,
      message,
      suggested_next: next,
      recoverable,
      upstream: input.providerId,
      confidence,
      evidence: evidenceFor(input, status),
    };
  };

  if (status === 429) {
    return mk(
      'rate_limited',
      `上游（${input.providerId}）返回 429 但未给出可识别的原因文本：按速率限制处理`,
      'retry_with_backoff',
      true,
      0.5,
    );
  }
  if (status === 401) return mk('auth_invalid', '上游返回 401：中转站的上游密钥需要更新', 'fix_credentials', false, 0.6);
  if (status === 403) return mk('permission_denied', '上游返回 403：权限不足或风控拦截', 'fix_credentials', false, 0.5);
  if (status === 404) return mk('model_not_found', `上游不识别模型 ${input.model}`, 'switch_model', true, 0.7);
  if (status === 408 || status === 504) {
    return mk('upstream_timeout', '上游超时（网关侧已等待超时）', 'retry_with_backoff', true, 0.7);
  }
  if (status >= 500) {
    return mk('upstream_unavailable', `上游（${input.providerId}）返回 ${status}`, 'retry_with_backoff', true, 0.7);
  }
  if (status >= 400) {
    // 置信度刻意压在 0.5 以下：这是"没有规则命中"的兜底，不该被记忆化成事实
    return mk('invalid_request', `上游判定请求非法（${status}，未匹配到具体归因规则）`, 'fix_request', false, 0.45);
  }
  return mk('unknown', '无法归因的上游错误，已原样透传上游响应体', 'retry_same', true, 0.2);
}

function backoffFor(attempt: number): number {
  const base = 400;
  const capped = Math.min(base * 2 ** Math.max(0, attempt - 1), 8_000);
  return Math.round(capped * 0.75 + Math.random() * capped * 0.25);
}

function evidenceFor(input: ClassifyInput, status: number): string[] | undefined {
  const ev: string[] = [`http_status=${status}`, `upstream=${input.providerId}`, `attempt=${input.attempt}`];
  const snippet = condenseErrorText(input.bodyText ?? '', 240);
  if (snippet) ev.push(`upstream_message=${snippet}`);
  if (input.networkError) ev.push(`network_code=${input.networkError.code ?? 'n/a'}`);
  return ev;
}

/* ------------------------------------------------------------------ *
 * 记忆化（P6 的教训：仅对纯函数结果缓存，且缓存键必须覆盖全部输入）
 * ------------------------------------------------------------------ */

export function classifyCacheKey(input: ClassifyInput): string {
  return [
    input.providerId,
    input.model,
    input.httpStatus ?? 0,
    input.attempt,
    input.networkError?.code ?? '',
    input.networkError?.message ?? '',
    input.clientAborted ? '1' : '0',
    input.relayError?.message ?? '',
    input.headers?.['retry-after'] ?? '',
    truncate(condenseErrorText(input.bodyText ?? '', 200), 200),
  ].join('\u0001');
}

/** 带记忆化与耗时的分类包装；缓存命中时 classifyUs 记 0 以便度量真实开销 */
export interface Classifier {
  classify(input: ClassifyInput): { card: AttributionCard; durationUs: number; cached: boolean };
  stats(): { size: number; hits: number; misses: number };
  clear(): void;
}

export function createClassifier(
  cache: { get(k: string): AttributionCard | undefined; set(k: string, v: AttributionCard): void; stats(): { size: number; hits: number; misses: number }; clear(): void },
): Classifier {
  return {
    classify(input) {
      const t0 = monotonicUs();
      const key = classifyCacheKey(input);
      const hit = cache.get(key);
      if (hit) return { card: hit, durationUs: 0, cached: true };
      const card = classifyFailure(input);
      // 只缓存确定性的高置信结果；低置信度（含时间/随机退避抖动）不缓存以保持语义稳定
      if (card.confidence >= 0.5) cache.set(key, card);
      return { card, durationUs: monotonicUs() - t0, cached: false };
    },
    stats: () => cache.stats(),
    clear: () => cache.clear(),
  };
}
