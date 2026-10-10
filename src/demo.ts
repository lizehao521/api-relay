/**
 * 一行体验模式（`relay demo`）：把「mock 上游 + 网关 + 看板 + 自检」压成一条命令。
 *
 * 存在的理由：首次接触这套东西的人不该先学五个命令、三个终端、四种环境变量。
 * demo 用一个进程承载全部角色，端口自动避让，任何可以立刻验证的行为都会打印出来。
 *
 * 它不是玩具：跑起来的是**完全相同的引擎、降损层、度量库与管理接口**，
 * 只是把上游换成了本地 mock、把 key 换成了预置的演示 key。
 */

import { MockUpstream } from './mock/upstream.js';
import { createApp } from './app.js';
import { memoryConfig } from './app.js';
import { Logger } from './core/logger.js';
import type { ProviderConfig, RelayConfig } from './core/types.js';
import { createServer } from 'node:net';

export interface DemoOptions {
  /** 网关端口；被占用时自动 +1 重试 */
  port: number;
  /** mock 上游端口；0 = 随机 */
  mockPort: number;
  host: string;
  /** 是否打印并等待（false 用于测试：只装配不阻塞） */
  interactive?: boolean;
  /** 关闭时回调 */
  onReady?: (info: DemoInfo) => void;
}

export interface DemoInfo {
  url: string;
  mockUrl: string;
  adminUrl: string;
  model: string;
  keys: { tier: string; key: string }[];
}

const DEMO_MODELS = [
  'mock-small',
  'mock-large',
  // 故障注入模型名：让"归因卡片长什么样"可以直接 curl 出来看
  'mock-429',
  'mock-503',
  'mock-401',
  'mock-balance',
  'mock-filter',
  'mock-context',
  'mock-404',
];

/** 端口探测：避免"端口被占用"这种与产品无关的首次体验失败 */
async function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });
}

async function pickPort(start: number, host: string, tries = 20): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const p = start + i;
    if (await isPortFree(p, host)) return p;
  }
  return 0; // 交给系统随机分配
}

export function buildDemoConfig(opts: { mockUrl: string; port: number; host: string }): RelayConfig {
  const providers: ProviderConfig[] = [
    {
      id: 'mock',
      label: '本地 mock 上游（会按剧本犯错）',
      protocol: 'openai',
      baseUrl: opts.mockUrl,
      apiKey: 'mock-key',
      models: DEMO_MODELS,
      weight: 1,
      priority: 10,
      tags: ['local', 'demo'],
      cost: { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: 0.2 },
    },
  ];

  const config = memoryConfig({
    providers,
    clients: [
      { id: 'demo-free', label: '演示-免费层（纯管道）', key: 'sk-demo-free', tier: 'free', tenantId: 'demo', enabled: true },
      { id: 'demo-standard', label: '演示-标准层（归因走响应头）', key: 'sk-demo-standard', tier: 'standard', tenantId: 'demo', enabled: true },
      { id: 'demo-pro', label: '演示-Pro 层（归因+预检全开）', key: 'sk-demo-pro', tier: 'pro', tenantId: 'demo', enabled: true },
    ],
    logLevel: 'warn',
  });
  config.server.host = opts.host;
  config.server.port = opts.port;
  // 本机体验模式：管理接口免令牌（仅监听 127.0.0.1，且 demo 会明确提示这一点）
  delete config.server.adminToken;
  config.lossReduction.attribution.autoRetry = 1;
  config.lossReduction.attribution.backoffBaseMs = 50;
  config.lossReduction.attribution.backoffMaxMs = 200;
  return config;
}

/**
 * 装配 demo（不阻塞）。
 * 调用方可以：
 *   - 交互模式：拿到 info 后自行等待信号；
 *   - 测试模式：直接断言 info 与引擎行为，然后 shutdown。
 */
export async function startDemo(opts: DemoOptions): Promise<{
  info: DemoInfo;
  config: RelayConfig;
  shutdown: () => Promise<void>;
}> {
  const host = opts.host;
  const port = opts.port === 0 ? 0 : await pickPort(opts.port, host);
  const logger = new Logger('warn', () => undefined);

  const mock = new MockUpstream({ port: opts.mockPort, host, logger });
  const mockBound = await mock.listen();

  const config = buildDemoConfig({ mockUrl: mockBound.url, port, host });
  const app = await createApp(config, logger);
  const bound = await app.start();

  const info: DemoInfo = {
    url: bound.url,
    mockUrl: mockBound.url,
    adminUrl: `${bound.url}/admin`,
    model: 'mock-small',
    keys: [
      { tier: 'free', key: 'sk-demo-free' },
      { tier: 'standard', key: 'sk-demo-standard' },
      { tier: 'pro', key: 'sk-demo-pro' },
    ],
  };

  return {
    info,
    config,
    shutdown: async () => {
      await app.shutdown();
      await mock.close();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 终端输出（本身就是文档）
 * ------------------------------------------------------------------ */

function c(code: string, s: string): string {
  return process.stdout.isTTY ? `\u001b[${code}m${s}\u001b[0m` : s;
}
const bold = (s: string): string => c('1', s);
const dim = (s: string): string => c('2', s);
const green = (s: string): string => c('32', s);
const cyan = (s: string): string => c('36', s);
const yellow = (s: string): string => c('33', s);

export function renderDemoBanner(info: DemoInfo): string {
  const L: string[] = [];
  L.push('');
  L.push(bold('  api-relay 体验模式已启动') + dim('（mock 上游 + 网关 + 看板，全部在这个进程里）'));
  L.push('');
  L.push(`  ${bold('① 打开看板')}   ${cyan(info.adminUrl)}`);
  L.push(`     看"归因投递率""自动恢复""降损层开销"这些指标——它们回答的是同一个问题：`);
  L.push(dim('     降损层到底有没有在起作用。'));
  L.push('');
  L.push(`  ${bold('② 发一个正常请求')}`);
  L.push(dim(`     curl -s ${info.url}/v1/chat/completions \\`));
  L.push(dim(`       -H 'authorization: Bearer sk-demo-pro' -H 'content-type: application/json' \\`));
  L.push(dim(`       -d '{"model":"mock-small","messages":[{"role":"user","content":"你好"}]}'`));
  L.push('');
  L.push(`  ${bold('③ 看"错误对 Agent 可执行"是什么样')} ${dim('（把 model 换掉即可）')}`);
  for (const [m, why] of [
    ['mock-429', '限流 → 建议等待 Xms 后重试（会自动重试一次）'],
    ['mock-balance', '余额不足 → 402 + top_up_balance，明确不让你重试'],
    ['mock-filter', '内容安全 → rewrite_input（原样重试必然再失败）'],
    ['mock-context', '上下文超限 → reduce_context'],
  ] as const) {
    L.push(dim(`     model=${m.padEnd(14)} ${why}`));
  }
  L.push('');
  L.push(`  ${bold('④ 看分层差异')} ${dim('（同一请求，三层三种行为）')}`);
  for (const k of info.keys) {
    L.push(dim(`     Bearer ${k.key.padEnd(18)} → ${k.tier} 层`));
  }
  L.push('');
  L.push(`  ${bold('⑤ 验证"它没动我的数据"')}`);
  L.push(dim(`     请求头加 x-relay-verify-nonce: <随机串>，响应头会返回`));
  L.push(dim(`     x-relay-content-hmac——用同一个 nonce 重算即可自证字节未被篡改。`));
  L.push('');
  L.push(dim('  上游 mock 端口 ') + cyan(info.mockUrl) + dim('　按 Ctrl+C 退出'));
  L.push('');
  L.push(`  ${bold('⑥ 管理面板能做什么')}`);
  L.push(dim('     面板不只是看：新建/编辑/轮换/禁用客户 key、重置额度、摘除上游、'));
  L.push(dim('     以及热切换降损层开关（线上止损用）。每次写操作都进「配置与事件」页的事件流。'));
  L.push(dim('     明文 key 只在创建/轮换时显示一次——服务端只留 sha256，忘了就轮换。'));
  L.push('');
  L.push(yellow('  注意：体验模式的管理接口免令牌（仅因监听 127.0.0.1）。生产环境必须设置 adminToken。'));
  L.push('');
  return L.join('\n');
}

/** 自检：启动后立刻打几个请求，证明链路真的通了（而不是只打印了 URL） */
export async function runSelfCheck(info: DemoInfo): Promise<{ name: string; ok: boolean; note: string }[]> {
  const out: { name: string; ok: boolean; note: string }[] = [];
  const post = async (body: unknown, key: string): Promise<{ status: number; text: string }> => {
    const res = await fetch(`${info.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };

  try {
    const health = await fetch(`${info.url}/healthz`);
    out.push({ name: '健康检查', ok: health.status === 200, note: `HTTP ${health.status}` });
  } catch (err) {
    out.push({ name: '健康检查', ok: false, note: String(err) });
  }

  try {
    const r = await post({ model: info.model, messages: [{ role: 'user', content: 'hi' }] }, 'sk-demo-pro');
    out.push({ name: '正常请求（Pro 层）', ok: r.status === 200 && r.text.includes('chat.completion'), note: `HTTP ${r.status}` });
  } catch (err) {
    out.push({ name: '正常请求（Pro 层）', ok: false, note: String(err) });
  }

  try {
    const r = await post({ model: 'mock-429', messages: [{ role: 'user', content: 'hi' }] }, 'sk-demo-pro');
    const hasCard = r.text.includes('relay_attribution');
    const hasAction = r.text.includes('retry_with_backoff');
    out.push({
      name: 'P3 失败归因（注入 429）',
      ok: hasCard && hasAction,
      note: hasCard ? (hasAction ? '归因卡片 + 可执行动作 ✓' : '有归因但动作不对') : '未返回归因卡片',
    });
  } catch (err) {
    out.push({ name: 'P3 失败归因（注入 429）', ok: false, note: String(err) });
  }

  try {
    const r = await post(
      {
        model: info.model,
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: { bad: true } } }] },
        ],
      },
      'sk-demo-pro',
    );
    const blocked = r.text.includes('tool_call_arguments_invalid_json');
    out.push({ name: 'P2 预检拦截（畸形 tool_calls）', ok: blocked, note: blocked ? '拦截于上游之前 ✓' : `未被拦截（HTTP ${r.status}）` });
  } catch (err) {
    out.push({ name: 'P2 预检拦截（畸形 tool_calls）', ok: false, note: String(err) });
  }

  try {
    const r = await post({ model: 'mock-429', messages: [{ role: 'user', content: 'hi' }] }, 'sk-demo-free');
    const pure = !r.text.includes('relay_attribution');
    out.push({ name: '免费层纯管道（无归因）', ok: pure, note: pure ? '错误体零附加 ✓' : '免费层不应带归因' });
  } catch (err) {
    out.push({ name: '免费层纯管道（无归因）', ok: false, note: String(err) });
  }

  return out;
}

export function renderSelfCheck(results: { name: string; ok: boolean; note: string }[]): string {
  const lines: string[] = [bold('  自检结果')];
  for (const r of results) {
    lines.push(`    ${r.ok ? green('✓') : yellow('!')} ${r.name.padEnd(28)} ${dim(r.note)}`);
  }
  return lines.join('\n');
}
