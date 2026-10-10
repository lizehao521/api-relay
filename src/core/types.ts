/**
 * 全局类型契约（冻结层）
 *
 * 约定：
 * - 本文件不 import 任何业务模块，只导出类型与常量，避免循环依赖。
 * - 外部可观测的数据结构（错误体、归因字段、SSE 帧）必须在此处有唯一权威定义。
 * - 内部结构（日志、缓存）也在此定义，保证跨模块同名同义。
 */

/* ------------------------------------------------------------------ *
 * 分层与计费
 * ------------------------------------------------------------------ */

export type TierId = 'free' | 'standard' | 'pro';

/** 分层策略：决定降损层是否开启、限速、额度。 */
export interface TierPolicy {
  id: TierId;
  /** 人类可读名 */
  label: string;
  /** P2 调用前预检 */
  precheck: 'off' | 'observe' | 'enforce';
  /** P3 失败归因卡片的降级形态：off=纯透传；header=仅响应头；full=错误体附加字段 */
  attribution: 'off' | 'header' | 'full';
  /** P8 度量是否记录本层请求（总会有全局计数，此开关控制明细落库） */
  meterDetail: boolean;
  /** 成本感知路由（简单任务走便宜上游） */
  smartRouting: boolean;
  /** 每分钟请求数上限；null = 不限 */
  rpm: number | null;
  /** 并发上限；null = 不限 */
  maxConcurrency: number | null;
  /** 计费模式 */
  billing: 'none' | 'token' | 'subscription';
  /** 周期额度（token）；null = 不限 */
  periodQuotaTokens: number | null;
  /**
   * 按**钱**计的周期额度（人民币元）。与 token 额度是两种口径：
   * token 额度无法表达"¥10 用完为止"——输入 ¥3/M、输出 ¥6/M，同样的 ¥10
   * 折成 token 数取决于输入输出的比例，只能猜。所以钱要按钱算。
   */
  periodQuotaCny?: number | null;
  /** 优先级（越大越先占用上游配额） */
  priority: number;
}

/* ------------------------------------------------------------------ *
 * 模型能力（切模型时的安全前提）
 * ------------------------------------------------------------------ */

/**
 * 单个模型的能力声明。
 *
 * 为什么必需：档位阶梯会在失败时换模型，但**换模型不是等价操作**——
 * 带 tool_calls 的请求切到不支持 function calling 的模型 = 整个任务直接废掉，
 * 比返回错误还糟。所以切之前必须能判断"换过去还成立吗"。
 *
 * 未声明的字段一律视为"未知，允许"——宁可试，也不要因为漏配而拒绝服务。
 */
export interface ModelCapability {
  /** 是否支持 function calling / tools */
  tools?: boolean;
  /** 是否保证严格 JSON 输出 */
  jsonMode?: boolean;
  /** 上下文窗口（token），用于判断长请求能不能换过去 */
  contextWindow?: number;
  /**
   * 输出上限（max_tokens 的最大合法值）。
   *
   * 为什么要它：预检的模型级 max_tokens 检查走 `PrecheckContext.modelMaxTokens`，
   * 而**此前全库没有任何调用方装配它** —— 那道检查是死代码。
   * 各厂商的真实上限差很多且只在自己那边校验（实测 2026-10-02：Agnes 硬上限
   * 65536，超了回 400「max_tokens 不能超过 65536」；MiMo 接受 65537+）。
   * 在这里声明后，越界请求在本地就被拦下，省一次上游往返，也免得客户端
   * 看到各家措辞不一的错误。
   */
  maxOutputTokens?: number;
  /** 人类可读备注（在面板/日志里显示） */
  note?: string;
}

/* ------------------------------------------------------------------ *
 * 上游 Provider
 * ------------------------------------------------------------------ */

export type UpstreamProtocol = 'openai' | 'anthropic' | 'gemini';

export interface ProviderCost {
  /** 输入 token 单价（人民币元 / 百万 token） */
  inputPerMTok: number;
  /** 输出 token 单价 */
  outputPerMTok: number;
  /** 命中 prompt cache 的输入单价（可选） */
  cachedInputPerMTok?: number;
}

export interface ProviderConfig {
  id: string;
  label: string;
  protocol: UpstreamProtocol;
  baseUrl: string;
  /** 支持 {ENV:NAME} / {ENV:NAME:-default} 插值。单 key 写法。可与 apiKeys 同时给。 */
  apiKey: string;
  /**
   * 多 key 池（轮换使用）。与 apiKey 二选一或并用：有效集合 = apiKeys ∪ [apiKey]。
   *
   * 为什么需要它：单个上游 key 撞限流后若没有第二个 key，整个上游就被摘掉了。
   * 多 key 轮换把"上游可用性"从"单 key 可用性"里解耦出来——这是 OneAPI 缺的能力
   * （OneAPI 的 Channel.Key 是单个 string），也是真实中转站最常用的稳定性手段。
   */
  apiKeys?: string[];
  models: string[];
  /** 模型别名映射：用户请求的 model -> 上游真实 model */
  modelMap?: Record<string, string>;
  cost?: ProviderCost;
  /**
   * **刊例价（牌面价）**，只用于"按牌面价折算"这一列，不参与额度与计费。
   *
   * 与 `cost` 的关系：`cost` 是**实付**（当前有效价，含限时优惠），`listCost` 是原价。
   * 上游做限时免费时（Agnes 的 flash 系列现价 $0），实付是 0、牌面价不是 0 ——
   * 两个都留着，既能看真实毛利，也能说清"这些量按牌面值多少钱"。
   * 不填则等同于 `cost`。
   */
  listCost?: ProviderCost;
  /**
   * **按上游型号**覆盖单价。键是**上游真实模型名**（不是客户请求的别名）。
   *
   * 为什么必须有这一层：`cost` 是挂在**厂商**上的，同一家厂商里不同型号单价常常差很多 ——
   * 2026-09-14 实测 Agnes 官方定价：`agnes-3.0-flash` / `agnes-2.5-flash` **当前限时 $0**，
   * 而 `agnes-2.5-pro` 是 $0.45/$0.90。只有一个厂商级价目时，这两种型号被迫共用一个价，
   * 算出来的"上游成本"必然有一头是错的。
   *
   * 未命中时回退到 `cost`。
   */
  modelCosts?: Record<string, ProviderCost>;
  /** 按型号覆盖**刊例价**（同上，未命中回退 `listCost`）。 */
  modelListCosts?: Record<string, ProviderCost>;
  weight?: number;
  priority?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * 用 **HTTP/2** 访问这个上游。
   *
   * 2026-09-14 实测（`api.agnes-ai.cn`）：同一个请求
   *   h2   0.13~0.35s 稳定；h1.1  0.5~20s 抖动；undici(h1.1) 能挂到 54s。
   * 卡的是"等上游响应头"（建连始终 60~130ms 正常），所以是上游 h1.1 路径本身的问题。
   * Node 的 fetch 只支持 h1.1 —— 这条上游就必须开这个开关。
   * 建连阶段失败会自动回退 h1.1（响应阶段失败不回退，避免重复发请求）。
   */
  http2?: boolean;
  /** 每上游并发上限 */
  concurrency?: number;
  /** 静态禁用以支持手工摘除 */
  disabled?: boolean;
  /** 该上游要求的额外请求头 */
  headers?: Record<string, string>;
  /**
   * 鉴权格式。默认 `bearer`（OpenAI 标准：`Authorization: Bearer <key>`）。
   *
   * 需要这个开关是因为现实里有厂商不守标准：Agnes（apihub.agnes-ai.com）要求
   * `Authorization: <token>` **不带 Bearer 前缀**，带上反而 401。
   * 这类差异必须靠配置表达，而不是让代码去猜——猜错了会静默鉴权失败。
   */
  auth?: {
    format: 'bearer' | 'bearerless' | 'api-key-header' | 'x-api-key';
    /** format=api-key-header 时的头名，默认 'api-key' */
    headerName?: string;
  };
  /** 该上游的标签，用于路由约束（如 region=cn, kind=cheap） */
  tags?: string[];
}

/** 运行时上游健康度（由失败归因驱动） */
export interface ProviderHealth {
  providerId: string;
  healthy: boolean;
  /** 连续失败次数 */
  consecutiveFailures: number;
  /** 熔断恢复时间戳（ms） */
  openUntil: number;
  /** 最近一次失败原因 */
  lastFailureReason?: FailureReason;
  lastErrorAt?: number;
  ewmaLatencyMs: number;
  totalRequests: number;
  totalFailures: number;
}

/* ------------------------------------------------------------------ *
 * 失败归因（P3）
 * ------------------------------------------------------------------ */

export type FailureReason =
  | 'rate_limited'
  | 'quota_exhausted'
  | 'auth_invalid'
  | 'permission_denied'
  | 'model_not_found'
  | 'model_overloaded'
  | 'upstream_timeout'
  | 'upstream_unavailable'
  | 'network_error'
  | 'context_length_exceeded'
  | 'content_filtered'
  | 'invalid_request'
  | 'tool_call_invalid'
  | 'stream_interrupted'
  /**
   * 客户端自己断开（超时/取消/关页面）。**不是**上游故障，也不是中转站故障：
   * 曾经它被记成 relay_internal_error，于是运维会去查一个并不存在的网关 bug，
   * 而且它还会被计入上游熔断 —— 等于"客户端超时"能把上游对所有人摘掉。
   */
  | 'client_aborted'
  | 'relay_internal_error'
  | 'unknown';

export type QuickAction =
  | 'retry_with_backoff'
  | 'retry_same'
  | 'reduce_context'
  | 'raise_max_tokens'
  | 'switch_model'
  | 'rewrite_input'
  | 'top_up_balance'
  | 'fix_credentials'
  | 'fix_request'
  | 'wait_and_retry'
  | 'abort';

export interface SuggestedNext {
  /** 机器可执行动作 */
  action: QuickAction;
  /** 归因到该动作时建议等待的毫秒数（仅 retry_with_backoff / wait_and_retry 有意义） */
  retryAfterMs?: number;
  /** 该动作是否由中转站自动执行过 */
  autoPerformed?: boolean;
}

/**
 * 归因卡片：唯一对外暴露的降损结构。
 * 注意：它只出现在「错误路径」（HTTP >= 400）或非流式响应的附加字段上，
 * 绝不出现在成功响应体的语义字段中（见 docs/research/03）。
 */
export interface AttributionCard {
  failure_reason: FailureReason;
  /** 人话解释，一句话 */
  message: string;
  /** 建议的下一步（可执行） */
  suggested_next: SuggestedNext;
  recoverable: boolean;
  /** 被判定的上游（providerId），relay 自身错误时为 'relay' */
  upstream: string;
  /** 置信度 0~1，规则命中越精确越高 */
  confidence: number;
  /** 对客户端隐藏的排障线索（默认不返回，仅 --verbose-attribution 或 pro 层返回） */
  evidence?: string[];
}

/** 归因层输入 */
export interface ClassifyInput {
  httpStatus?: number;
  /** 上游响应体（字符串，可能是 HTML/JSON/纯文本） */
  bodyText?: string;
  /** 上游响应头（已小写键） */
  headers?: Record<string, string>;
  /** 网络层错误 */
  networkError?: { code?: string; message: string };
  /** 客户端是否已取消 */
  clientAborted?: boolean;
  providerId: string;
  model: string;
  /** 本次请求重试次数（用于把 429 的退避建议算进去） */
  attempt: number;
  /** relay 自身异常 */
  relayError?: { message: string; stack?: string };
}

/* ------------------------------------------------------------------ *
 * 调用前预检（P2）
 * ------------------------------------------------------------------ */

export type PrecheckSeverity = 'info' | 'warn' | 'block';

export interface PrecheckViolation {
  code: string;
  severity: PrecheckSeverity;
  /** JSON Pointer 风格定位，如 /messages/2/tool_calls/0/function/arguments */
  pointer: string;
  message: string;
  fix: string;
}

export interface PrecheckResult {
  /** 未发现问题 */
  ok: boolean;
  violations: PrecheckViolation[];
  /** 已按 fail-open 规则改写的请求体（可选）。绝不删除语义字段 */
  repaired?: Record<string, unknown>;
  /** 预检自身耗时（微秒） */
  durationUs: number;
  /** 预检因内部异常而放弃（fail-open 已放行） */
  degraded?: boolean;
}

/** 预检在 HTTP 层的处置结论 */
export type PrecheckDisposition = 'pass' | 'observe' | 'reject';

/* ------------------------------------------------------------------ *
 * 降损运行时配置
 * ------------------------------------------------------------------ */

export interface LossReductionConfig {
  precheck: {
    enabled: boolean;
    /** 命中 block 级规则时的处置：reject=返回 400；observe=记录后透传 */
    onBlock: 'reject' | 'observe';
    /** 单次预检允许的最大耗时（微秒），超过即 fail-open 放行 */
    budgetUs: number;
    maxMessages: number;
    maxTools: number;
    /**
     * `max_tokens` 的绝对天花板（模型没声明更严上限时用它）。
     *
     * 为什么需要：模型级上限走 `PrecheckContext.modelMaxTokens`，而**全库没有任何
     * 调用方传过它** —— 那道检查是死代码。于是 `max_tokens: 1e308`（有限、整数、>=1）
     * 能穿过预检直接打到上游，本地拦截形同虚设（实测 999999999 / 1e308 均 ok=true）。
     * 这里补一个兜底绝对值：模型声明了用声明的，没声明用这个。
     * 取 100 万是因为真实模型输出上限最高约 128K，这个值只抓明显的笔误/滥用，
     * 不会误杀合法请求；运营可在 relay-net.yaml 调整。
     */
    maxTokensCeiling: number;
    /** 危险命令黑名单（用于 tool_calls.arguments 内的 shell 字符串） */
    dangerousCommandPatterns: string[];
  };
  attribution: {
    enabled: boolean;
    /** 是否返回 evidence 字段（默认否，避免泄露上游内部信息） */
    includeEvidence: boolean;
    /** 429/5xx 自动重试次数 */
    autoRetry: number;
    /**
     * 精确模型名请求时，是否用「阶梯里的同档后继模型」补齐阶梯（默认 true）。
     *
     * 关掉它 => resolveLadder 对精确模型名退回单阶 [model]，只剩横向换供应商的
     * 2 × (1+autoRetry) 次尝试，竖向换模型的兜底一步都没有（429 直接丢回客户端）。
     * 打开它（默认）=> 客户点名的模型仍是第一阶，只在它横向兜底也耗尽时，
     * 才沿运营在 modelLadders 里声明过的同档等价关系往后换 ——
     * 即让客户的任务跑完，而不是把错误丢回去。
     */
    siblingModelFallback: boolean;
    /** 自动重试的退避基数（毫秒） */
    backoffBaseMs: number;
    backoffMaxMs: number;
    /** 哪些 failure_reason 允许自动重试 */
    retryableReasons: FailureReason[];
    /** 熔断：连续失败多少次摘除上游 */
    breakerThreshold: number;
    /** 熔断打开时长（毫秒） */
    breakerCooldownMs: number;
  };
  meter: {
    enabled: boolean;
    /** 明细分批落库的批量大小 */
    batchSize: number;
    /** 明细分批落库间隔（毫秒） */
    flushIntervalMs: number;
    /** 明细保留天数 */
    retentionDays: number;
    /** 是否记录请求/响应体的 sha256（不落正文） */
    hashPayloads: boolean;
    /** 哈希盐，来自配置或随机生成 */
    hashSalt: string;
  };
  trace: {
    enabled: boolean;
    /** 记录到内存环里的最近条数 */
    ringSize: number;
    /** 是否落库 */
    persist: boolean;
    /** 单条 trace 最大步骤数 */
    maxSteps: number;
  };
  fingerprint: {
    enabled: boolean;
    /** 视为 Agent 的关键特征命中阈值 */
    agentThreshold: number;
  };
}

/* ------------------------------------------------------------------ *
 * 请求上下文
 * ------------------------------------------------------------------ */

export interface ClientIdentity {
  /** 客户端 API key 的 id（不是明文 key） */
  keyId: string;
  keyLabel: string;
  tier: TierId;
  /** 归属用户/租户 */
  tenantId: string;
}

export type ClientKind = 'agent' | 'app' | 'script' | 'unknown';

/** 无状态（或短窗口计数）客户端指纹，用于分层识别，不存会话正文 */
export interface ClientFingerprint {
  kind: ClientKind;
  /** 0~1 */
  agentScore: number;
  features: {
    hasToolCalls: boolean;
    hasTools: boolean;
    multiTurn: boolean;
    roleAlternation: number;
    systemPromptHash: string;
    streamRequested: boolean;
    jsonMode: boolean;
    /** 客户端 User-Agent 原始值（可选） */
    userAgent?: string;
  };
  /** 命中阈值所依据的版本号，便于指标口径演进 */
  ruleVersion: number;
}

/** 路由决策 */
export interface RouteDecision {
  providerId: string;
  upstreamModel: string;
  reason:
    | 'explicit'
    | 'model_map'
    | 'cheapest'
    | 'priority'
    | 'weighted'
    | 'failover'
    | 'smart_routing';
  /** 同一请求内的第几次尝试（0 起） */
  attempt: number;
  /** 阶梯信息：第几阶 / 共几阶（未启用阶梯时为 0/1） */
  ladderStep?: { index: number; total: number; from: string };
  candidatesConsidered: string[];
  /** 预计成本（元 / 百万 token 加权），用于 smart routing 解释 */
  estimatedCostPerMTok?: number;
}

/** 一次请求在处理管道内的完整上下文 */
export interface RelayRequestContext {
  requestId: string;
  /** 请求开始的**墙上钟**（Date.now()）。用于去重窗口、限流等需要绝对时间的场景。 */
  startedAt: number;
  /**
   * 请求开始的**单调钟**（monotonicMs()）。**算耗时只能用这个**。
   *
   * 曾经有两处（流式 onEnd、JSON 兜底）写成 `monotonicMs() - ctx.startedAt`，
   * 把单调钟减了墙上钟 —— 结果 duration_ms 被写成 `-1789228908474` 这种巨负值
   * （量级 ≈ -(epoch) + 进程运行毫秒）。它不报错，只是让面板的
   * 平均耗时 / p95 / 开销比全部失真，而看的人还以为那是真实延迟。
   */
  startedMono: number;
  traceId: string;
  method: string;
  path: string;
  client: ClientIdentity;
  fingerprint: ClientFingerprint;
  requestedModel: string;
  stream: boolean;
  /** 请求体 sha256（不落正文） */
  payloadHash: string;
  /** 请求体字节数（用于度量传话层体积） */
  payloadBytes: number;
  isToolCalling: boolean;
  precheck?: {
    result: PrecheckResult;
    disposition: PrecheckDisposition;
  };
  routes: RouteDecision[];
  attribution?: AttributionCard;
  usage?: UsageBreakdown;
  bytesIn: number;
  bytesOut: number;
  durationMs: number;
  ttfbMs?: number;
  /** 降损层自身开销（微秒） */
  overheadUs: { precheck: number; classify: number; meter: number };
  outcome: 'success' | 'client_error' | 'upstream_error' | 'relay_error' | 'aborted';
  httpStatus?: number;
}

export interface UsageBreakdown {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 命中上游 prompt cache 的输入 token（DeepSeek/OpenAI/Agnes 都报这个，直接影响成本） */
  cachedPromptTokens?: number;
  /** 推理模型单独统计的思考 token（Agnes: completion_tokens_details.reasoning_tokens） */
  reasoningTokens?: number;
  /** 计价结果（人民币元）—— **实付**口径 */
  costCny?: number;
  /** 同一份用量按**刊例价**折算的人民币金额（牌面价，用于对外报价对比） */
  listCostCny?: number;
}

/* ------------------------------------------------------------------ *
 * SSE 与协议
 * ------------------------------------------------------------------ */

export interface SseRecord {
  event?: string;
  data: string;
}

/** transcript：流式期间从 SSE 增量里重建的符号态（P1 只读副本，用于度量与审计） */
export interface StreamTranscript {
  chunkCount: number;
  finishReason?: string;
  model?: string;
  responseId?: string;
  usage?: UsageBreakdown;
  /** tool_calls 分片重组后的函数名列表 */
  toolCalls?: { index: number; id?: string; name?: string; argumentBytes: number }[];
  /** 内容字符数（含思维链字段） */
  contentChars: number;
  reasoningChars: number;
  /** 帧格式异常（用于发现协议破坏） */
  malformedFrames: number;
  /** 流中途的错误帧（HTTP 200 + data:{"error":...} 形态） */
  streamError?: string;
  sawDone: boolean;
}

/* ------------------------------------------------------------------ *
 * 度量（P8）
 * ------------------------------------------------------------------ */

export interface MeterRecord {
  traceId: string;
  requestId: string;
  ts: number;
  keyId: string;
  tenantId: string;
  tier: TierId;
  clientKind: ClientKind;
  agentScore: number;
  model: string;
  providerId: string;
  stream: boolean;
  toolCalling: boolean;
  outcome: RelayRequestContext['outcome'];
  httpStatus: number;
  durationMs: number;
  ttfbMs: number | null;
  bytesIn: number;
  bytesOut: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  /** **实付**成本（人民币元）—— 按当前有效价（含限时优惠）算 */
  costCny: number;
  /**
   * **按刊例价折算**的成本（人民币元）—— 牌面价，不是实付。
   *
   * 为什么要两列：上游常有阶段性优惠（2026-09-14 实测 Agnes 的 flash 系列现价 $0、刊例价 $0.05/$0.15）。
   * 只看实付就不知道"这些量按牌面价值多少钱"（对外报价要用它），
   * 只看刊例价就不知道真实毛利。两个都记，才不会互相冒充。
   */
  listCostCny: number;
  attemptCount: number;
  failureReason: FailureReason | null;
  quickAction: QuickAction | null;
  recoverable: boolean | null;
  precheckViolations: number;
  precheckBlocked: boolean;
  precheckDegraded: boolean;
  precheckUs: number;
  classifyUs: number;
  /** 传话层降损指标：归因是否把「不可读错误」变成了「可执行下一步」 */
  attributionDelivered: boolean;
  /** 同一 key + 同 payload 在 60s 窗口内的重复次数（>1 即无效重试） */
  duplicateInWindow: number;
}

export interface MeterSummaryRow {
  key: string;
  requests: number;
  errors: number;
  errorRate: number;
  totalTokens: number;
  costCny: number;
  /** 同一份用量按**刊例价**折算的金额（牌面价，不是实付） */
  listCostCny: number;
  p50Ms: number;
  p95Ms: number;
  avgTtfbMs: number;
}

export interface MeterSummary {
  from: number;
  to: number;
  overall: MeterSummaryRow;
  byModel: MeterSummaryRow[];
  byProvider: MeterSummaryRow[];
  byTier: MeterSummaryRow[];
  byClientKind: MeterSummaryRow[];
  byFailureReason: { reason: FailureReason; count: number; recoverablePct: number }[];
  byQuickAction: { action: QuickAction; count: number }[];
  /**
   * 客户端 key 鉴权失败（网关回的 401）。必须与"上游拒绝了你配置的密钥"分开，
   * 因为修复动作完全不同：一个要换客户端手上的 key，一个要去厂商控制台换密钥。
   */
  clientAuthFailures: { count: number; lastAt: number };
  /** 降损层收益口径 */
  lossReduction: {
    /** 归因卡片投递率 = 已投递归因的错误数 / 错误总数 */
    attributionCoverage: number;
    /** 可恢复错误中由中转站自动重试成功的数量 */
    autoRecovered: number;
    /** 60s 窗口内重复请求（无效重试）次数 */
    duplicateRetries: number;
    /** 预检拦截的畸形调用数 */
    precheckBlocked: number;
    /** 预检误拦/放行放行的降级次数 */
    precheckDegraded: number;
    /** 降损层自身开销占比（us / 总耗时 us） */
    overheadRatio: number;
  };
}

/* ------------------------------------------------------------------ *
 * 轨迹（P5 降级形态）
 * ------------------------------------------------------------------ */

export type TraceStage =
  | 'auth'
  | 'precheck'
  | 'fingerprint'
  | 'route'
  | 'upstream_request'
  | 'upstream_response'
  | 'classify'
  | 'retry'
  | 'hedge'
  | 'stream'
  | 'meter'
  | 'respond';

export interface TraceStep {
  stage: TraceStage;
  at: number;
  /** 相对请求开始的毫秒偏移 */
  offsetMs: number;
  ok: boolean;
  summary: string;
  detail?: Record<string, string | number | boolean>;
  error?: string;
}

export interface TraceRecord {
  traceId: string;
  requestId: string;
  startedAt: number;
  durationMs: number;
  steps: TraceStep[];
  failedAtStage?: TraceStage;
  outcome: RelayRequestContext['outcome'];
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

export interface ServerConfig {
  host: string;
  port: number;
  /** 管理接口 token；未设置则管理接口仅允许 127.0.0.1 */
  adminToken?: string;
  /**
   * 是否信任 X-Forwarded-For。
   *
   * **当前无任何作用（保留字段）**：网关不记录客户端 IP —— 计量表（meter）没有 IP 列，
   * 限流按 key 归属（`store.incrRate(keyId, window)`），审计与鉴权失败记录直接读
   * `req.socket.remoteAddress`（管理面 audit actor、admin 鉴权失败计数、公开端点本机闸门
   * 三处都是）。此前唯一消费方 `clientIp()` 因零读取点已于 r19 删除。
   *
   * 保留而不是删掉：relay-net.yaml 与环境变量 RELAY_TRUST_PROXY 都在用它，
   * 删字段会让既有配置装载失败。若将来要恢复「记录真实客户端 IP」，注意不可直接信任
   * XFF 第一段（那是客户端自带的，可伪造）—— 要么按已知代理层数从右往左取，要么只在
   * 对端确实是受信代理 IP 时才采信。
   */
  trustProxy: boolean;
  /** 全局请求体上限（字节） */
  maxBodyBytes: number;
  /** 上游请求总超时（毫秒） */
  upstreamTimeoutMs: number;
  /** 上游首字节超时（毫秒） */
  upstreamTtfbTimeoutMs: number;
  /**
   * 上游**停摆**超时（毫秒）：数据流中断多久算上游死了。
   *
   * 与 `upstreamTtfbTimeoutMs` 的区别很关键：首字节超时只管到"响应头"。
   * 实测 Agnes 国际线路会在 1 秒内回响应头、然后 body 长时间（>150 秒）不产出，
   * 首字节定时器当场解除 → 请求被吊到总超时，客户端只能自己断。
   * 不设则继承 `upstreamTtfbTimeoutMs`（对"头"和"体"用同一个耐心）。
   */
  upstreamStallTimeoutMs?: number;
  /**
   * 流式请求的"提前提交"宽限（毫秒）。>0 时启用。
   *
   * 背景（2026-09-15 客户事故）：Agnes 对 14 万 token 的超长轨迹要 15~90 秒
   * 才产出**第一个内容块**，而网关此前要等第一个内容块才写响应头 —— 客户在
   * 这几十秒里收不到任何字节（连 200 都没有），客户端/中间代理按超时直接断开，
   * 表现就是"只回了一条消息就没反应"。
   *
   * 开启后：等待超过这个宽限还没拿到上游内容，就先把 200 + SSE 响应头提交出去，
   * 再每隔 streamHeartbeatMs 发一个 SSE 注释行（: keepalive）维持连接活性。
   * 保留宽限是为了留住"快失败仍能换线路/回标准错误码"的能力：宽限内失败走原逻辑。
   *
   * ⚠️ 代价：一旦提前提交，慢请求就**拿不到**上游 passthrough 头与
   * x-relay-loss-reduction 归属头（头已发出，无法再补）；若之后上游才失败，
   * 只能用 SSE 错误帧告知，无法改 HTTP 状态码。0 = 关闭（默认）。
   */
  streamCommitGraceMs?: number;
  /**
   * 提前提交后的心跳间隔（毫秒，默认 5000）。写 SSE 注释行 : keepalive，
   * 属 SSE 规范内的注释，兼容客户端会忽略；用于防止客户端"空闲读超时"。
   */
  streamHeartbeatMs?: number;
  /**
   * 双线路对冲（毫秒）。>0 时启用。
   *
   * 同一模型有多个可用上游（同名模型 + 多条线路）时：主线路超过这个时间还没产出
   * 首个响应，就**并行**发起备线路，谁先成功用谁，另一条立即中止。
   *
   * 目的不是压低中位数延迟，而是**提高任务完成率**：两条 Agnes 线路"慢但都返回
   * 200"时，旧的"出错才换线"机制根本不介入，客户只能干等 15~90 秒。对冲后取两条
   * 里先出内容的那条。主线路在宽限内就成功/失败时行为与旧版完全一致（失败照旧走
   * 重试与换阶）。0 = 关闭（默认）。
   */
  hedgeDelayMs?: number;
  /** 优雅退出等待（毫秒） */
  shutdownGraceMs: number;
  /**
   * 是否启用只读额度/面板端点 `GET /v1/quota`、`/v1/panel`（默认 true）。
   * 它们供本机面板/插件读取；**默认只允许 127.0.0.1 访问**。
   */
  publicQuota?: boolean;
  /**
   * 是否允许**非本机**读取上面那两个端点（默认 false）。
   *
   * 它们会暴露用量计数、请求轨迹（含上游错误文案）、key 列表与上游信息，
   * 所以默认不对局域网/公网开放。确实要远程读时打开它，并在反代上做 IP 白名单。
   */
  publicQuotaRemote?: boolean;
}

export interface ClientKeyConfig {
  id: string;
  label: string;
  /** 允许用 {ENV:NAME} 插值；也允许 'plain:' 前缀 */
  key: string;
  tier: TierId;
  tenantId: string;
  enabled: boolean;
  /** 允许访问的模型（空 = 全部） */
  allowedModels?: string[];
  /** 覆盖分层默认额度（token / 周期） */
  quotaOverride?: number;
  /** 按钱计的额度（人民币元），优先于分层默认 */
  quotaCny?: number;
  /** 到期时间戳（ms） */
  expiresAt?: number;
}

/** 知识库（垂直 Agent 能力）配置 */
export interface KbConfig {
  /** KB 专用 SQLite 库路径（与主度量库分离，避免把高频写和低频读写绑一起）。缺省 = 未启用 */
  path?: string;
  /** 分块大小（字符），缺省 512 */
  chunkSize?: number;
  /** 分块重叠（字符），缺省 64 */
  chunkOverlap?: number;
}

/** 内部 Agent 系统（自托管运维/迭代决策环）配置 */
export interface AgentConfig {
  /** 是否启用内部 Agent 系统。缺省 false */
  enabled?: boolean;
  /** Agent 调 LLM 用的客户端 key id（在 config.clients 里声明，走本网关自身鉴权/计量闭环） */
  clientId?: string;
  /** LLM 模型（走本网关 /v1/chat/completions） */
  model?: string;
  /** 运维巡检周期（毫秒）。0 = 只手动触发不自动跑 */
  intervalMs?: number;
  /** 单轮 LLM 超时（毫秒） */
  llmTimeoutMs?: number;
  /** 自动巡检发现的迭代建议是否直接写 KB（默认 true；仅人工确认的才自动写） */
  autoWriteKb?: boolean;
  /** 单轮最多给 LLM 喂多少条最近事件 */
  recentEvents?: number;
  /** 迭代知识沉淀到哪个 KB（缺省 'kb_demo'；该 KB 不存在则跳过回写） */
  kbId?: string;
}

export interface RelayConfig {
  server: ServerConfig;
  storage: {
    driver: 'sqlite' | 'memory';
    path: string;
  };
  /** 知识库（垂直 Agent 能力）。缺省 / path 为空 = 未启用，网关其余功能不受影响 */
  kb?: KbConfig;
  /** 内部 Agent 系统（自托管运维/迭代决策环）。缺省 = 未启用 */
  agent?: AgentConfig;
  lossReduction: LossReductionConfig;
  tiers: Record<TierId, TierPolicy>;
  providers: ProviderConfig[];
  clients: ClientKeyConfig[];
  /** 模型别名 -> 目标模型（跨上游统一命名） */
  modelAliases: Record<string, string>;
  /**
   * 档位阶梯（竖向）：请求用的模型名 -> 按顺序尝试的模型列表。
   *
   * 语义：第一个是首选，失败就试第二个，依次往下。所以
   *   旗舰档 [pro, 3.0-flash, 2.5-flash]  → 旗舰挂了往下推
   *   极速档 [2.5-flash, 3.0-flash, pro]  → 极速挂了往上推
   *   平衡档 [3.0-flash, 2.5-flash, pro]  → 同层先随便切，再向外
   *
   * 目的不是"降级省钱"，而是**让客户的任务自动跑完**——用户明确接受
   * "Agent 和不同模型沟通"，所以这里是产品选择，不是工程兜底。
   */
  modelLadders?: Record<string, string[]>;
  /** 模型能力表：切模型前用它判断"换过去还成立吗" */
  modelCapabilities?: Record<string, ModelCapability>;
  /** 默认上游（显式指定模型未命中时的兜底） */
  defaultProvider?: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** 配置文件路径（仅记录） */
  sourcePath?: string;
}
