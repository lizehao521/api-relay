/** YAML 子集解析器与配置装载的单测。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, interpolateTree, interpolateEnv, YamlError } from '../core/yaml.js';
import { loadConfig, deepMerge, inspectConfig, defaultConfig, exampleConfigYaml } from '../core/config.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('parseYaml: 嵌套映射、序列、标量类型', () => {
  const doc = `
server:
  host: 127.0.0.1
  port: 8787
  trustProxy: false
providers:
  - id: a
    baseUrl: https://api.example.com/v1
    models: [m1, m2]
    cost: { inputPerMTok: 2, outputPerMTok: 8 }
  - id: b
    models:
      - m3
      - m4
empty:
nullish: ~
quoted: "含: 冒号的 # 不是注释"
`;
  const parsed = parseYaml(doc) as Record<string, unknown>;
  const server = parsed['server'] as Record<string, unknown>;
  assert.equal(server['host'], '127.0.0.1');
  assert.equal(server['port'], 8787);
  assert.equal(server['trustProxy'], false);
  const providers = parsed['providers'] as Record<string, unknown>[];
  assert.equal(providers.length, 2);
  assert.deepEqual(providers[0]!['models'], ['m1', 'm2']);
  const cost = providers[0]!['cost'] as Record<string, unknown>;
  assert.equal(cost['inputPerMTok'], 2);
  assert.deepEqual(providers[1]!['models'], ['m3', 'm4']);
  assert.equal(parsed['empty'], null);
  assert.equal(parsed['nullish'], null);
  assert.equal(parsed['quoted'], '含: 冒号的 # 不是注释');
});

test('parseYaml: https:// 不会被误判为键分隔符', () => {
  const parsed = parseYaml('url: https://api.deepseek.com/v1\n') as Record<string, unknown>;
  assert.equal(parsed['url'], 'https://api.deepseek.com/v1');
});

test('parseYaml: 注释剥离与块标量', () => {
  const doc = `
# 顶层注释
a: 1   # 行尾注释
b: "带 # 的值"
desc: |
  第一行
  第二行
`;
  const parsed = parseYaml(doc) as Record<string, unknown>;
  assert.equal(parsed['a'], 1);
  assert.equal(parsed['b'], '带 # 的值');
  assert.equal(parsed['desc'], '第一行\n第二行\n');
});

test('parseYaml: Tab 缩进应显式报错而不是静默错读', () => {
  assert.throws(() => parseYaml('a:\n\tb: 1\n'), (e: unknown) => e instanceof YamlError);
});

test('parseYaml: 序列项是流式对象（- {k: v}）不能被花括号里的冒号切碎', () => {
  const parsed = parseYaml(
    'clients:\n  - { id: c1, key: "k1", tier: pro, tenantId: t }\n  - { id: c2, key: k2 }\n',
  ) as Record<string, unknown>;
  const clients = parsed['clients'] as Record<string, unknown>[];
  assert.equal(clients.length, 2);
  assert.deepEqual(clients[0], { id: 'c1', key: 'k1', tier: 'pro', tenantId: 't' });
  assert.deepEqual(clients[1], { id: 'c2', key: 'k2' });
});

test('parseYaml: 同一份流式对象，写成序列项或写成键值，结果必须一致', () => {
  const asSeqItem = parseYaml('list:\n  - { a: 1, b: [x, y] }\n');
  const asValue = parseYaml('list: [{ a: 1, b: [x, y] }]\n');
  assert.deepEqual(asSeqItem, asValue);
});

test('parseYaml: 未闭合的行内集合报错，而不是静默截断', () => {
  assert.throws(
    () => parseYaml('clients:\n  - { id: c1\n'),
    (e: unknown) => e instanceof YamlError && /未闭合/.test((e as Error).message),
  );
});

test('parseYaml: 行内集合已占满序列项，后面再挂同项其它键应报错', () => {
  assert.throws(
    () => parseYaml('clients:\n  - { id: c1 }\n    key: k1\n'),
    (e: unknown) => e instanceof YamlError,
  );
});

test('interpolateEnv: 必需缺失报错、可选回落默认值', () => {
  const env = { PRESENT: 'v' } as NodeJS.ProcessEnv;
  assert.equal(interpolateEnv('{ENV:PRESENT}', env), 'v');
  assert.equal(interpolateEnv('{ENV:MISSING:-fallback}', env), 'fallback');
  assert.equal(interpolateEnv('{ENV:MISSING:-}', env), '');
  assert.throws(() => interpolateEnv('{ENV:MISSING}', env));
});

test('interpolateTree: 递归处理数组与对象', () => {
  const out = interpolateTree({ a: ['{ENV:X:-1}'], b: { c: '{ENV:X:-2}' } }, {} as NodeJS.ProcessEnv);
  assert.deepEqual(out, { a: ['1'], b: { c: '2' } });
});

test('deepMerge: 数组整体替换、对象递归合并', () => {
  const base = { a: 1, b: { c: 2, d: 3 }, list: [1, 2] };
  const out = deepMerge(base, { b: { d: 9 }, list: [7] });
  assert.deepEqual(out, { a: 1, b: { c: 2, d: 9 }, list: [7] });
});

test('loadConfig: 示例配置可被自身解析（防文档漂移）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cfg-'));
  const path = join(dir, 'relay.yaml');
  writeFileSync(path, exampleConfigYaml(), 'utf8');
  const config = loadConfig({
    path,
    env: {
      DEEPSEEK_API_KEY: 'sk-test',
      SILICONFLOW_API_KEY: 'sk-sf-test',
      RELAY_ADMIN_TOKEN: 'admin-token-1234567890',
    } as NodeJS.ProcessEnv,
    requireFile: true,
  });
  assert.equal(config.providers.length, 3);
  assert.equal(config.providers[0]!.id, 'deepseek');
  assert.equal(config.providers[0]!.apiKey, 'sk-test');
  assert.equal(config.clients.length, 3);
  assert.equal(config.tiers.pro.precheck, 'enforce');
  assert.equal(config.modelAliases['gpt-4o-mini'], 'mock-small');
});

test('loadConfig: 缺少必需环境变量时装载失败（不允许静默空密钥）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cfg-'));
  const path = join(dir, 'relay.yaml');
  writeFileSync(path, exampleConfigYaml(), 'utf8');
  assert.throws(
    () => loadConfig({ path, env: {} as NodeJS.ProcessEnv, requireFile: true }),
    /DEEPSEEK_API_KEY/,
  );
});

test('loadConfig: 环境变量覆盖优先级高于文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cfg-'));
  const path = join(dir, 'relay.yaml');
  writeFileSync(
    path,
    `server:\n  port: 1111\nproviders:\n  - id: p\n    baseUrl: http://127.0.0.1:1/v1\n    apiKey: k\n    models: [m]\nclients:\n  - id: c\n    key: k\n    tier: pro\n    tenantId: t\n    enabled: true\n`,
    'utf8',
  );
  const config = loadConfig({ path, env: { RELAY_PORT: '2222' } as NodeJS.ProcessEnv });
  assert.equal(config.server.port, 2222);
});

test('inspectConfig: 捕获重复上游 id、非法 baseUrl、空供应商', () => {
  const config = defaultConfig();
  config.providers = [
    { id: 'dup', label: 'a', protocol: 'openai', baseUrl: 'not-a-url', apiKey: 'k', models: [] },
    { id: 'dup', label: 'b', protocol: 'openai', baseUrl: 'https://x/v1', apiKey: 'k', models: ['m'] },
  ];
  const issues = inspectConfig(config);
  const errors = issues.filter((i) => i.level === 'error').map((i) => i.message);
  assert.ok(errors.some((m) => m.includes('上游 id 重复')));
  assert.ok(errors.some((m) => m.includes('baseUrl')));
  assert.ok(errors.some((m) => m.includes('未声明任何模型')));
  assert.ok(issues.some((i) => i.level === 'warn' && i.message.includes('客户端 key')));
});

test('inspectConfig: smartRouting 无成本数据时给出告警', () => {
  const config = defaultConfig();
  config.providers = [{ id: 'p', label: 'p', protocol: 'openai', baseUrl: 'https://x/v1', apiKey: 'k', models: ['m'] }];
  const issues = inspectConfig(config);
  assert.ok(issues.some((i) => i.level === 'warn' && i.message.includes('smartRouting')));
});
