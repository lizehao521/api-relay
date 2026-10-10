/**
 * 配置加载、默认值与校验。
 *
 * 优先级：内置默认 < YAML 文件 < 环境变量（RELAY_*）< CLI 参数。
 * 所有密钥一律走 {ENV:NAME} 插值，配置文件中不允许出现明文 key。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseYaml, interpolateTree } from './yaml.js';
import type {
  ClientKeyConfig,
  LossReductionConfig,
  ProviderConfig,
  RelayConfig,
  TierId,
  TierPolicy,
} from './types.js';
import { ownLookup, sha256Hex } from '../util/index.js';

export const DEFAULT_CONFIG_PATH = 'config/relay.yaml';

export const DEFAULT_TIERS: Record<TierId, TierPolicy> = {
  free: {
    id: 'free',
    label: '免费引流层',
    precheck: 'off',
    attribution: 'off',
    meterDetail: false,
    smartRouting: false,
    rpm: 20,
    maxConcurrency: 4,
    billing: 'none',
    periodQuotaTokens: 200_000,
    priority: 0,
  },
  standard: {
    id: 'standard',
    label: '标准层（按 token）',
    precheck: 'observe',
    attribution: 'header',
    meterDetail: true,
    smartRouting: false,
    rpm: 300,
    maxConcurrency: 32,
    billing: 'token',
    periodQuotaTokens: null,
    priority: 10,
  },
  pro: {
    id: 'pro',
    label: 'Pro 层（订阅 + 降损全开）',
    precheck: 'enforce',
    attribution: 'full',
    meterDetail: true,
    smartRouting: true,
    rpm: 1200,
    maxConcurrency: 128,
    billing: 'subscription',
    periodQuotaTokens: 5_000_000,
    priority: 20,
  },
};

export function defaultLossReduction(): LossReductionConfig {
  return {
    precheck: {
      enabled: true,
      onBlock: 'reject',
      budgetUs: 3_000,
      maxMessages: 512,
      maxTools: 128,
      // max_tokens 绝对天花板：模型没声明 modelMaxTokens 时的兜底（那道检查此前是死代码，
      // max_tokens=1e308 能穿过预检）。运营可调。
      maxTokensCeiling: 1_000_000,
      dangerousCommandPatterns: [
        'rm\\s+-rf\\s+/(?!\\w)',
        'mkfs(\\.|\\s)',
        'dd\\s+if=.*of=/dev/',
        ':(){:\\|:&};:',
        'chmod\\s+-R\\s+777\\s+/',
        '>\\s*/dev/sd[a-z]',
        'curl[^\\n]*\\|\\s*(ba)?sh',
        'wget[^\\n]*\\|\\s*(ba)?sh',
      ],
    },
    attribution: {
      enabled: true,
      includeEvidence: false,
      autoRetry: 1,
      // 精确模型名请求时用同档后继模型补齐阶梯：横向换供应商耗尽后，仍能沿运营
      // 声明过的等价档竖向换模型，而不是把 429 丢回客户端。置 false 退回单阶。
      siblingModelFallback: true,
      backoffBaseMs: 400,
      backoffMaxMs: 8_000,
      retryableReasons: [
        'rate_limited',
        'upstream_timeout',
        'upstream_unavailable',
        'network_error',
        'model_overloaded',
        'stream_interrupted',
      ],
      breakerThreshold: 5,
      breakerCooldownMs: 30_000,
    },
    meter: {
      enabled: true,
      batchSize: 200,
      flushIntervalMs: 2_000,
      retentionDays: 30,
      hashPayloads: true,
      hashSalt: '',
    },
    trace: {
      enabled: true,
      ringSize: 500,
      persist: true,
      maxSteps: 64,
    },
    fingerprint: {
      enabled: true,
      agentThreshold: 0.6,
    },
  };
}

export function defaultConfig(): RelayConfig {
  return {
    server: {
      host: '127.0.0.1',
      port: 8787,
      trustProxy: false,
      publicQuota: true,
      maxBodyBytes: 8 * 1024 * 1024,
      upstreamTimeoutMs: 600_000,
      upstreamTtfbTimeoutMs: 120_000,
      // 默认关闭：提前提交会牺牲 passthrough 头，按部署显式开启（relay-net.yaml 已开）。
      streamCommitGraceMs: 0,
      streamHeartbeatMs: 5_000,
      // 默认关闭：对冲会翻倍上游调用，按部署显式开启（relay-net.yaml 已开）。
      hedgeDelayMs: 0,
      shutdownGraceMs: 8_000,
    },
    storage: { driver: 'sqlite', path: 'data/relay.db' },
    lossReduction: defaultLossReduction(),
    tiers: structuredClone(DEFAULT_TIERS),
    providers: [],
    clients: [],
    modelAliases: {},
    logLevel: 'info',
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** 深合并：数组与标量整体替换，对象递归合并 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(patch)) return patch as unknown as T;
  if (typeof patch !== 'object') return patch as unknown as T;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return patch as unknown as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge((out as Record<string, unknown>)[k], v) : v;
  }
  return out as unknown as T;
}

export interface LoadConfigOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
  /** 直接覆盖部分字段（用于测试） */
  override?: DeepPartial<RelayConfig>;
  /** 文件不存在时是否报错（默认 true） */
  requireFile?: boolean;
  /**
   * 缺失的必需环境变量是否放行（占位符替换 + 收集名字）。
   * `relay check` 用它做 dry-run：不导出密钥也能校验整份配置。
   */
  lenientEnv?: boolean;
}

export interface LoadConfigResult {
  config: RelayConfig;
  /** 配置中引用但环境里缺失的变量名（lenientEnv 模式下有意义） */
  missingEnv: string[];
}

export function loadConfigDetailed(options: LoadConfigOptions = {}): LoadConfigResult {
  const env = options.env ?? process.env;
  const path = options.path ?? env['RELAY_CONFIG'] ?? DEFAULT_CONFIG_PATH;
  const abs = resolve(path);
  const missingEnv: string[] = [];

  let config = defaultConfig();
  config.sourcePath = abs;

  if (existsSync(abs)) {
    const text = readFileSync(abs, 'utf8');
    const parsed = parseYaml(text);
    if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
      throw new Error(`配置文件顶层必须是映射对象: ${abs}`);
    }
    const onMissing = options.lenientEnv
      ? (name: string): void => {
          if (!missingEnv.includes(name)) missingEnv.push(name);
        }
      : undefined;
    const interpolated = interpolateTree(parsed ?? {}, env, onMissing);
    config = deepMerge(config, interpolated);
    // 占位符还原为空串，避免把 __MISSING_ENV_X__ 当成真 key 用于校验
    if (options.lenientEnv) config = blankPlaceholders(config) as RelayConfig;
  } else if (options.requireFile !== false) {
    throw new Error(`配置文件不存在: ${abs}（可用 RELAY_CONFIG 指定，或从 config/relay.example.yaml 复制）`);
  }

  config = applyEnvOverrides(config, env, options.override);
  if (!options.lenientEnv) validateConfig(config);
  if (!config.lossReduction.meter.hashSalt) {
    config.lossReduction.meter.hashSalt = env['RELAY_HASH_SALT'] ?? sha256Hex(`salt:${abs}`).slice(0, 32);
  }
  return { config, missingEnv };
}

/** 便捷版：只要配置对象（默认严格校验） */
export function loadConfig(options: LoadConfigOptions = {}): RelayConfig {
  return loadConfigDetailed(options).config;
}

/** 把 __MISSING_ENV_X__ 占位符替换回空串 */
function blankPlaceholders(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/__MISSING_ENV_[A-Za-z0-9_]+__/g, '');
  if (Array.isArray(value)) return value.map(blankPlaceholders);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = blankPlaceholders(v);
    return out;
  }
  return value;
}

function envInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const v = env[key];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`环境变量 ${key} 必须是数字，当前值: ${v}`);
  return n;
}

function envBool(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  const v = env[key];
  if (v === undefined || v === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function applyEnvOverrides(
  config: RelayConfig,
  env: NodeJS.ProcessEnv = process.env,
  override?: DeepPartial<RelayConfig>,
): RelayConfig {
  const patch: DeepPartial<RelayConfig> = {};

  const port = envInt(env, 'RELAY_PORT');
  const host = env['RELAY_HOST'];
  const logLevel = env['RELAY_LOG_LEVEL'];
  const adminToken = env['RELAY_ADMIN_TOKEN'];
  const dbPath = env['RELAY_DB_PATH'];
  const storageDriver = env['RELAY_STORAGE_DRIVER'];
  const trustProxy = envBool(env, 'RELAY_TRUST_PROXY');
  const precheckEnabled = envBool(env, 'RELAY_PRECHECK_ENABLED');
  const attributionEnabled = envBool(env, 'RELAY_ATTRIBUTION_ENABLED');
  const meterEnabled = envBool(env, 'RELAY_METER_ENABLED');
  const traceEnabled = envBool(env, 'RELAY_TRACE_ENABLED');

  patch.server = {};
  if (port !== undefined) patch.server.port = port;
  if (host !== undefined) patch.server.host = host;
  if (adminToken !== undefined) patch.server.adminToken = adminToken;
  if (trustProxy !== undefined) patch.server.trustProxy = trustProxy;

  if (dbPath !== undefined || storageDriver !== undefined) {
    patch.storage = {};
    if (dbPath !== undefined) patch.storage.path = dbPath;
    if (storageDriver === 'sqlite' || storageDriver === 'memory') patch.storage.driver = storageDriver;
  }

  // 知识库（垂直 Agent 能力）：环境变量 RELAY_KB_PATH / RELAY_KB_CHUNK_SIZE / RELAY_KB_CHUNK_OVERLAP
  const kbPath = env['RELAY_KB_PATH'];
  const kbChunkSize = envInt(env, 'RELAY_KB_CHUNK_SIZE');
  const kbChunkOverlap = envInt(env, 'RELAY_KB_CHUNK_OVERLAP');
  if (kbPath !== undefined || kbChunkSize !== undefined || kbChunkOverlap !== undefined) {
    patch.kb = {};
    if (kbPath !== undefined) patch.kb.path = kbPath;
    if (kbChunkSize !== undefined) patch.kb.chunkSize = kbChunkSize;
    if (kbChunkOverlap !== undefined) patch.kb.chunkOverlap = kbChunkOverlap;
  }

  patch.lossReduction = {};
  if (precheckEnabled !== undefined || attributionEnabled !== undefined || meterEnabled !== undefined || traceEnabled !== undefined) {
    patch.lossReduction.precheck = {};
    patch.lossReduction.attribution = {};
    patch.lossReduction.meter = {};
    patch.lossReduction.trace = {};
    if (precheckEnabled !== undefined) patch.lossReduction.precheck.enabled = precheckEnabled;
    if (attributionEnabled !== undefined) patch.lossReduction.attribution.enabled = attributionEnabled;
    if (meterEnabled !== undefined) patch.lossReduction.meter.enabled = meterEnabled;
    if (traceEnabled !== undefined) patch.lossReduction.trace.enabled = traceEnabled;
  }
  if (logLevel !== undefined) patch.logLevel = logLevel as RelayConfig['logLevel'];

  let merged = deepMerge(config, patch);
  if (override) merged = deepMerge(merged, override);
  return merged;
}

/** 缺失环境变量在宽松模式下会留下空串；这里只用于"友好报错"判断 */
function isMissingEnvPlaceholder(value: string | undefined): boolean {
  return value !== undefined && value.trim() === '';
}

export interface ConfigIssue {
  level: 'error' | 'warn';
  message: string;
}

export function inspectConfig(config: RelayConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const push = (level: ConfigIssue['level'], message: string): void => {
    issues.push({ level, message });
  };

  if (config.providers.length === 0) push('error', '未配置任何上游（providers 为空）');

  const seenProvider = new Set<string>();
  for (const p of config.providers) {
    if (seenProvider.has(p.id)) push('error', `上游 id 重复: ${p.id}`);
    seenProvider.add(p.id);
    if (!/^https?:\/\//.test(p.baseUrl)) push('error', `上游 ${p.id} 的 baseUrl 必须是 http(s) 绝对地址: ${p.baseUrl}`);
    const hasKey = !!p.apiKey || (p.apiKeys?.some((k) => !!k) ?? false);
    const keyIsMissingEnv = isMissingEnvPlaceholder(p.apiKey) || (p.apiKeys?.some(isMissingEnvPlaceholder) ?? false);
    if (!hasKey && !keyIsMissingEnv) {
      push('error', `上游 ${p.id} 缺少 apiKey / apiKeys（应使用 {ENV:NAME} 插值）`);
    }
    if (p.models.length === 0) push('error', `上游 ${p.id} 未声明任何模型`);
    if ((p.weight ?? 0) < 0) push('error', `上游 ${p.id} 的 weight 不能为负`);
    if (p.timeoutMs !== undefined && p.timeoutMs <= 0) push('error', `上游 ${p.id} 的 timeoutMs 必须为正`);
  }

  const seenKey = new Set<string>();
  for (const c of config.clients) {
    if (seenKey.has(c.id)) push('error', `客户端 key id 重复: ${c.id}`);
    seenKey.add(c.id);
    if (!c.key && !isMissingEnvPlaceholder(c.key)) push('error', `客户端 key ${c.id} 缺少 key`);
    // 空串是"注册了一个永远用不了的 key"：网关要求非空 Authorization，空 key 连哈希都进不去。
    // 它是 {ENV:X:-} 没解析出值、或手写了 key: "" 的结果。以前这里静默通过，等于给了一个死 key 还不说。
    if (c.key !== undefined && c.key.trim() === '') {
      push('warn', `客户端 key ${c.id} 是空串：它永远无法通过鉴权（若来自 {ENV:...}，请检查该环境变量是否真的设了值）`);
    }
    // 缺 tier 和引用未定义分层是两种错：前者是配置漏写了，后者是分层名打错了。
    // 混成一句话会让"检查器先崩掉"（渲染时对 undefined 调 padEnd），而崩了还不算错误。
    if (c.tier === undefined || c.tier === null) {
      push('error', `客户端 key ${c.id} 缺少 tier（必须从 ${Object.keys(config.tiers).join(' / ')} 里选一个）`);
    } else if (!(c.tier in config.tiers)) {
      push('error', `客户端 key ${c.id} 引用了未定义的分层: ${c.tier}（可用: ${Object.keys(config.tiers).join(' / ')}）`);
    }
    if (c.expiresAt !== undefined && c.expiresAt < Date.now()) push('warn', `客户端 key ${c.id} 已过期`);
  }

  if (config.clients.length === 0) push('warn', '未配置任何客户端 key，网关将拒绝所有请求（可用管理接口创建）');

  if (config.server.adminToken === undefined) {
    push('warn', '未设置 server.adminToken：管理接口仅接受来自 127.0.0.1 的请求');
  } else if (config.server.adminToken.length < 16) {
    push('warn', 'server.adminToken 长度小于 16，建议加强');
  }

  if (config.lossReduction.precheck.onBlock === 'reject' && config.lossReduction.precheck.budgetUs > 50_000) {
    push('warn', `precheck.budgetUs=${config.lossReduction.precheck.budgetUs} 偏大，可能成为主流程瓶颈`);
  }

  const proEnabled = config.tiers.pro;
  if (proEnabled.smartRouting && !config.providers.some((p) => p.cost)) {
    push('warn', 'pro 层开启了 smartRouting 但没有任何上游配置 cost，路由将退化为 priority');
  }

  // 模型可达性：请求某个模型必须至少有一个上游声明支持
  const known = new Set<string>();
  for (const p of config.providers) for (const m of p.models) known.add(m);
  for (const m of Object.keys(config.modelAliases)) {
    // ownLookup：模型名若叫 'constructor'/'toString'，`config.modelAliases[m]` 会命中
    // Object.prototype 而拿到一个函数，「目标模型」校验随之失效（把一个无效别名当有效）。
    const target = ownLookup(config.modelAliases, m);
    if (target === undefined) continue;
    if (!known.has(target)) push('warn', `模型别名 ${m} → ${target} 没有任何上游声明支持该目标模型`);
  }

  /* 档位阶梯：每一阶都该有上游声明支持，否则那一阶永远走不通（等于白写） */
  const allModels = new Set<string>();
  for (const p of config.providers) for (const m of p.models) allModels.add(m);
  for (const [alias, ladder] of Object.entries(config.modelLadders ?? {})) {
    if (!Array.isArray(ladder) || ladder.length === 0) {
      push('error', `档位阶梯 ${alias} 为空`);
      continue;
    }
    // ownLookup：阶梯里的模型名若叫 'constructor' 等，`config.modelAliases[m]` 会命中
    // Object.prototype 而拿到函数，`?? m` 回落被跳过 —— 可达性校验于是拿一个函数去
    // allModels.has() 比对，永远 false，把本来可达的阶误报成"将被跳过"。
    const unreachable = ladder.filter((m) => !allModels.has(ownLookup(config.modelAliases, m) ?? m));
    if (unreachable.length === ladder.length) {
      push('error', `档位阶梯 ${alias} 的所有模型都没有上游声明支持：${ladder.join(', ')}`);
    } else if (unreachable.length > 0) {
      push('warn', `档位阶梯 ${alias} 中这些模型当前不可达（会被自动跳过）：${unreachable.join(', ')}`);
    }
    // 能力表缺失时的提醒：带工具的请求可能被切到不支持工具的模型。
    // ownLookup：`config.modelCapabilities?.[m]` 在 m 为 'constructor' 等时会命中原型链，
    // 把「没声明能力」误判成「声明了」，这条提醒就静默漏掉（正是它要防的那种失败）。
    const noCap = ladder.filter((m) => ownLookup(config.modelCapabilities, m) === undefined);
    if (noCap.length > 0) {
      push('warn', `档位阶梯 ${alias} 里 ${noCap.join(', ')} 没有声明能力（tools/contextWindow）；带工具调用的请求切过去可能直接失败，建议在 modelCapabilities 里补上`);
    }
  }

  if (config.storage.driver === 'sqlite' && config.storage.path === ':memory:') {
    push('warn', 'storage.path=:memory: 时度量数据不会持久化');
  }

  return issues;
}

export function validateConfig(config: RelayConfig): void {
  const issues = inspectConfig(config);
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length > 0) {
    throw new Error(`配置校验失败:\n${errors.map((e) => `  - ${e.message}`).join('\n')}`);
  }
  if (!config.tiers.free || !config.tiers.standard || !config.tiers.pro) {
    throw new Error('必须定义 free/standard/pro 三层策略');
  }
}

/** 生成一份可直接运行的示例配置（用于首启动自举与文档） */
export function exampleConfigYaml(): string {
  return `# 模型 API 聚合中转站 — 示例配置
# 复制为 config/relay.yaml 后按需修改；所有密钥请用 {ENV:NAME} 插值，禁止明文写入。

server:
  host: 127.0.0.1
  port: 8787
  adminToken: "{ENV:RELAY_ADMIN_TOKEN:-demo-admin-token-please-change}"
  trustProxy: false

storage:
  driver: sqlite
  path: data/relay.db

logLevel: info

providers:
  - id: deepseek
    label: DeepSeek 官方
    protocol: openai
    baseUrl: https://api.deepseek.com/v1
    apiKey: "{ENV:DEEPSEEK_API_KEY}"
    models: [deepseek-chat, deepseek-reasoner]
    weight: 1
    priority: 10
    tags: [cn, official]
    cost: { inputPerMTok: 2, outputPerMTok: 8, cachedInputPerMTok: 0.5 }
  - id: siliconflow
    label: 硅基流动（便宜上游，用于 smart routing）
    protocol: openai
    baseUrl: https://api.siliconflow.cn/v1
    apiKey: "{ENV:SILICONFLOW_API_KEY:-}"
    models: [Qwen/Qwen2.5-7B-Instruct]
    weight: 1
    priority: 5
    tags: [cn, cheap]
    cost: { inputPerMTok: 0.5, outputPerMTok: 1.5 }
  - id: mock
    label: 本地 mock 上游（离线自测，勿用于生产）
    protocol: openai
    baseUrl: http://127.0.0.1:8899/v1
    apiKey: "mock-key"
    models: [mock-small, mock-large, mock-429, mock-500, mock-401, mock-404, mock-400, mock-502, mock-503, mock-filter, mock-context, mock-balance]
    weight: 1
    priority: 1
    tags: [local, cheap, unstable]
    # 说明：mock-429 / mock-500 / mock-401 等是 mock 上游的故障注入模型名。
    # 真实上游不需要这些；这里声明它们只是为了让 P2 预检放行请求，
    # 从而端到端演示 P3 失败归因与自动故障转移。
    cost: { inputPerMTok: 0.2, outputPerMTok: 0.6 }

modelAliases:
  gpt-4o-mini: mock-small
  default: deepseek-chat

defaultProvider: deepseek

clients:
  - id: demo-free
    label: 演示-免费层
    key: "{ENV:RELAY_KEY_FREE:-sk-relay-free-demo}"
    tier: free
    tenantId: demo
    enabled: true
  - id: demo-standard
    label: 演示-标准层
    key: "{ENV:RELAY_KEY_STANDARD:-sk-relay-standard-demo}"
    tier: standard
    tenantId: demo
    enabled: true
  - id: demo-pro
    label: 演示-Pro 层
    key: "{ENV:RELAY_KEY_PRO:-sk-relay-pro-demo}"
    tier: pro
    tenantId: demo
    enabled: true

lossReduction:
  precheck:
    enabled: true
    onBlock: reject
    budgetUs: 3000
    # max_tokens 绝对天花板（模型没声明 modelMaxTokens 时的兜底）
    maxTokensCeiling: 1000000
  attribution:
    enabled: true
    includeEvidence: false
    autoRetry: 1
    # 精确模型名请求时用同档后继模型补齐阶梯（横向兜底耗尽后才竖向换模型）。
    # 置 false 则退回单阶：点名 agnes-2.0-flash 遇免费档限流时 429 直接丢回客户端。
    siblingModelFallback: true
    backoffBaseMs: 400
    backoffMaxMs: 8000
  meter:
    enabled: true
    retentionDays: 30
  trace:
    enabled: true
    ringSize: 500
    persist: true
`;
}
