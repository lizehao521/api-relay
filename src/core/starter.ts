/**
 * 单厂商起步配置生成器（`relay starter`）。
 *
 * 目的：把「第一次接上游」这件事压到一条命令。
 *
 * 设计原则——**别让人一开始就面对三个上游、三个分层、一堆降损开关**：
 *   一个上游 · 一两个模型 · 两个 key 槽（第二个留空）· 三个分层照旧（但不解释）
 *   降损层全开（它本来就是这套系统的意义），但不让它出现在第一屏
 *
 * 换厂商只是换内置模板；换模型只是改 models 一行。
 */

import type { ProviderConfig } from './types.js';

export interface VendorTemplate {
  id: string;
  label: string;
  /** 中文说明 */
  note: string;
  protocol: 'openai';
  baseUrl: string;
  /** 环境变量名（用于 {ENV:...} 插值） */
  envName: string;
  /** 该厂商常见模型名（用户可改） */
  models: string[];
  /** 该厂商的参考实付成本（元/百万 token），用于成本统计与 smart routing */
  cost?: { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number };
  /** 刊例价（对外展示/对账用，2026-09-14 起与实付分开记） */
  listCost?: { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number };
  /** 按型号覆盖实付价 */
  modelCosts?: Record<string, { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number }>;
  /** 走 HTTP/2（2026-09-14：Agnes 的 h1.1 路径实测慢且抖） */
  http2?: boolean;
  /** 控制台地址，方便填 key */
  console?: string;
  /**
   * 该厂商的鉴权格式（不守 OpenAI 标准的厂商需要）。
   * 见 ProviderConfig.auth 的说明。
   */
  auth?: { format: 'bearer' | 'bearerless' | 'api-key-header' | 'x-api-key'; headerName?: string };
  /**
   * 明文默认 key（只用于本地 mock：它不做鉴权，写死一个字符串就能零配置起跑）。
   * 真实厂商绝不能填这个字段——那会把密钥写进生成的文件里。
   */
  literalApiKey?: string;
}

/**
 * 内置厂商模板。
 *
 * 诚实标注：模型名与价格会变，这里的值只保证"格式正确"，不保证"当下最优"。
 * 接好之后用 `GET /v1/models` 核实你账号实际能用的模型，再改 models 一行即可。
 */
export const VENDOR_TEMPLATES: VendorTemplate[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    note: '性价比高，OpenAI 兼容，国内直连',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    envName: 'DEEPSEEK_API_KEY',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    cost: { inputPerMTok: 2, outputPerMTok: 8, cachedInputPerMTok: 0.5 },
    console: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（通义）',
    note: '模型全，兼容模式直接用 OpenAI 路径',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envName: 'DASHSCOPE_API_KEY',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    cost: { inputPerMTok: 0.8, outputPerMTok: 2 },
    console: 'https://bailian.console.aliyun.com/',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    note: '开源模型聚合，价格低，适合跑量',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    envName: 'SILICONFLOW_API_KEY',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    cost: { inputPerMTok: 1, outputPerMTok: 3 },
    console: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    note: '长上下文见长',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    envName: 'MOONSHOT_API_KEY',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-128k'],
    cost: { inputPerMTok: 4, outputPerMTok: 16 },
    console: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    note: '注意：错误体缺 type/param，网关会自动补齐',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    envName: 'ZHIPU_API_KEY',
    models: ['glm-4-plus', 'glm-4-flash'],
    cost: { inputPerMTok: 1, outputPerMTok: 3 },
    console: 'https://bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'ark',
    label: '火山方舟（豆包）',
    note: '错误码口径未核实，归因走兜底规则',
    protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    envName: 'ARK_API_KEY',
    models: ['doubao-pro-32k'],
    cost: { inputPerMTok: 0.8, outputPerMTok: 2 },
    console: 'https://console.volcengine.com/ark',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    note: '聚合平台（你说的第二套系统的典型形态）；注意其 error.code 是数字状态码',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    envName: 'OPENROUTER_API_KEY',
    models: ['openai/gpt-4o-mini', 'deepseek/deepseek-chat'],
    cost: { inputPerMTok: 1.5, outputPerMTok: 6 },
    console: 'https://openrouter.ai/keys',
  },
  {
    id: 'agnes',
    label: 'Agnes（Agens 厂商）',
    note: 'OpenAI 兼容（实测 Authorization 不带 Bearer、有 prompt cache、推理 token 单独计）；2026-09-14 实测 agnes-3.0-flash / agnes-2.5-flash 官方现价 $0（限免），刊例价见 listCost',
    protocol: 'openai',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    envName: 'AGNES_API_KEY',
    // 只列 chat 模型：同一账号下还有 agnes-video-* / agnes-image-*，
    // 那些端点语义与计费都不同（视频按秒），不在本网关的覆盖范围内。
    models: ['agnes-2.5-flash', 'agnes-3.0-flash', 'agnes-2.5-pro'],
    auth: { format: 'bearerless' },
    // ⚡ 必须走 HTTP/2：实测 Agnes 的 h1.1 路径慢且抖（h2 稳 0.13~0.35s，h1.1 会跑到 2~20s）
    http2: true,
    // 实付价：flash 型号官方现价 $0；刊例价（对外展示/对账用）0.05/0.15，×7.2 → 0.36/1.08
    cost: { inputPerMTok: 0, outputPerMTok: 0, cachedInputPerMTok: 0 },
    listCost: { inputPerMTok: 0.36, outputPerMTok: 1.08, cachedInputPerMTok: 0.036 },
    modelCosts: {
      'agnes-3.0-flash': { inputPerMTok: 0, outputPerMTok: 0, cachedInputPerMTok: 0 },
      'agnes-2.5-flash': { inputPerMTok: 0, outputPerMTok: 0, cachedInputPerMTok: 0 },
    },
    console: 'https://apihub.agnes-ai.com/',
  },
  {
    id: 'mock',
    label: '本地 mock（离线自测，不花一分钱）',
    note: '会按剧本犯错，用来验证归因与预检；不要用于生产',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:8899/v1',
    envName: 'MOCK_KEY',
    models: ['mock-small', 'mock-large', 'mock-429', 'mock-500', 'mock-401', 'mock-balance', 'mock-filter', 'mock-context', 'mock-404'],
    cost: { inputPerMTok: 1, outputPerMTok: 2 },
    literalApiKey: 'mock-key',
  },
];

export function findVendor(id: string): VendorTemplate | undefined {
  const key = id.trim().toLowerCase();
  return VENDOR_TEMPLATES.find((v) => v.id === key);
}

export interface StarterOptions {
  vendor: VendorTemplate;
  /** 模型名列表；空则用模板默认 */
  models?: string[];
  /** key 的环境变量名；默认用模板的 envName */
  envName?: string;
  /** 额外 key 的环境变量名（多 key 轮换用，可空） */
  envName2?: string;
  /** 网关端口 */
  port?: number;
  /** 客户端 key 前缀（三层演示 key） */
  keyPrefix?: string;
  /** 是否带上降损层配置块（默认 true，明显是这套系统的意义） */
  withLossReduction?: boolean;
}

/**
 * 生成一份「单厂商单模型」起步配置。
 *
 * 刻意保持短：一个上游、一行 models、两个 key 槽。
 * 分层、降损层都在，但不展开成让人头痛的选项森林。
 */
export function starterConfigYaml(opts: StarterOptions): string {
  const v = opts.vendor;
  const models = (opts.models && opts.models.length > 0 ? opts.models : v.models).filter(Boolean);
  const envName = opts.envName ?? v.envName;
  const port = opts.port ?? 8787;
  const prefix = opts.keyPrefix ?? 'sk-relay';
  const provider: ProviderConfig = {
    id: v.id,
    label: v.label,
    protocol: 'openai',
    baseUrl: v.baseUrl,
    apiKey: v.literalApiKey ?? `{ENV:${envName}}`,
    ...(opts.envName2 ? { apiKeys: [v.literalApiKey ?? `{ENV:${envName}}`, `{ENV:${opts.envName2}}`] } : {}),
    models,
    ...(v.cost ? { cost: v.cost } : {}),
    ...(v.listCost ? { listCost: v.listCost } : {}),
    ...(v.modelCosts ? { modelCosts: v.modelCosts } : {}),
    ...(v.http2 ? { http2: true } : {}),
    ...(v.auth ? { auth: v.auth } : {}),
    priority: 10,
    tags: ['direct'],
  };

  const lines: string[] = [];
  lines.push(`# api-relay 起步配置 —— 单厂商「${v.label}」`);
  lines.push(`#`);
  lines.push(`# 这个文件只做一件事：把一个厂商的一个模型接通。`);
  lines.push(`# 想换厂商就改下面 4 行（id / baseUrl / apiKey / models），想加模型就往 models 里加。`);
  if (v.console) lines.push(`# 拿 key: ${v.console}`);
  if (v.note) lines.push(`# 说明: ${v.note}`);
  lines.push(`#`);
  if (v.literalApiKey) {
    lines.push(`# 这个是本地 mock，不需要任何密钥，起网关即可跑。`);
    lines.push(`#   1) node dist/cli.js mock &                        # 先起 mock 上游`);
    lines.push(`#   2) node dist/cli.js serve --config starter.yaml   # 再起网关`);
  } else {
    lines.push(`# 启动前先做两件事：`);
    lines.push(`#   1) export ${envName}=你的key`);
    lines.push(`#   2) node dist/cli.js check --config starter.yaml   （不导出密钥也能校验，会告诉你还缺什么）`);
  }
  lines.push('');
  lines.push('server:');
  lines.push('  host: 127.0.0.1');
  lines.push(`  port: ${port}`);
  lines.push(`  adminToken: "{ENV:RELAY_ADMIN_TOKEN:-}"`);
  lines.push('');
  lines.push('storage:');
  lines.push('  driver: sqlite');
  lines.push('  path: data/relay.db');
  lines.push('');
  lines.push('logLevel: info');
  lines.push('');
  lines.push('# ── 上游：就一个。加第二个就是把这段复制一份改 id/URL/key ──────────────');
  lines.push('providers:');
  lines.push(...indent(yamlProvider(provider), 2));
  lines.push('');
  lines.push('# ── 对外模型名（客户端看到的名字）→ 上游真实模型名 ────────────────────');
  lines.push('# 不改也能用。想给客户一个统一的、看不出厂商的名字，就在这里加一行：');
  lines.push('#   fast: ' + (models[0] ?? 'model-name'));
  lines.push('modelAliases: {}');
  lines.push('');
  lines.push('# ── 客户端 key（三层：免费引流 / 按量 / 订阅）──────────────────────────');
  lines.push('# 生产环境把 key 换成 {ENV:...}，别明文写在这里。');
  lines.push('clients:');
  lines.push('  - id: free');
  lines.push('    label: 免费层（纯转发，错误体一个字节都不加）');
  lines.push(`    key: "{ENV:RELAY_KEY_FREE:-${prefix}-free}"`);
  lines.push('    tier: free');
  lines.push('    tenantId: demo');
  lines.push('    enabled: true');
  lines.push('  - id: standard');
  lines.push('    label: 标准层（按量计费，归因走响应头）');
  lines.push(`    key: "{ENV:RELAY_KEY_STANDARD:-${prefix}-standard}"`);
  lines.push('    tier: standard');
  lines.push('    tenantId: demo');
  lines.push('    enabled: true');
  lines.push('  - id: pro');
  lines.push('    label: Pro 层（订阅，预检+归因全开）');
  lines.push(`    key: "{ENV:RELAY_KEY_PRO:-${prefix}-pro}"`);
  lines.push('    tier: pro');
  lines.push('    tenantId: demo');
  lines.push('    enabled: true');
  lines.push('');
  if (opts.withLossReduction !== false) {
    lines.push('# ── 降损层：默认全开。不确定就先别动这些值 ────────────────────────────');
    lines.push('# 预检拦截（P2）：畸形 tool_calls / 参数越界 在上游之前拦下，省一次往返');
    lines.push('# 失败归因（P3）：把 429/超时/余额不足 翻译成 {下一步做什么}');
    lines.push('# 损耗度量（P8）：归因投递率、自动恢复、无效重试、治理层自身开销');
    lines.push('lossReduction:');
    lines.push('  precheck:');
    lines.push('    enabled: true');
    lines.push('    onBlock: reject        # 灰度期可改 observe（只记录不拦）');
    lines.push('  attribution:');
    lines.push('    enabled: true');
    lines.push('    autoRetry: 1           # 可恢复错误自动重试次数（限流/超时/5xx）');
    lines.push('  meter:');
    lines.push('    enabled: true');
    lines.push('    retentionDays: 30');
    lines.push('  trace:');
    lines.push('    enabled: true');
    lines.push('');
  }
  return lines.join('\n');
}

function yamlProvider(p: ProviderConfig): string[] {
  const out: string[] = [];
  out.push(`- id: ${p.id}`);
  out.push(`  label: ${p.label}`);
  out.push(`  protocol: ${p.protocol}`);
  out.push(`  baseUrl: ${p.baseUrl}`);
  out.push(`  apiKey: "${p.apiKey}"`);
  if (p.apiKeys) out.push(`  apiKeys: [${p.apiKeys.map((k: string) => `"${k}"`).join(', ')}]`);
  out.push(`  models: [${p.models.join(', ')}]`);
  if (p.cost) {
    out.push(`  cost: { inputPerMTok: ${p.cost.inputPerMTok}, outputPerMTok: ${p.cost.outputPerMTok}${p.cost.cachedInputPerMTok ? `, cachedInputPerMTok: ${p.cost.cachedInputPerMTok}` : ''} }`);
  }
  if (p.listCost) {
    out.push(`  listCost: { inputPerMTok: ${p.listCost.inputPerMTok}, outputPerMTok: ${p.listCost.outputPerMTok}${p.listCost.cachedInputPerMTok ? `, cachedInputPerMTok: ${p.listCost.cachedInputPerMTok}` : ''} }`);
  }
  if (p.modelCosts) {
    for (const [m, c] of Object.entries(p.modelCosts)) {
      out.push(`  modelCosts:`);
      out.push(`    ${m}: { inputPerMTok: ${c.inputPerMTok}, outputPerMTok: ${c.outputPerMTok}${c.cachedInputPerMTok ? `, cachedInputPerMTok: ${c.cachedInputPerMTok}` : ''} }`);
      break; // 模板只放第一个示例，避免起步配置太长
    }
  }
  if (p.http2) out.push(`  http2: true`);
  if (p.auth) out.push(`  auth: { format: ${p.auth.format}${p.auth.headerName ? `, headerName: ${p.auth.headerName}` : ''} }`);
  out.push(`  priority: ${p.priority}`);
  if (p.tags) out.push(`  tags: [${p.tags.join(', ')}]`);
  return out;
}

function indent(lines: string[], n: number): string[] {
  const pad = ' '.repeat(n);
  return lines.map((l) => (l.startsWith('- ') ? `${pad}${l}` : `${pad}${l}`));
}
