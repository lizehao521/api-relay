#!/usr/bin/env node
/**
 * CLI 入口。
 *
 * 命令：
 *   serve    启动中转站（默认）
 *   check    只校验配置并打印装配摘要（部署前的必跑项）
 *   mock     启动 mock 上游（离线开发与故障注入）
 *   report   打印损耗度量报告（读度量库）
 *   catalog  打印模型/上游可达性矩阵
 *   trace    打印某条请求轨迹（排障）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as loadConfigModule from './core/config.js';
import { loadConfig, inspectConfig, exampleConfigYaml, DEFAULT_CONFIG_PATH } from './core/config.js';
import { Logger } from './core/logger.js';
import { createApp } from './app.js';
import { MockUpstream } from './mock/upstream.js';
import { startDemo, renderDemoBanner, runSelfCheck, renderSelfCheck } from './demo.js';
import { buildAuthHeader } from './upstream/client.js';
import { VENDOR_TEMPLATES, findVendor, starterConfigYaml } from './core/starter.js';
import { renderSummary } from './loss/meter.js';
import { renderTrace } from './loss/tracer.js';
import type { RelayConfig } from './core/types.js';

interface CliOptions {
  command: string;
  configPath?: string;
  port?: number;
  host?: string;
  window: string;
  traceId?: string;
  json: boolean;
  help: boolean;
  allowEmptyProviders: boolean;
  /** starter 用 */
  vendor?: string;
  models?: string;
  envName?: string;
  envName2?: string;
  out?: string;
  dryRun?: boolean;
  provider?: string;
  allModels?: boolean;
}

const HELP = `api-relay — OpenAI 兼容的模型 API 聚合中转站（内嵌传话层工程降损）

用法：relay <command> [options]

最省事的起点：
  demo               一条命令跑起来（mock 上游 + 网关 + 看板 + 自检），无需任何密钥
                     启动后打开打印出来的 http://127.0.0.1:8787/admin 即可
  starter            生成「单厂商单模型」起步配置（推荐从这里开始接真实上游）
                     relay starter --vendor deepseek --out starter.yaml

命令：
  serve              启动网关（默认命令）
  check              校验配置并打印装配摘要，不启动服务
  mock               启动 mock 上游（可注入 429/超时/断连等故障）
  report             打印损耗度量报告（P8）
  catalog            打印模型 × 上游可达性矩阵
  trace <traceId>    打印请求级轨迹（P5）
  starter            生成单厂商单模型起步配置（最简可用）
  vendors            列出内置厂商模板
  pull-models        一键拉取上游模型清单并写回配置
  init               生成完整示例配置到 config/relay.yaml（三上游，进阶用）
  help               显示本帮助

参数：
  --config <path>    配置文件路径（默认 ${DEFAULT_CONFIG_PATH}，或环境变量 RELAY_CONFIG）
  --port <n>         监听端口（覆盖配置）
  --host <h>         监听地址（覆盖配置）
  --window <w>       报告时间窗：5m | 1h | 24h | 7d | 30d（默认 24h）
  --json             以 JSON 输出（便于脚本消费）
  --allow-empty-providers  允许 serve 时没有上游（仅用于本机联调骨架）
`;

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { command: 'serve', window: '24h', json: false, help: false, allowEmptyProviders: false };
  const args = [...argv];
  const first = args[0];
  if (first && !first.startsWith('-')) {
    opts.command = first;
    args.shift();
    if (opts.command === 'trace') {
      opts.traceId = args.shift();
    }
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--config':
      case '-c':
        opts.configPath = args[++i];
        break;
      case '--port':
      case '-p':
        opts.port = Number(args[++i]);
        break;
      case '--host':
        opts.host = args[++i];
        break;
      case '--window':
      case '-w':
        opts.window = args[++i] ?? '24h';
        break;
      case '--json':
        opts.json = true;
        break;
      case '--allow-empty-providers':
        opts.allowEmptyProviders = true;
        break;
      case '--vendor':
      case '-v':
        opts.vendor = args[++i];
        break;
      case '--models':
      case '-m':
        opts.models = args[++i];
        break;
      case '--env':
        opts.envName = args[++i];
        break;
      case '--env2':
        opts.envName2 = args[++i];
        break;
      case '--out':
      case '-o':
        opts.out = args[++i];
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--provider':
        opts.provider = args[++i];
        break;
      case '--all-models':
        opts.allModels = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        if (a.startsWith('-')) {
          process.stderr.write(`未知参数: ${a}\n`);
          opts.help = true;
        }
        break;
    }
  }
  return opts;
}

function windowMs(label: string): number {
  // Map 而非对象字面量：`map[label]` 在 label 为 'constructor'/'toString' 等时会命中
  // Object.prototype 而返回一个**函数**，`?? 86_400_000` 的兜底被静默跳过 ——
  // 与 admin/params.ts 的 windowFrom 同族（那边已被同一个 bug 打过）。
  const map = new Map<string, number>([
    ['5m', 5 * 60_000],
    ['1h', 3_600_000],
    ['24h', 86_400_000],
    ['7d', 7 * 86_400_000],
    ['30d', 30 * 86_400_000],
  ]);
  return map.get(label) ?? 86_400_000;
}

function loadWithOverrides(opts: CliOptions): RelayConfig {
  const config = loadConfig({ ...(opts.configPath ? { path: opts.configPath } : {}), requireFile: opts.command !== 'check' ? true : existsSync(resolve(opts.configPath ?? DEFAULT_CONFIG_PATH)) });
  if (opts.port !== undefined) config.server.port = opts.port;
  if (opts.host !== undefined) config.server.host = opts.host;
  return config;
}

/** check 专用：宽松模式，缺失的环境变量只记录不报错 */
function loadForCheck(opts: CliOptions): { config: RelayConfig; missingEnv: string[] } {
  const { loadConfigDetailed } = loadConfigModule;
  return loadConfigDetailed({
    ...(opts.configPath ? { path: opts.configPath } : {}),
    requireFile: existsSync(resolve(opts.configPath ?? DEFAULT_CONFIG_PATH)),
    lenientEnv: true,
  });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const opts = parseArgs(argv);
  if (opts.help || opts.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  switch (opts.command) {
    case 'starter':
      return cmdStarter(opts);
    case 'vendors':
      return cmdVendors(opts);
    case 'pull-models':
      return cmdPullModels(opts);
    case 'init':
      return cmdInit();
    case 'check':
      return cmdCheck(opts);
    case 'mock':
      return cmdMock(opts);
    case 'report':
      return cmdReport(opts);
    case 'catalog':
      return cmdCatalog(opts);
    case 'trace':
      return cmdTrace(opts);
    case 'demo':
      return cmdDemo(opts);
    case 'serve':
      return cmdServe(opts);
    default:
      process.stderr.write(`未知命令: ${opts.command}\n\n${HELP}`);
      return 2;
  }
}

/* ------------------------------------------------------------------ */

function cmdVendors(opts: CliOptions): number {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(VENDOR_TEMPLATES, null, 2)}\n`);
    return 0;
  }
  process.stdout.write('\n内置厂商模板（用 relay starter --vendor <id> 生成配置）\n\n');
  for (const v of VENDOR_TEMPLATES) {
    process.stdout.write(`  ${v.id.padEnd(14)} ${v.label}\n`);
    process.stdout.write(`  ${''.padEnd(14)} ${v.note}\n`);
    process.stdout.write(`  ${''.padEnd(14)} 环境变量 ${v.envName}   模型 ${v.models.slice(0, 3).join(', ')}${v.models.length > 3 ? ' …' : ''}\n`);
    if (v.console) process.stdout.write(`  ${''.padEnd(14)} 拿 key ${v.console}\n`);
    process.stdout.write('\n');
  }
  process.stdout.write('换厂商只是换一个 id；换模型用 --models 覆盖，或直接改生成文件里的 models 一行。\n\n');
  return 0;
}

function cmdStarter(opts: CliOptions): number {
  const vendorId = opts.vendor ?? 'deepseek';
  const vendor = findVendor(vendorId);
  if (!vendor) {
    process.stderr.write(`未知厂商: ${vendorId}\n可用: ${VENDOR_TEMPLATES.map((v) => v.id).join(', ')}\n`);
    return 2;
  }
  const models = opts.models ? opts.models.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const yamlText = starterConfigYaml({
    vendor,
    ...(models ? { models } : {}),
    ...(opts.envName ? { envName: opts.envName } : {}),
    ...(opts.envName2 ? { envName2: opts.envName2 } : {}),
    ...(opts.port !== undefined ? { port: opts.port } : {}),
  });

  const target = opts.out ?? 'starter.yaml';
  if (existsSync(target) && !opts.out) {
    process.stderr.write(`文件已存在，未覆盖: ${resolve(target)}\n（想覆盖请显式加 --out ${target}）\n`);
    return 1;
  }
  writeFileSync(target, yamlText, 'utf8');

  const envName = opts.envName ?? vendor.envName;
  const shown = models ?? vendor.models;
  process.stdout.write(`\n已生成起步配置: ${resolve(target)}\n\n`);
  process.stdout.write(`  厂商    ${vendor.label}（${vendor.id}）\n`);
  process.stdout.write(`  路径    ${vendor.baseUrl}\n`);
  process.stdout.write(`  模型    ${shown.join(', ')}\n`);
  process.stdout.write(`  密钥    {ENV:${envName}}${opts.envName2 ? ` + {ENV:${opts.envName2}}（多 key 轮换）` : ''}\n`);
  if (vendor.console) process.stdout.write(`  拿 key  ${vendor.console}\n`);
  if (vendor.literalApiKey) {
    process.stdout.write('\n接下来两步（本地 mock，无需密钥）：\n\n');
    process.stdout.write('  1) node dist/cli.js mock &                        # 起 mock 上游\n');
    process.stdout.write(`  2) node dist/cli.js serve --config ${target}      # 起网关，然后打开 /admin\n`);
  } else {
    process.stdout.write('\n接下来三步：\n\n');
    process.stdout.write(`  1) export ${envName}=你的key\n`);
    process.stdout.write(`  2) node dist/cli.js check --config ${target}      # 校验（不导出密钥也能跑）\n`);
    process.stdout.write(`  3) node dist/cli.js serve --config ${target}      # 启动，然后打开 /admin\n`);
  }
  process.stdout.write('\n换厂商：relay starter --vendor dashscope --out starter.yaml\n');
  process.stdout.write('换模型：改生成文件里 models 那一行即可\n\n');
  return 0;
}

/**
 * 这个网关接不了的模型：它们走的不是本网关已实现的端点（或语义/计费完全不同），
 * 拉进配置只会让客户调用失败。本网关实现的是 chat/completions、completions、
 * embeddings、responses、messages —— 凡是音频/图像/视频/重排/审核类都不在其中。
 *
 * 注意两个曾经漏掉的写法：`asr`（语音识别）和 `reranker`。
 * 前者让 MiMo 的 `mimo-v2.5-asr` 被判成对话模型；后者让最常见的 `bge-reranker-v2`
 * 之类的重排模型一路绿灯（词表里只写了 `rerank`，卡在 `reranker` 的边界上）。
 * 语音这一类必须连 tts / asr / whisper / transcribe / realtime / voice 一起考虑。
 */
export const NON_CHAT_MODEL =
  /(^|[-_/])(video|image|tts|asr|audio|speech|voice|whisper|transcribe|transcription|realtime|rerank(er)?|moderation)([-_/.]|$)/i;

async function cmdPullModels(opts: CliOptions): Promise<number> {
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
  const abs = resolve(configPath);
  if (!existsSync(abs)) {
    process.stderr.write(`配置文件不存在: ${abs}\n用法: relay pull-models --config starter.yaml\n`);
    return 1;
  }
  let config: RelayConfig;
  let rawText: string;
  try {
    rawText = readFileSync(abs, 'utf8');
    config = loadConfig({ ...(opts.configPath ? { path: opts.configPath } : {}) });
  } catch (err) {
    process.stderr.write(`配置装载失败: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const targets = config.providers.filter((p) => !opts.provider || p.id === opts.provider);
  if (targets.length === 0) {
    process.stderr.write(`没有匹配的上游${opts.provider ? `（--provider ${opts.provider}）` : ''}\n`);
    return 1;
  }

  let changedAny = false;
  for (const provider of targets) {
    const url = `${provider.baseUrl.replace(/\/+$/, '')}/models`;
    process.stdout.write(`\n【${provider.id}】拉取 ${url}\n`);
    let ids: string[] = [];
    try {
      const res = await fetch(url, { headers: { ...buildAuthHeader(provider.apiKey, provider.auth) } });
      if (!res.ok) {
        const body = await res.text();
        process.stderr.write(`  ✗ HTTP ${res.status}${body ? ': ' + body.slice(0, 160) : ''}\n`);
        continue;
      }
      const parsed = (await res.json()) as { data?: { id?: string }[]; models?: { id?: string }[] };
      const list = parsed.data ?? parsed.models ?? [];
      ids = list.map((m) => String(m.id ?? '')).filter(Boolean);
    } catch (err) {
      process.stderr.write(`  ✗ 请求失败: ${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }

    const all = [...new Set(ids)].sort();
    const chatLike = all.filter((m) => !NON_CHAT_MODEL.test(m));
    const excluded = all.filter((m) => NON_CHAT_MODEL.test(m));
    const chosen = opts.allModels ? all : chatLike;

    process.stdout.write(`  上游共 ${all.length} 个模型\n`);
    process.stdout.write(`  可作对话模型  ${chatLike.length} 个: ${chatLike.join(', ') || '（无）'}\n`);
    if (excluded.length > 0 && !opts.allModels) {
      process.stdout.write(`  已排除非对话  ${excluded.length} 个: ${excluded.join(', ')}\n`);
      process.stdout.write(`  （视频/图片等端点语义与计费不同，拉进配置只会让客户调用失败；要全收加 --all-models）\n`);
    }

    const before = provider.models;
    const added = chosen.filter((m) => !before.includes(m));
    const removed = before.filter((m) => !chosen.includes(m));
    if (added.length === 0 && removed.length === 0) {
      process.stdout.write(`  配置已是最新，无需改动\n`);
      continue;
    }
    process.stdout.write(`  新增 ${added.length}${added.length ? ': ' + added.join(', ') : ''}\n`);
    if (removed.length > 0) process.stdout.write(`  移除 ${removed.length}: ${removed.join(', ')}\n`);

    if (opts.dryRun) {
      process.stdout.write(`  （--dry-run：未写回配置）\n`);
      continue;
    }

    // 定点替换该 provider 块内的 models 行，而不是把整个 YAML 重新序列化
    // （解析器只有 parse 没有 stringify，重写全文件会丢掉注释与格式）
    const updated = replaceProviderModels(rawText, provider.id, chosen);
    if (updated === undefined) {
      process.stderr.write(`  ✗ 没能在配置文本里定位 ${provider.id} 的 models 行，未改写\n`);
      continue;
    }
    rawText = updated;
    changedAny = true;
    process.stdout.write(`  ✓ 已写回配置\n`);
  }

  if (changedAny && !opts.dryRun) {
    writeFileSync(abs, rawText, 'utf8');
    process.stdout.write(`\n配置已更新: ${abs}\n建议接着跑: node dist/cli.js check --config ${configPath}\n`);
  } else {
    process.stdout.write('\n没有改动。\n');
  }
  return 0;
}

/**
 * 在 YAML 文本里定点替换某个 provider 的 models 行。
 * 只在 `- id: <providerId>` 到下一个 `- id:` 之间找，避免改错块。
 */
export function replaceProviderModels(text: string, providerId: string, models: string[]): string | undefined {
  const lines = text.split('\n');
  const idRe = /^(\s*)-\s*id:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = idRe.exec(lines[i]!);
    if (!m) continue;
    if (start === -1) {
      if (m[2] === providerId) start = i;
    } else {
      end = i;
      break;
    }
  }
  if (start === -1) return undefined;
  for (let i = start + 1; i < end; i++) {
    const mm = /^(\s*)models:\s*.*$/.exec(lines[i]!);
    if (!mm) continue;
    lines[i] = `${mm[1]}models: [${models.join(', ')}]`;
    return lines.join('\n');
  }
  return undefined;
}

function cmdInit(): number {
  const target = resolve('config/relay.yaml');
  if (existsSync(target)) {
    process.stderr.write(`配置已存在，未覆盖: ${target}\n`);
    return 1;
  }
  const { mkdirSync: mk, writeFileSync: wr } = { mkdirSync, writeFileSync };
  mk(resolve('config'), { recursive: true });
  wr(target, exampleConfigYaml(), 'utf8');
  process.stdout.write(`已生成示例配置: ${target}\n请填写环境变量（如 DEEPSEEK_API_KEY）后再运行 relay check\n`);
  return 0;
}

function cmdCheck(opts: CliOptions): number {
  let config: RelayConfig;
  let missingEnv: string[] = [];
  try {
    const loaded = loadForCheck(opts);
    config = loaded.config;
    missingEnv = loaded.missingEnv;
    if (opts.port !== undefined) config.server.port = opts.port;
    if (opts.host !== undefined) config.server.host = opts.host;
  } catch (err) {
    process.stderr.write(`配置装载失败: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const issues = inspectConfig(config);
  // 缺失的环境变量在 check 场景下是"提示"而不是"错误"：
  // 部署前本来就没导出密钥，check 的价值正是告诉你还差哪些变量。
  for (const name of missingEnv) {
    issues.push({ level: 'warn', message: `环境变量 ${name} 未设置（该 key/密钥在启动时会装载失败）` });
  }
  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warn');
  const summary = {
    configPath: config.sourcePath,
    server: `${config.server.host}:${config.server.port}`,
    storage: `${config.storage.driver} (${config.storage.path})`,
    providers: config.providers.map((p) => ({
      id: p.id,
      protocol: p.protocol,
      models: p.models.length,
      costConfigured: !!p.cost,
      tags: p.tags ?? [],
    })),
    clients: config.clients.map((c) => ({ id: c.id, tier: c.tier, enabled: c.enabled })),
    tiers: Object.fromEntries(
      Object.entries(config.tiers).map(([k, v]) => [k, { precheck: v.precheck, attribution: v.attribution, rpm: v.rpm, quota: v.periodQuotaTokens }]),
    ),
    modelAliases: config.modelAliases,
    missingEnv,
    lossReduction: {
      precheck: config.lossReduction.precheck,
      attribution: {
        enabled: config.lossReduction.attribution.enabled,
        autoRetry: config.lossReduction.attribution.autoRetry,
        breakerThreshold: config.lossReduction.attribution.breakerThreshold,
      },
      meter: { enabled: config.lossReduction.meter.enabled, retentionDays: config.lossReduction.meter.retentionDays },
      trace: { enabled: config.lossReduction.trace.enabled, persist: config.lossReduction.trace.persist },
    },
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: errors.length === 0, issues, summary }, null, 2)}\n`);
    return errors.length === 0 ? 0 : 1;
  }

  const line = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  line('== 配置校验 ==');
  line(`配置文件: ${config.sourcePath}`);
  line(`监听: ${config.server.host}:${config.server.port}`);
  line(`存储: ${config.storage.driver} → ${config.storage.path}`);
  line('');
  line('-- 上游 --');
  for (const p of config.providers) {
    const pid = p.id ?? '(未命名)';
    const proto = p.protocol ?? 'openai';
    line(`  ${pid.padEnd(14)} ${proto.padEnd(9)} 模型 ${String((p.models ?? []).length).padStart(3)} 个  cost=${p.cost ? 'yes' : 'no '}  tags=${(p.tags ?? []).join(',') || '-'}`);
  }
  if (config.providers.length === 0) line('  （无）');
  line('');
  line('-- 客户端 key / 分层 --');
  for (const c of config.clients) {
    // 渲染必须防御：配置有错时"检查器先崩"是最糟的失败方式——
    // 崩成堆栈还把退出码带成 0，等于告诉用户"配置没问题"。
    const cid = c.id ?? '(未命名)';
    const tier = c.tier ?? '(未设)';
    const t = c.tier ? config.tiers[c.tier] : undefined;
    line(`  ${cid.padEnd(16)} ${String(tier).padEnd(9)} precheck=${t?.precheck} attribution=${t?.attribution} rpm=${t?.rpm ?? '∞'}`);
  }
  if (config.clients.length === 0) line('  （无：网关将拒绝所有请求）');
  line('');
  line('-- 降损层 --');
  line(`  预检 P2:  ${config.lossReduction.precheck.enabled ? 'on' : 'off'}（onBlock=${config.lossReduction.precheck.onBlock}, 预算 ${config.lossReduction.precheck.budgetUs}µs）`);
  line(`  归因 P3:  ${config.lossReduction.attribution.enabled ? 'on' : 'off'}（自动重试 ${config.lossReduction.attribution.autoRetry} 次，熔断阈值 ${config.lossReduction.attribution.breakerThreshold}）`);
  line(`  度量 P8:  ${config.lossReduction.meter.enabled ? 'on' : 'off'}（保留 ${config.lossReduction.meter.retentionDays} 天，正文不落盘=${!config.lossReduction.meter.hashPayloads ? '否' : '是'}）`);
  line(`  轨迹 P5:  ${config.lossReduction.trace.enabled ? 'on' : 'off'}（内存环 ${config.lossReduction.trace.ringSize}）`);
  if (missingEnv.length > 0) {
    line('');
    line('-- 待设置的环境变量 --');
    for (const name of missingEnv) line(`  $ export ${name}=...`);
  }
  line('');
  if (errors.length === 0 && warns.length === 0) {
    line('校验通过，无告警。');
  } else {
    if (errors.length > 0) {
      line(`错误 ${errors.length} 项：`);
      for (const e of errors) line(`  ✗ ${e.message}`);
    }
    if (warns.length > 0) {
      line(`告警 ${warns.length} 项：`);
      for (const w of warns) line(`  ! ${w.message}`);
    }
  }
  return errors.length === 0 ? 0 : 1;
}

async function cmdMock(opts: CliOptions): Promise<number> {
  const logger = new Logger('info');
  const port = opts.port ?? 8899;
  const mock = new MockUpstream({ port, host: opts.host ?? '127.0.0.1', logger });
  const bound = await mock.listen();
  process.stdout.write(`mock 上游已启动: ${bound.url}\n`);
  process.stdout.write(`故障注入：把 model 写成 mock-429 / mock-500 / mock-401 / mock-404 / mock-400 / mock-502 / mock-503 / mock-drop / mock-timeout / mock-filter / mock-context / mock-balance\n`);
  await new Promise<void>((resolvePromise) => {
    const stop = (): void => {
      void mock.close().then(() => resolvePromise());
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}

async function cmdDemo(opts: CliOptions): Promise<number> {
  const port = opts.port ?? 8787;
  const host = opts.host ?? '127.0.0.1';
  let demo: Awaited<ReturnType<typeof startDemo>>;
  try {
    demo = await startDemo({ port, mockPort: 0, host, interactive: true });
  } catch (err) {
    process.stderr.write(`demo 启动失败: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  process.stdout.write(renderDemoBanner(demo.info));
  const checks = await runSelfCheck(demo.info);
  process.stdout.write(`${renderSelfCheck(checks)}\n\n`);
  if (checks.some((c) => !c.ok)) {
    process.stdout.write(yellowLine('  有自检项未通过——这不是预期状态，请把上面的输出贴给我。\n'));
  }
  process.stdout.write(dimLine('  正在运行，按 Ctrl+C 退出…\n'));

  const stop = async (signal: string): Promise<void> => {
    process.stdout.write(`\n  收到 ${signal}，正在优雅退出（flush 度量、关闭数据库）…\n`);
    await demo.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  await new Promise<void>(() => undefined);
  return 0;
}

function dimLine(s: string): string {
  return process.stdout.isTTY ? `\u001b[2m${s}\u001b[0m` : s;
}
function yellowLine(s: string): string {
  return process.stdout.isTTY ? `\u001b[33m${s}\u001b[0m` : s;
}

async function cmdServe(opts: CliOptions): Promise<number> {
  let config: RelayConfig;
  try {
    config = loadWithOverrides(opts);
  } catch (err) {
    process.stderr.write(`配置装载失败: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const issues = inspectConfig(config);
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length > 0 && !opts.allowEmptyProviders) {
    process.stderr.write(`配置存在错误，拒绝启动：\n${errors.map((e) => `  ✗ ${e.message}`).join('\n')}\n`);
    process.stderr.write('（如需在无上游情况下启动骨架，加 --allow-empty-providers）\n');
    return 1;
  }

  const logger = new Logger(config.logLevel);
  for (const w of issues.filter((i) => i.level === 'warn')) logger.warn('config.warning', { message: w.message });

  const app = await createApp(config, logger);
  const bound = await app.start();

  process.stdout.write(`\napi-relay 已启动\n`);
  process.stdout.write(`  网关:      ${bound.url}/v1\n`);
  process.stdout.write(`  管理看板:  ${bound.url}/admin\n`);
  process.stdout.write(`  健康检查:  ${bound.url}/healthz\n`);
  process.stdout.write(`  归因目录:  ${bound.url}/v1/attribution/catalog\n`);
  // 这里的 key 数必须包含从库里恢复的面板 key —— 否则启动横幅说 3 个、面板说 5 个，
  // 而"我的 key 到底在不在"正是这次事故里用户最需要确认的一件事。
  const configKeys = config.clients.length;
  const totalKeys = app.keys.listKeys().length;
  const restored = totalKeys - configKeys;
  process.stdout.write(
    `  上游:      ${config.providers.length} 个；客户端 key: ${totalKeys} 个` +
      (restored > 0 ? `（配置 ${configKeys} + 库里恢复 ${restored}）` : '') +
      '\n',
  );
  if (config.providers.length === 0) {
    process.stdout.write(`  提示:      当前没有上游。想先体验一下可以跑: node dist/cli.js demo\n`);
  }
  process.stdout.write('\n');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('relay.signal', { signal });
    await app.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await new Promise<void>(() => undefined);
  return 0;
}

async function cmdReport(opts: CliOptions): Promise<number> {
  const config = loadWithOverrides(opts);
  const logger = new Logger('error');
  const app = await createApp(config, logger);
  try {
    await app.store.flush();
    const summary = app.meter.summarize(windowMs(opts.window));
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderSummary(summary, { windowLabel: opts.window })}\n`);
    }
    return 0;
  } finally {
    await app.store.close();
  }
}

async function cmdCatalog(opts: CliOptions): Promise<number> {
  const config = loadWithOverrides(opts);
  const app = await createApp(config, new Logger('error'));
  try {
    const matrix = app.router.reachability();
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ models: matrix, providers: app.pool.snapshot().map((p) => ({ id: p.id, models: p.models })) }, null, 2)}\n`);
      return 0;
    }
    process.stdout.write('== 模型 × 上游可达性 ==\n');
    for (const row of matrix) {
      process.stdout.write(`  ${row.model.padEnd(34)} → ${row.providers.join(', ') || '(不可达!)'}\n`);
    }
    return 0;
  } finally {
    await app.store.close();
  }
}

async function cmdTrace(opts: CliOptions): Promise<number> {
  if (!opts.traceId) {
    process.stderr.write('用法: relay trace <traceId>\n');
    return 2;
  }
  const config = loadWithOverrides(opts);
  const app = await createApp(config, new Logger('error'));
  try {
    await app.store.flush();
    const store = app.store as unknown as { sqlFindTrace?: (id: string) => import('./core/types.js').TraceRecord | undefined };
    const trace = app.traceStore.find(opts.traceId) ?? store.sqlFindTrace?.(opts.traceId);
    if (!trace) {
      process.stderr.write(`未找到轨迹 ${opts.traceId}\n`);
      return 1;
    }
    if (opts.json) process.stdout.write(`${JSON.stringify(trace, null, 2)}\n`);
    else process.stdout.write(`${renderTrace(trace, { color: process.stdout.isTTY === true })}\n`);
    return 0;
  } finally {
    await app.store.close();
  }
}

const invokedDirectly = process.argv[1] !== undefined && /cli\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`未捕获错误: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = 1;
    });
}
