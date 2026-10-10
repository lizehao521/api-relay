/**
 * 起步配置生成器的单测。
 *
 * 这里的断言看着琐碎，但每一条都对应一个真实的翻车方式：
 * 密钥被写进文件、生成的东西自己解析不了、单厂商配置里混进了多上游。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VENDOR_TEMPLATES, findVendor, starterConfigYaml } from '../core/starter.js';
import { parseYaml } from '../core/yaml.js';
import { defaultConfig, deepMerge, inspectConfig } from '../core/config.js';
import type { RelayConfig } from '../core/types.js';
import { interpolateTree } from '../core/yaml.js';
import { buildAuthHeader } from '../upstream/client.js';

/** 生成 YAML 并解析（不做环境变量插值——测"文件里写了什么"时要用原始形态） */
function raw(templateId: string, opts: Record<string, unknown> = {}): { yaml: string; parsed: Record<string, unknown> } {
  const vendor = findVendor(templateId);
  assert.ok(vendor, `模板不存在: ${templateId}`);
  const yaml = starterConfigYaml({ vendor, ...opts });
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  assert.ok(parsed && typeof parsed === 'object', '生成的 YAML 必须能解析');
  return { yaml, parsed };
}

/** 真正装载成 RelayConfig（插值需要把占位符留在原地供断言） */
function build(templateId: string, opts: Record<string, unknown> = {}): { yaml: string; config: RelayConfig } {
  const { yaml, parsed } = raw(templateId, opts);
  // 保留 {ENV:...} 原文：传一个"缺失即返回原样"的 env 代理，避免把占位符换掉
  const config = deepMerge(defaultConfig(), interpolateTree(parsed, {} as NodeJS.ProcessEnv, () => undefined));
  return { yaml, config };
}

test('starter: 每个内置模板都能生成可解析的配置', () => {
  for (const v of VENDOR_TEMPLATES) {
    const { config } = build(v.id);
    assert.equal(config.providers.length, 1, `${v.id} 应该只有一个上游`);
    assert.ok(config.providers[0]!.models.length > 0, `${v.id} 必须有模型`);
  }
});

test('starter: 真实厂商的密钥必须是环境变量占位符，绝不能是明文', () => {
  for (const v of VENDOR_TEMPLATES.filter((x) => x.id !== 'mock')) {
    const { yaml } = raw(v.id);
    // 断言生成文件里的原始文本，而不是插值后的结果——这才是"会不会把密钥写进文件"的真正检查
    assert.ok(yaml.includes(`apiKey: "{ENV:${v.envName}}"`), `${v.id} 的 apiKey 必须是 {ENV:...}`);
    assert.ok(!/apiKey:\s*["']?sk-/.test(yaml), `${v.id} 不得把明文密钥写进文件`);
  }
});

test('starter: mock 模板零配置可跑（不需要任何环境变量）', () => {
  const { config } = build('mock');
  assert.equal(config.providers[0]!.apiKey, 'mock-key');
  // 校验时不应出现"缺少 apiKey"这类错误
  const errors = inspectConfig(config).filter((i) => i.level === 'error');
  assert.deepEqual(errors, [], `mock 模板不该有配置错误: ${errors.map((e) => e.message).join('; ')}`);
});

test('starter: 默认三层的降损开关符合定位（免费层纯管道）', () => {
  const { config } = build('deepseek');
  assert.equal(config.tiers.free.attribution, 'off', '免费层必须保持纯管道语义');
  assert.equal(config.tiers.standard.attribution, 'header');
  assert.equal(config.tiers.pro.attribution, 'full');
  assert.equal(config.tiers.pro.precheck, 'enforce');
});

test('starter: 可以覆盖模型列表', () => {
  const { config } = build('deepseek', { models: ['deepseek-chat'] });
  assert.deepEqual(config.providers[0]!.models, ['deepseek-chat']);
});

test('starter: 可以指定第二个 key 做轮换', () => {
  const { yaml } = raw('deepseek', { envName2: 'DEEPSEEK_API_KEY_2' });
  assert.match(yaml, /apiKeys: \["\{ENV:DEEPSEEK_API_KEY\}", "\{ENV:DEEPSEEK_API_KEY_2\}"\]/);
});

test('starter: 自定义环境变量名生效', () => {
  const { yaml } = raw('deepseek', { envName: 'MY_KEY' });
  assert.ok(yaml.includes('apiKey: "{ENV:MY_KEY}"'));
});

test('starter: 端口与 key 前缀可覆盖', () => {
  const { config, yaml } = build('deepseek', { port: 9000, keyPrefix: 'sk-acme' });
  assert.equal(config.server.port, 9000);
  assert.ok(yaml.includes('sk-acme-pro'));
});

test('starter: 生成的配置里不该出现"三个上游"这类起步期噪音', () => {
  const { yaml, parsed } = raw('deepseek');
  const providers = parsed['providers'] as unknown[];
  assert.equal(providers.length, 1, '起步配置只能有一个上游');
  assert.ok(!yaml.includes('siliconflow'), '不该混入其他厂商');
});

test('starter: 可以关掉降损层配置块（给只想纯转发的场景）', () => {
  const vendor = findVendor('deepseek')!;
  const yaml = starterConfigYaml({ vendor, withLossReduction: false });
  assert.ok(!yaml.includes('lossReduction'), '明确关掉时不该出现该段');
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  assert.ok(parsed, '仍然要能解析');
});

test('starter: 未知厂商返回 undefined（CLI 会给出可用列表）', () => {
  assert.equal(findVendor('nope'), undefined);
  assert.ok(findVendor('DeepSeek'), '厂商标识应大小写不敏感');
});

/* ------------------------------------------------------------------ *
 * 不守 OpenAI 标准的厂商（Agnes 要求 Authorization 不带 Bearer）
 * ------------------------------------------------------------------ */

test('starter: Agnes 模板用 bearerless 鉴权与真实模型名', () => {
  const { yaml, parsed } = raw('agnes');
  const providers = parsed['providers'] as Record<string, unknown>[];
  assert.equal(providers.length, 1);
  const p0 = providers[0]!;
  assert.equal((p0['auth'] as Record<string, unknown>)['format'], 'bearerless');
  assert.ok(yaml.includes('auth: { format: bearerless }'));
  const models = p0['models'] as string[];
  assert.ok(models.includes('agnes-2.5-flash'));
  // 只收 chat 模型：同一账号下的 video/image 端点语义与计费都不同
  assert.ok(!models.some((m) => /video|image/.test(m)), '起步配置不该混入视频/图片模型');
});

test('buildAuthHeader: 四种格式产生的头正确（含 Agnes 的 bearerless）', () => {
  assert.deepEqual(buildAuthHeader('K'), { authorization: 'Bearer K' });
  assert.deepEqual(buildAuthHeader('K', { format: 'bearer' }), { authorization: 'Bearer K' });
  // 关键：不带 Bearer 前缀
  assert.deepEqual(buildAuthHeader('K', { format: 'bearerless' }), { authorization: 'K' });
  assert.deepEqual(buildAuthHeader('K', { format: 'api-key-header' }), { 'api-key': 'K' });
  assert.deepEqual(buildAuthHeader('K', { format: 'api-key-header', headerName: 'X-Token' }), { 'X-Token': 'K' });
  assert.deepEqual(buildAuthHeader('K', { format: 'x-api-key' }), { 'x-api-key': 'K' });
});

/* ------------------------------------------------------------------ *
 * pull-models 的"这个模型能不能接"判据
 *
 * 判据错了不会有报错，只会让配置里多出一个必然失败的模型条目：
 * 用户一 pull 就得到一个打不通的模型，而且看起来像是上游的问题。
 * ------------------------------------------------------------------ */

test('pull-models 判据：MiMo 的 6 个模型里只能自动收下 2 个对话模型', async () => {
  const { NON_CHAT_MODEL } = await import('../cli.js');
  const all = ['mimo-v2.5', 'mimo-v2.5-asr', 'mimo-v2.5-pro', 'mimo-v2.5-tts', 'mimo-v2.5-tts-voiceclone', 'mimo-v2.5-tts-voicedesign'];
  const chat = all.filter((m) => !NON_CHAT_MODEL.test(m));
  assert.deepEqual(chat, ['mimo-v2.5', 'mimo-v2.5-pro']);
  // 语音识别曾经漏判（asr 不在词表里），会把 mimo-v2.5-asr 当成对话模型收进来
  assert.ok(NON_CHAT_MODEL.test('mimo-v2.5-asr'), 'asr 必须被识别为非对话模型');
});

test('pull-models 判据：音频/视频/图像/重排/审核一律排除', async () => {
  const { NON_CHAT_MODEL } = await import('../cli.js');
  for (const m of [
    'gpt-4o-audio-preview',
    'gpt-4o-realtime-preview',
    'whisper-1',
    'qwen-audio-turbo',
    'fun-asr',
    'sensevoice-speech',
    'glm-4-voice',
    'bge-reranker-v2',
    'omni-moderation-latest',
    'wanx-video-v1',
    'flux-image-pro',
    'text-to-transcription-x',
  ]) {
    assert.ok(NON_CHAT_MODEL.test(m), `${m} 应被判为接不了`);
  }
  // 对话模型不能被误杀（尤其别把带 v 的数字当成 version 段）
  for (const m of ['mimo-v2.5', 'mimo-v2.5-pro', 'gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4', 'deepseek-chat', 'qwen2.5-72b-instruct']) {
    assert.ok(!NON_CHAT_MODEL.test(m), `${m} 是对话模型，不能被排除`);
  }
});

test('pull-models 判据：向量模型必须保留 —— 本网关实现了 /v1/embeddings', async () => {
  const { NON_CHAT_MODEL } = await import('../cli.js');
  for (const m of ['text-embedding-3-small', 'bge-m3', 'bge-large-zh', 'embedding-2', 'qwen3-embedding-8b']) {
    assert.ok(!NON_CHAT_MODEL.test(m), `${m} 可通过 /v1/embeddings 转发，不该被排除`);
  }
});
