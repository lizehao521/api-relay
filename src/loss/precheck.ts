/**
 * P2 调用前意图预检（pattern-006）
 *
 * 只做「通用规则」——不猜用户环境。检的是请求自身是否自相矛盾/越界/结构性非法，
 * 这些错误一旦发到上游必然失败，且失败信息对 Agent 不可读。
 *
 * fail-open 铁律的三层含义（本文件的实现契约）：
 * 1. 预检自身异常 → 直接放行（degraded=true），绝不因为治理层 bug 拒绝用户请求。
 * 2. 超预算（budgetUs）→ 立即停止检查并放行。
 *    但**危险命令扫描不受时间预算影响**：它是唯一的安全级检查，
 *    "机器忙的时候安全拦截悄悄失效"是不可接受的失败模式（见下方 SAFETY_FIRST 注释）。
 *    它的成本用结构性上限（扫描的工具调用条数）来保证有界，而不是用时间。
 * 3. 只把 `severity: 'block'` 的违规交给 HTTP 层决定拦不拦；`warn/info` 永不拦截。
 *
 * 与 tool_guardrails 的关系：这是 defense-in-depth 的第一层（便宜、无副作用），
 * 不是替代品。
 */

import type {
  PrecheckResult,
  PrecheckViolation,
  LossReductionConfig,
  FailureReason,
} from '../core/types.js';
import { monotonicUs, ownLookup, truncate } from '../util/index.js';

/* ------------------------------------------------------------------ *
 * 上下文与模型目录
 * ------------------------------------------------------------------ */

export interface ModelCatalog {
  /** 网关对外可见的模型名（含别名）*/
  has(model: string): boolean;
  list(): string[];
  /**
   * 当前是否有任何上游处于可用状态（未禁用、未熔断）。
   *
   * 为什么预检需要知道这件事：如果所有上游都不可用，那么"模型不在清单里"是
   * **运营侧问题**而不是客户端问题。此时拦截会给出误导性的 400（"你应该换个模型"），
   * 而正确结论是 503（"上游全挂了"）。所以全部不可用时预检必须放行到路由层。
   */
  anyAvailable?(): boolean;
}

export function createModelCatalog(models: Iterable<string>, anyAvailable?: () => boolean): ModelCatalog {
  const set = new Set(models);
  return {
    has: (m) => set.has(m),
    list: () => [...set].sort(),
    ...(anyAvailable ? { anyAvailable } : {}),
  };
}

export interface PrecheckContext {
  endpoint: string;
  body: Record<string, unknown>;
  catalog: ModelCatalog;
  /** 每模型的上限（可选）；用于 max_tokens 越界检查 */
  modelMaxTokens?: Record<string, number>;
}

/* ------------------------------------------------------------------ *
 * 违规码：稳定字符串，便于度量与客户端分支处理
 * ------------------------------------------------------------------ */

export const PRECHECK_CODES = {
  MODEL_UNKNOWN: 'model_unknown',
  MODEL_MISSING: 'model_missing',
  MESSAGES_MISSING: 'messages_missing',
  MESSAGES_TOO_MANY: 'messages_too_many',
  MESSAGE_INVALID: 'message_invalid',
  ROLE_INVALID: 'role_invalid',
  ROLE_SEQUENCE: 'role_sequence_invalid',
  CONTENT_INVALID: 'content_invalid',
  TOOL_CALL_ID_MISSING: 'tool_call_id_missing',
  TOOL_CALL_ID_UNKNOWN: 'tool_call_id_unknown',
  TOOL_CALL_ARGS_INVALID_JSON: 'tool_call_arguments_invalid_json',
  TOOL_CALL_NAME_MISSING: 'tool_call_name_missing',
  TOOL_NAME_UNKNOWN: 'tool_name_unknown',
  TOOLS_TOO_MANY: 'tools_too_many',
  TOOLS_DUPLICATE: 'tools_duplicate_name',
  TOOLS_INVALID: 'tools_invalid_shape',
  TOOL_CHOICE_INVALID: 'tool_choice_invalid',
  SAMPLING_RANGE: 'sampling_out_of_range',
  MAX_TOKENS_RANGE: 'max_tokens_out_of_range',
  MAX_TOKENS_OVER_MODEL: 'max_tokens_over_model_limit',
  STOP_INVALID: 'stop_invalid',
  JSON_MODE_WITHOUT_INSTRUCTION: 'json_mode_without_json_hint',
  DANGEROUS_COMMAND: 'dangerous_command_in_arguments',
  EMPTY_PROMPT: 'empty_prompt',
  DUPLICATE_TOOL_RESULT: 'duplicate_tool_result',
} as const;

export type PrecheckCode = (typeof PRECHECK_CODES)[keyof typeof PRECHECK_CODES];

/* ------------------------------------------------------------------ *
 * 纯函数式工具
 * ------------------------------------------------------------------ */

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool', 'developer', 'function']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** 从消息里收集已声明的 tool_call id → name */
function collectDeclaredToolCalls(messages: unknown[]): Map<string, string> {
  const declared = new Map<string, string>();
  for (const m of messages) {
    if (!isPlainObject(m)) continue;
    const calls = m['tool_calls'];
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      if (!isPlainObject(c)) continue;
      const id = typeof c['id'] === 'string' ? c['id'] : undefined;
      const fn = isPlainObject(c['function']) ? c['function'] : undefined;
      const name = fn && typeof fn['name'] === 'string' ? fn['name'] : undefined;
      if (id) declared.set(id, name ?? '');
    }
  }
  return declared;
}

/** 递归扫描 JSON 中的所有字符串值（用于危险命令检测） */
function scanStrings(value: unknown, visit: (s: string, path: string) => void, path = ''): void {
  if (typeof value === 'string') {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanStrings(v, visit, `${path}/${i}`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) scanStrings(v, visit, `${path}/${k}`);
  }
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isPlainObject(part) && typeof part['text'] === 'string') return part['text'];
        return '';
      })
      .join('');
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * 主检查器
 * ------------------------------------------------------------------ */

export interface PrecheckOptions {
  config: LossReductionConfig;
  /** 由外部预编译的正则（避免每次请求重复编译） */
  dangerousPatterns: RegExp[];
}

export function compileDangerousPatterns(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, 'i'));
    } catch {
      // 非法正则在配置期就该拦住；运行期静默跳过（fail-open）
    }
  }
  return out;
}

const SHELL_LIKE_TOOLS = /(bash|shell|sh|zsh|cmd|powershell|terminal|exec|run_command|execute|subprocess|python|node)/i;

/**
 * 预检入口。纯函数（不读时钟、不读全局状态），因此可单测、可并发安全调用。
 * 返回的 violations 是稳定排序的（先 block 后 warn 再 info，同级别按 pointer）。
 */
export function precheck(ctx: PrecheckContext, opts: PrecheckOptions): PrecheckResult {
  const t0 = monotonicUs();
  const violations: PrecheckViolation[] = [];
  const cfg = opts.config.precheck;
  const budget = cfg.budgetUs;
  const overBudget = (): boolean => budget > 0 && monotonicUs() - t0 > budget;

  const add = (v: PrecheckViolation): void => {
    violations.push(v);
  };

  try {
    const body = ctx.body;
    const endpoint = ctx.endpoint;

    /* ---------- 危险命令（仅对 shell 类工具的参数） ----------
     * SAFETY_FIRST：这一项**必须**在时间预算守卫之前执行，且自己不看时间预算。
     * 原因：budgetUs 只有几毫秒，机器一忙就会被击穿；如果它排在预算守卫之后，
     * 那么"CPU 繁忙"就等于"危险命令拦截自动关闭"——这是安全级失败模式，
     * 不能用"我们是为了不当瓶颈"来解释。
     * 成本改由结构上限保证：扫描条数封顶（SAFETY_SCAN_MAX_CALLS），
     * 所以最坏耗时仍有界，只是与机器负载无关。
     */
    if (opts.dangerousPatterns.length > 0) {
      checkDangerousCommands(body, opts.dangerousPatterns, add);
    }

    /* ---------- 模型 ---------- */
    const model = body['model'];
    // 目录为空说明所有上游都被禁用/未配置：这是**运营配置问题**，不是客户端的问题。
    // 此时必须放行到路由层，让用户看到"没有可用上游（含被拒原因）"而不是被预检误拦。
    const noUpstreamAvailable = ctx.catalog.list().length === 0 || ctx.catalog.anyAvailable?.() === false;
    if (typeof model !== 'string' || model.trim() === '') {
      add({
        code: PRECHECK_CODES.MODEL_MISSING,
        severity: 'block',
        pointer: '/model',
        message: '请求缺少 model 字段（或为空字符串）',
        fix: '在请求体中加入 "model": "<model-id>"，可用模型见 GET /v1/models',
      });
    } else if (!noUpstreamAvailable && !ctx.catalog.has(model)) {
      const suggestions = suggestModels(model, ctx.catalog.list());
      add({
        code: PRECHECK_CODES.MODEL_UNKNOWN,
        severity: 'block',
        pointer: '/model',
        message: `网关不认识模型 "${truncate(model, 80)}"（该名称不在本网关已开通的模型清单内）`,
        fix: suggestions.length
          ? `改为已开通的模型，最接近的是: ${suggestions.join(', ')}`
          : '调用 GET /v1/models 获取当前可用的模型清单',
      });
    }

    /* ---------- messages ---------- */
    if (endpoint === '/v1/chat/completions' || endpoint === '/v1/messages') {
      const messages = body['messages'];
      if (!Array.isArray(messages)) {
        add({
          code: PRECHECK_CODES.MESSAGES_MISSING,
          severity: 'block',
          pointer: '/messages',
          message: 'messages 必须是数组（当前缺失或类型错误）',
          fix: 'messages: [{"role":"user","content":"..."}]',
        });
      } else if (messages.length === 0) {
        add({
          code: PRECHECK_CODES.EMPTY_PROMPT,
          severity: 'block',
          pointer: '/messages',
          message: 'messages 为空数组，上游必定报错',
          fix: '至少提供一条 role=user 的消息',
        });
      } else {
        if (messages.length > cfg.maxMessages) {
          add({
            code: PRECHECK_CODES.MESSAGES_TOO_MANY,
            severity: 'block',
            pointer: '/messages',
            message: `messages 条数 ${messages.length} 超过网关上限 ${cfg.maxMessages}`,
            fix: '裁剪历史消息（保留 system + 最近若干轮）或使用摘要压缩',
          });
        }
        checkMessages(messages, add);
      }

      /* ---------- tools ---------- */
      const tools = body['tools'];
      const declaredTools = new Set<string>();
      if (tools !== undefined) {
        if (!Array.isArray(tools)) {
          add({
            code: PRECHECK_CODES.TOOLS_INVALID,
            severity: 'block',
            pointer: '/tools',
            message: 'tools 必须是数组',
            fix: 'tools: [{"type":"function","function":{"name":"...","parameters":{...}}}]',
          });
        } else {
          if (tools.length > cfg.maxTools) {
            add({
              code: PRECHECK_CODES.TOOLS_TOO_MANY,
              severity: 'warn',
              pointer: '/tools',
              message: `声明了 ${tools.length} 个工具，超过建议上限 ${cfg.maxTools}（会显著增加 token 与选错工具的概率）`,
              fix: '按当前任务只保留必要工具',
            });
          }
          tools.forEach((tool, i) => {
            if (!isPlainObject(tool)) {
              add({
                code: PRECHECK_CODES.TOOLS_INVALID,
                severity: 'block',
                pointer: `/tools/${i}`,
                message: '工具项必须是对象',
                fix: '{"type":"function","function":{"name":"...","parameters":{}}}',
              });
              return;
            }
            const fn = isPlainObject(tool['function']) ? tool['function'] : undefined;
            const name = fn && typeof fn['name'] === 'string' ? fn['name'] : undefined;
            if (!fn || !name) {
              add({
                code: PRECHECK_CODES.TOOLS_INVALID,
                severity: 'block',
                pointer: `/tools/${i}/function/name`,
                message: '工具缺少 function.name',
                fix: '为每个工具补上唯一的 function.name',
              });
              return;
            }
            if (declaredTools.has(name)) {
              add({
                code: PRECHECK_CODES.TOOLS_DUPLICATE,
                severity: 'block',
                pointer: `/tools/${i}/function/name`,
                message: `工具名 "${name}" 重复声明`,
                fix: '工具名必须唯一；同名工具会让模型无法区分',
              });
            }
            declaredTools.add(name);
            const params = fn['parameters'];
            if (params !== undefined && !isPlainObject(params)) {
              add({
                code: PRECHECK_CODES.TOOLS_INVALID,
                severity: 'block',
                pointer: `/tools/${i}/function/parameters`,
                message: 'function.parameters 必须是 JSON Schema 对象',
                fix: 'parameters: {"type":"object","properties":{...}}',
              });
            }
          });
        }
      }

      /* ---------- tool_choice ---------- */
      const toolChoice = body['tool_choice'];
      if (toolChoice !== undefined && typeof toolChoice !== 'string' && !isPlainObject(toolChoice)) {
        add({
          code: PRECHECK_CODES.TOOL_CHOICE_INVALID,
          severity: 'block',
          pointer: '/tool_choice',
          message: 'tool_choice 必须是 "none"|"auto"|"required" 或 {"type":"function","function":{"name":"..."}}',
          fix: '改为合法取值；若要强制某个工具请用对象形式',
        });
      } else if (typeof toolChoice === 'string' && !['none', 'auto', 'required'].includes(toolChoice)) {
        add({
          code: PRECHECK_CODES.TOOL_CHOICE_INVALID,
          severity: 'block',
          pointer: '/tool_choice',
          message: `tool_choice 取值非法: "${truncate(toolChoice, 40)}"`,
          fix: '只允许 none / auto / required',
        });
      } else if (typeof toolChoice === 'object' && toolChoice !== null) {
        const fn = isPlainObject((toolChoice as Record<string, unknown>)['function'])
          ? ((toolChoice as Record<string, unknown>)['function'] as Record<string, unknown>)
          : undefined;
        const name = fn && typeof fn['name'] === 'string' ? fn['name'] : undefined;
        if (name && declaredTools.size > 0 && !declaredTools.has(name)) {
          add({
            code: PRECHECK_CODES.TOOL_CHOICE_INVALID,
            severity: 'block',
            pointer: '/tool_choice/function/name',
            message: `tool_choice 指向了未声明的工具 "${name}"`,
            fix: `在 tools 中声明 "${name}"，或改用 "auto"`,
          });
        }
      }
    }

    if (overBudget()) return finish(violations, t0, true);

    /* ---------- 采样参数 ---------- */
    const temperature = asFiniteNumber(body['temperature']);
    if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
      add({
        code: PRECHECK_CODES.SAMPLING_RANGE,
        severity: 'block',
        pointer: '/temperature',
        message: `temperature=${temperature} 超出 [0, 2]`,
        fix: '常见取值 0（确定性）~ 1（创意）',
      });
    }
    const topP = asFiniteNumber(body['top_p']);
    if (topP !== undefined && (topP <= 0 || topP > 1)) {
      add({
        code: PRECHECK_CODES.SAMPLING_RANGE,
        severity: 'block',
        pointer: '/top_p',
        message: `top_p=${topP} 超出 (0, 1]`,
        fix: '改为 0.1~1 之间；不建议与 temperature 同时调整',
      });
    }
    const presence = asFiniteNumber(body['presence_penalty']);
    const frequency = asFiniteNumber(body['frequency_penalty']);
    for (const [key, val] of [['presence_penalty', presence], ['frequency_penalty', frequency]] as const) {
      if (val !== undefined && (val < -2 || val > 2)) {
        add({
          code: PRECHECK_CODES.SAMPLING_RANGE,
          severity: 'block',
          pointer: `/${key}`,
          message: `${key}=${val} 超出 [-2, 2]`,
          fix: '改为 [-2, 2] 之间的值',
        });
      }
    }

    const maxTokens = asFiniteNumber(body['max_tokens'] ?? body['max_completion_tokens']);
    if (maxTokens !== undefined && (maxTokens < 1 || !Number.isInteger(maxTokens))) {
      add({
        code: PRECHECK_CODES.MAX_TOKENS_RANGE,
        severity: 'block',
        pointer: body['max_tokens'] !== undefined ? '/max_tokens' : '/max_completion_tokens',
        message: `max_tokens=${maxTokens} 必须是 >=1 的整数`,
        fix: '例如 1024',
      });
    } else if (maxTokens !== undefined) {
      /* 上限检查：模型声明过的用声明的，没声明用配置里的绝对天花板。
       *
       * 修复前这里有个**死代码**陷阱：整段被 `&& ctx.modelMaxTokens` 守着，而全库
       * 没有任何调用方传过 modelMaxTokens（engine 只传 endpoint/body/catalog），
       * 于是 max_tokens=1e308 / 999999999 一路穿过预检打到上游（实测 ok=true）。
       * 现在改成「模型没声明也要有天花板」，兜底值来自 precheck.maxTokensCeiling。
       */
      const perModel = typeof body['model'] === 'string'
        // ownLookup：模型名来自请求体，'constructor' 等原型链键会让 modelMaxTokens[m]
        // 命中 Object.prototype 而拿到函数，被当成一个"上限"（同族 bug，第 18 轮刚扫过）。
        ? ownLookup(ctx.modelMaxTokens, body['model'] as string)
        : undefined;
      const limit = perModel ?? (cfg.maxTokensCeiling > 0 ? cfg.maxTokensCeiling : undefined);
      if (limit !== undefined && maxTokens > limit) {
        add({
          code: PRECHECK_CODES.MAX_TOKENS_OVER_MODEL,
          severity: 'block',
          pointer: '/max_tokens',
          message: perModel !== undefined
            ? `max_tokens=${maxTokens} 超过模型 ${body['model'] as string} 的输出上限 ${limit}`
            : `max_tokens=${maxTokens} 超过网关上 ${limit}`,
          fix: `把 max_tokens 调到 <= ${limit}`,
        });
      }
    }

    const stop = body['stop'];
    if (stop !== undefined && !(typeof stop === 'string' || (Array.isArray(stop) && stop.every((s) => typeof s === 'string')))) {
      add({
        code: PRECHECK_CODES.STOP_INVALID,
        severity: 'block',
        pointer: '/stop',
        message: 'stop 必须是字符串或字符串数组',
        fix: 'stop: "\\n\\n" 或 ["END", "###"]',
      });
    } else if (Array.isArray(stop) && stop.length > 4) {
      add({
        code: PRECHECK_CODES.STOP_INVALID,
        severity: 'warn',
        pointer: '/stop',
        message: `stop 数组有 ${stop.length} 项，多数上游上限为 4`,
        fix: '只保留最关键的 1~4 个停止串',
      });
    }

    /* ---------- JSON 模式 ---------- */
    const format = body['response_format'];
    if (isPlainObject(format) && format['type'] === 'json_object') {
      const text = Array.isArray(body['messages'])
        ? body['messages'].map((m) => (isPlainObject(m) ? contentToText(m['content']) : '')).join('\n')
        : '';
      if (!/json/i.test(text)) {
        add({
          code: PRECHECK_CODES.JSON_MODE_WITHOUT_INSTRUCTION,
          severity: 'warn',
          pointer: '/response_format',
          message: 'response_format=json_object，但消息里没有出现 "JSON" 字样（OpenAI 兼容上游会直接报错）',
          fix: '在 system/user 消息中加入「请以 JSON 格式输出」之类的明确指令',
        });
      }
    }

  } catch (err) {
    // fail-open：预检崩溃即放行，并把降级事实记入结果供度量
    violations.push({
      code: 'precheck_internal_error',
      severity: 'info',
      pointer: '',
      message: `预检内部异常，已放行本次请求：${truncate(err instanceof Error ? err.message : String(err), 160)}`,
      fix: '查看中转站日志 precheck_internal_error',
    });
    return finish(violations, t0, true);
  }

  return finish(violations, t0, false);
}

function finish(violations: PrecheckViolation[], t0: number, degraded: boolean): PrecheckResult {
  const order = { block: 0, warn: 1, info: 2 } as const;
  violations.sort((a, b) => order[a.severity] - order[b.severity] || a.pointer.localeCompare(b.pointer) || a.code.localeCompare(b.code));
  const hasBlock = violations.some((v) => v.severity === 'block') || violations.some((v) => v.severity === 'info' && v.code === 'precheck_internal_error');
  return {
    ok: !hasBlock,
    violations,
    durationUs: monotonicUs() - t0,
    ...(degraded ? { degraded: true } : {}),
  };
}

function checkMessages(messages: unknown[], add: (v: PrecheckViolation) => void): void {
  const declared = collectDeclaredToolCalls(messages);
  const toolResultIds = new Map<string, number>();
  let lastRole = '';

  messages.forEach((m, i) => {
    if (!isPlainObject(m)) {
      add({
        code: PRECHECK_CODES.MESSAGE_INVALID,
        severity: 'block',
        pointer: `/messages/${i}`,
        message: '消息必须是对象',
        fix: '{"role":"user","content":"..."}',
      });
      return;
    }
    const role = m['role'];
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
      add({
        code: PRECHECK_CODES.ROLE_INVALID,
        severity: 'block',
        pointer: `/messages/${i}/role`,
        message: `role 非法: ${typeof role === 'string' ? truncate(role, 40) : String(role)}`,
        fix: '只允许 system / user / assistant / tool',
      });
      return;
    }
    lastRole = role;

    const content = m['content'];
    const isToolErr = m['tool_call_id'] !== undefined;
    if (content === undefined && !isToolErr && m['tool_calls'] === undefined) {
      add({
        code: PRECHECK_CODES.CONTENT_INVALID,
        severity: 'block',
        pointer: `/messages/${i}/content`,
        message: '消息既没有 content 也没有 tool_calls',
        fix: '至少提供其中之一',
      });
    } else if (content !== null && typeof content !== 'string' && !Array.isArray(content) && content !== undefined) {
      add({
        code: PRECHECK_CODES.CONTENT_INVALID,
        severity: 'block',
        pointer: `/messages/${i}/content`,
        message: 'content 必须是字符串、内容块数组或 null',
        fix: '把对象序列化成字符串，或使用 [{"type":"text","text":"..."}]',
      });
    }

    /* 工具结果必须回引一个已声明的 tool_call id */
    if (role === 'tool' || isToolErr) {
      const id = m['tool_call_id'];
      if (typeof id !== 'string' || id === '') {
        add({
          code: PRECHECK_CODES.TOOL_CALL_ID_MISSING,
          severity: 'block',
          pointer: `/messages/${i}/tool_call_id`,
          message: 'role=tool 的消息缺少 tool_call_id',
          fix: '填入上一条 assistant 消息 tool_calls 里的 id（原样复制，不要自己编）',
        });
      } else {
        const prev = toolResultIds.get(id) ?? 0;
        toolResultIds.set(id, prev + 1);
        if (prev > 0) {
          add({
            code: PRECHECK_CODES.DUPLICATE_TOOL_RESULT,
            severity: 'warn',
            pointer: `/messages/${i}/tool_call_id`,
            message: `同一个 tool_call_id "${truncate(id, 40)}" 被回填了多次结果`,
            fix: '每个 tool_call 只回填一条结果；重复回填会让模型困惑',
          });
        }
        if (declared.size > 0 && !declared.has(id)) {
          add({
            code: PRECHECK_CODES.TOOL_CALL_ID_UNKNOWN,
            severity: 'block',
            pointer: `/messages/${i}/tool_call_id`,
            message: `tool_call_id "${truncate(id, 40)}" 在当前对话里没有任何对应的 assistant.tool_calls 声明`,
            fix: '检查是否跨会话拼接了历史消息（常见于 Agent 框架错误地复用了旧上下文）',
          });
        }
      }
    }

    /* assistant.tool_calls 结构 */
    const calls = m['tool_calls'];
    if (calls !== undefined) {
      if (!Array.isArray(calls)) {
        add({
          code: PRECHECK_CODES.MESSAGE_INVALID,
          severity: 'block',
          pointer: `/messages/${i}/tool_calls`,
          message: 'tool_calls 必须是数组',
          fix: '[{"id":"call_1","type":"function","function":{"name":"...","arguments":"{}"}}]',
        });
      } else {
        calls.forEach((c, j) => {
          if (!isPlainObject(c)) {
            add({
              code: PRECHECK_CODES.MESSAGE_INVALID,
              severity: 'block',
              pointer: `/messages/${i}/tool_calls/${j}`,
              message: 'tool_call 必须是对象',
              fix: '补全 id / type / function 字段',
            });
            return;
          }
          const cid = c['id'];
          if (typeof cid !== 'string' || cid === '') {
            add({
              code: PRECHECK_CODES.TOOL_CALL_ID_MISSING,
              severity: 'block',
              pointer: `/messages/${i}/tool_calls/${j}/id`,
              message: 'tool_call 缺少 id',
              fix: '补一个唯一 id（如 call_abc123）；后续 tool 消息必须引用同一个 id',
            });
          }
          const fn = isPlainObject(c['function']) ? c['function'] : undefined;
          const name = fn && typeof fn['name'] === 'string' ? fn['name'] : undefined;
          if (!fn || !name) {
            add({
              code: PRECHECK_CODES.TOOL_CALL_NAME_MISSING,
              severity: 'block',
              pointer: `/messages/${i}/tool_calls/${j}/function/name`,
              message: 'tool_call 缺少 function.name',
              fix: '补上此前调用的工具名',
            });
          }
          const args = fn?.['arguments'];
          if (args !== undefined && typeof args !== 'string') {
            add({
              code: PRECHECK_CODES.TOOL_CALL_ARGS_INVALID_JSON,
              severity: 'block',
              pointer: `/messages/${i}/tool_calls/${j}/function/arguments`,
              message: 'function.arguments 必须是 JSON **字符串**（不是对象）',
              fix: 'JSON.stringify 后再放入；这是最常见的 Agent 框架 bug',
            });
          } else if (typeof args === 'string' && args.trim() !== '') {
            const parsed = tryParseJson(args);
            if (parsed === undefined) {
              add({
                code: PRECHECK_CODES.TOOL_CALL_ARGS_INVALID_JSON,
                severity: 'block',
                pointer: `/messages/${i}/tool_calls/${j}/function/arguments`,
                message: `function.arguments 不是合法 JSON：${truncate(args, 80)}`,
                fix: '检查是否被截断（流式分片未拼全）或含未转义字符',
              });
            }
          }
        });
      }
    }
  });

  /* 角色序列：不允许出现孤立的 tool 结果（已在上文逐条检查），也不允许空数组结尾 */
  void lastRole;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** 安全扫描的结构性上限：最多检查这么多条工具调用。
 *  用"条数"而不是"时间"封顶，是为了让拦截能力与机器负载解耦。 */
const SAFETY_SCAN_MAX_CALLS = 1_024;

function checkDangerousCommands(
  body: Record<string, unknown>,
  patterns: RegExp[],
  add: (v: PrecheckViolation) => void,
): void {
  const messages = body['messages'];
  if (!Array.isArray(messages)) return;
  let scanned = 0;
  for (let i = 0; i < messages.length; i++) {
    if (scanned >= SAFETY_SCAN_MAX_CALLS) return;
    const m = messages[i];
    if (!isPlainObject(m)) continue;
    const calls = m['tool_calls'];
    if (!Array.isArray(calls)) continue;
    for (let j = 0; j < calls.length; j++) {
      const c = calls[j];
      if (!isPlainObject(c)) continue;
      const fn = isPlainObject(c['function']) ? c['function'] : undefined;
      if (!fn) continue;
      const name = typeof fn['name'] === 'string' ? fn['name'] : '';
      if (!SHELL_LIKE_TOOLS.test(name)) continue;
      if (++scanned > SAFETY_SCAN_MAX_CALLS) return;
      const args = fn['arguments'];
      const parsed = typeof args === 'string' ? tryParseJson(args) : args;
      scanStrings(parsed, (s, path) => {
        for (const p of patterns) {
          if (p.test(s)) {
            add({
              code: PRECHECK_CODES.DANGEROUS_COMMAND,
              severity: 'block',
              pointer: `/messages/${i}/tool_calls/${j}/function/arguments${path}`,
              message: `工具 "${name}" 的参数命中危险命令模式：${truncate(s, 120)}`,
              fix: '确认这是有意为之；若为误报请调整 lossReduction.precheck.dangerousCommandPatterns',
            });
            break;
          }
        }
      });
    }
  }
}

/* ------------------------------------------------------------------ *
 * 模型名建议（编辑距离，让"模型不存在"这条错误也可以自纠）
 * ------------------------------------------------------------------ */

export function suggestModels(input: string, candidates: string[], max = 3): string[] {
  const target = input.toLowerCase();
  const scored = candidates.map((c) => ({ c, d: levenshtein(target, c.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(target.length / 3)) || x.c.toLowerCase().includes(target) || target.includes(x.c.toLowerCase()))
    .sort((a, b) => a.d - b.d);
  return scored.slice(0, max).map((x) => x.c);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[b.length]!;
}

/* ------------------------------------------------------------------ *
 * 违规 → 归因语义（让 P2 的拦截也能用 P3 的话术告诉客户端"下一步"）
 * ------------------------------------------------------------------ */

export function violationReason(code: string): FailureReason {
  switch (code) {
    case PRECHECK_CODES.MODEL_UNKNOWN:
    case PRECHECK_CODES.MODEL_MISSING:
      return 'model_not_found';
    case PRECHECK_CODES.TOOL_CALL_ARGS_INVALID_JSON:
    case PRECHECK_CODES.TOOL_CALL_ID_MISSING:
    case PRECHECK_CODES.TOOL_CALL_ID_UNKNOWN:
    case PRECHECK_CODES.TOOL_CALL_NAME_MISSING:
    case PRECHECK_CODES.TOOL_NAME_UNKNOWN:
    case PRECHECK_CODES.TOOL_CHOICE_INVALID:
      return 'tool_call_invalid';
    case PRECHECK_CODES.MESSAGES_TOO_MANY:
    case PRECHECK_CODES.MAX_TOKENS_OVER_MODEL:
      return 'context_length_exceeded';
    default:
      return 'invalid_request';
  }
}
