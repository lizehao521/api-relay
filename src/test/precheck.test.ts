/** P2 预检的单测：这是"把错误挡在上游之前"的能力边界，必须逐条钉住。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precheck, createModelCatalog, compileDangerousPatterns, suggestModels, violationReason, PRECHECK_CODES } from '../loss/precheck.js';
import { defaultLossReduction } from '../core/config.js';
import type { LossReductionConfig } from '../core/types.js';

const config: LossReductionConfig = defaultLossReduction();
const catalog = createModelCatalog(['deepseek-chat', 'deepseek-reasoner', 'mock-small']);
const opts = { config, dangerousPatterns: compileDangerousPatterns(config.precheck.dangerousCommandPatterns) };

function run(body: Record<string, unknown>, endpoint = '/v1/chat/completions') {
  return precheck({ endpoint, body, catalog }, opts);
}

const codes = (r: ReturnType<typeof run>): string[] => r.violations.map((v) => v.code);

test('合法请求零违规', () => {
  const r = run({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '你好' }],
    temperature: 0.7,
    max_tokens: 100,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
  assert.ok(r.durationUs >= 0);
});

test('未知模型被拦截并给出最接近的候选', () => {
  const r = run({ model: 'deepseek-chatt', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes(PRECHECK_CODES.MODEL_UNKNOWN));
  const v = r.violations.find((x) => x.code === PRECHECK_CODES.MODEL_UNKNOWN)!;
  assert.match(v.fix, /deepseek-chat/);
});

test('缺少 model / messages 被拦截', () => {
  assert.ok(codes(run({ messages: [{ role: 'user', content: 'x' }] })).includes(PRECHECK_CODES.MODEL_MISSING));
  assert.ok(codes(run({ model: 'deepseek-chat' })).includes(PRECHECK_CODES.MESSAGES_MISSING));
  assert.ok(codes(run({ model: 'deepseek-chat', messages: [] })).includes(PRECHECK_CODES.EMPTY_PROMPT));
});

test('tool_call 的 arguments 必须是 JSON 字符串而非对象（最常见的 Agent 框架 bug）', () => {
  const r = run({
    model: 'deepseek-chat',
    messages: [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: { path: '/a' } } }],
      },
    ],
  });
  assert.ok(codes(r).includes(PRECHECK_CODES.TOOL_CALL_ARGS_INVALID_JSON));
});

test('tool_call 的 arguments 是截断的 JSON 也能被识别', () => {
  const r = run({
    model: 'deepseek-chat',
    messages: [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path": "/a' } }],
      },
    ],
  });
  assert.ok(codes(r).includes(PRECHECK_CODES.TOOL_CALL_ARGS_INVALID_JSON));
});

test('tool 结果回引不存在的 tool_call_id 被拦截', () => {
  const r = run({
    model: 'deepseek-chat',
    messages: [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_b', content: '结果' },
    ],
  });
  assert.ok(codes(r).includes(PRECHECK_CODES.TOOL_CALL_ID_UNKNOWN));
});

test('匹配的 tool_call_id 不报错', () => {
  const r = run({
    model: 'deepseek-chat',
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'call_a', content: '结果' },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('采样参数越界被拦截（用一套边界拦所有上游会误拦 —— 这里只拦协议级硬边界）', () => {
  assert.ok(codes(run({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }], temperature: 5 })).includes(PRECHECK_CODES.SAMPLING_RANGE));
  assert.ok(codes(run({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }], top_p: 0 })).includes(PRECHECK_CODES.SAMPLING_RANGE));
  assert.ok(codes(run({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }], presence_penalty: -9 })).includes(PRECHECK_CODES.SAMPLING_RANGE));
});

test('max_tokens 上限：模型声明过的优先，没声明走配置的绝对天花板', () => {
  // ① 模型显式声明了上限 → 用它
  const withLimit = precheck(
    { endpoint: '/v1/chat/completions', body: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }], max_tokens: 999_999 }, catalog, modelMaxTokens: { 'deepseek-chat': 8192 } },
    opts,
  );
  assert.ok(codes(withLimit).includes(PRECHECK_CODES.MAX_TOKENS_OVER_MODEL));

  // ② 没声明 → 不再是不设防。修复前 `&& ctx.modelMaxTokens` 让整段成为**死代码**
  //    （engine 只传 endpoint/body/catalog，全库无人传 modelMaxTokens），
  //    实测 max_tokens=1e308 / 999999999 一路穿过预检打到上游。
  //    现在由 precheck.maxTokensCeiling 兜底，这里用天花板之上的值验证它真的在拦。
  const overCeiling = run({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }], max_tokens: 99_999_999 });
  assert.ok(!overCeiling.ok, '超过绝对天花板必须被拦');
  assert.ok(codes(overCeiling).includes(PRECHECK_CODES.MAX_TOKENS_OVER_MODEL));
  const v = overCeiling.violations.find((x) => x.code === PRECHECK_CODES.MAX_TOKENS_OVER_MODEL)!;
  assert.match(v.message, /超过网关上/);

  // ③ 天花板之内的合法值仍然放行（不能误杀）
  for (const ok of [1, 1024, 128_000, 999_999]) {
    const r = run({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }], max_tokens: ok });
    assert.equal(r.ok, true, `max_tokens=${ok} 应放行`);
  }
});

test('max_tokens 天花板可关（ceiling=0 退回不设防，保持可逆）', () => {
  const off = {
    config: { ...config, precheck: { ...config.precheck, maxTokensCeiling: 0 } } as LossReductionConfig,
    dangerousPatterns: opts.dangerousPatterns,
  };
  const r = precheck(
    { endpoint: '/v1/chat/completions', body: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }], max_tokens: 1e308 }, catalog },
    off,
  );
  assert.equal(r.ok, true, 'ceiling=0 时应退回修复前的不设防行为');
  assert.ok(!codes(r).includes(PRECHECK_CODES.MAX_TOKENS_OVER_MODEL));
});

test('模型名走原型链键：不得把 Object 当成它的输出上限', () => {
  // 同族防护（第 18 轮刚扫过一遍）：modelMaxTokens['constructor'] 会命中
  // Object.prototype 而拿到一个函数，被当成"上限"后 maxTokens > limit 恒 false，
  // 上限检查被静默绕过。这里确认原型链键不产生该行为。
  for (const m of ['constructor', 'toString', '__proto__']) {
    const r = precheck(
      { endpoint: '/v1/chat/completions', body: { model: m, messages: [{ role: 'user', content: 'x' }], max_tokens: 5000 }, catalog, modelMaxTokens: { 'deepseek-chat': 8192 } },
      opts,
    );
    // 这些模型名本来就会被 model_unknown 拦；关键是不得出现"上限"相关违规或异常
    assert.ok(codes(r).includes(PRECHECK_CODES.MODEL_UNKNOWN), `model=${m} 应因未知模型被拦`);
    assert.ok(!codes(r).includes(PRECHECK_CODES.MAX_TOKENS_OVER_MODEL), `model=${m} 不得触发上限检查`);
  }
});

test('json_object 模式但消息里没有 JSON 指令 → 仅告警不拦截', () => {
  const r = run({ model: 'deepseek-chat', messages: [{ role: 'user', content: '随便聊聊' }], response_format: { type: 'json_object' } });
  assert.equal(r.ok, true);
  assert.ok(codes(r).includes(PRECHECK_CODES.JSON_MODE_WITHOUT_INSTRUCTION));
  assert.equal(r.violations.find((v) => v.code === PRECHECK_CODES.JSON_MODE_WITHOUT_INSTRUCTION)!.severity, 'warn');
});

test('危险命令只对 shell 类工具生效，且只报 block 不误伤普通工具', () => {
  const dangerous = run({
    model: 'deepseek-chat',
    messages: [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ cmd: 'rm -rf / --no-preserve-root' }) } }],
      },
    ],
  });
  assert.ok(codes(dangerous).includes(PRECHECK_CODES.DANGEROUS_COMMAND));

  const innocent = run({
    model: 'deepseek-chat',
    messages: [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_docs', arguments: JSON.stringify({ q: 'rm -rf / 是什么意思' }) } }],
      },
    ],
  });
  assert.ok(!codes(innocent).includes(PRECHECK_CODES.DANGEROUS_COMMAND), '非 shell 工具不应触发命令黑名单');
});

test('重复工具名被拦截（模型无法区分同名工具）', () => {
  const r = run({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'x' }],
    tools: [
      { type: 'function', function: { name: 'search', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'search', parameters: { type: 'object' } } },
    ],
  });
  assert.ok(codes(r).includes(PRECHECK_CODES.TOOLS_DUPLICATE));
});

test('tool_choice 指向未声明的工具被拦截', () => {
  const r = run({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 'a', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'b' } },
  });
  assert.ok(codes(r).includes(PRECHECK_CODES.TOOL_CHOICE_INVALID));
});

test('预检预算耗尽时 fail-open 放行（degraded=上限保护）', () => {
  const tiny: LossReductionConfig = { ...config, precheck: { ...config.precheck, budgetUs: 0.000001 } };
  const body = { model: 'deepseek-chat', messages: Array.from({ length: 200 }, () => ({ role: 'user', content: 'x'.repeat(200) })) };
  const r = precheck({ endpoint: '/v1/chat/completions', body, catalog }, { config: tiny, dangerousPatterns: [] });
  // budgetUs>0 时超预算立即返回；这里只断言"没有抛出且结构完整"
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(Array.isArray(r.violations));
});

test('预算为 0 表示不限制（不会误判为超预算）', () => {
  const off: LossReductionConfig = { ...config, precheck: { ...config.precheck, budgetUs: 0 } };
  const r = precheck(
    { endpoint: '/v1/chat/completions', body: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }] }, catalog },
    { config: off, dangerousPatterns: [] },
  );
  assert.equal(r.ok, true);
});

test('预检是纯函数：同一输入两次调用结果一致', () => {
  // 必须把预算放开再比：预检有 budgetUs 守卫，机器一忙时两次调用可能一次被截断、
  // 一次没截断，违规集就不同 —— 那是**时间相关**，恰恰不是"不纯"。
  // 实测偶发 flake（5 连跑里 1 次失败），根因就是默认 3000µs 在负载下被击穿。
  // 本测试要钉的是确定性，所以用一个不可能被击穿的预算；
  // 预算守卫本身由下面那条安全级测试单独钉。
  const pure = {
    config: { ...config, precheck: { ...config.precheck, budgetUs: 60_000_000 } } as LossReductionConfig,
    dangerousPatterns: opts.dangerousPatterns,
  };
  const body = { model: 'nope', messages: [{ role: 'user', content: 'x' }], temperature: 99 };
  const a = precheck({ endpoint: '/v1/chat/completions', body, catalog }, pure);
  const b = precheck({ endpoint: '/v1/chat/completions', body, catalog }, pure);
  assert.deepEqual(a.violations.map((v) => v.code), b.violations.map((v) => v.code));
});

test('违规码到归因语义的映射覆盖关键类别', () => {
  assert.equal(violationReason('model_unknown'), 'model_not_found');
  assert.equal(violationReason('tool_call_arguments_invalid_json'), 'tool_call_invalid');
  assert.equal(violationReason('messages_too_many'), 'context_length_exceeded');
  assert.equal(violationReason('whatever'), 'invalid_request');
});

test('模型名建议使用编辑距离且不返回无关模型', () => {
  const s = suggestModels('gpt-4o', ['gpt-4o-mini', 'deepseek-chat', 'qwen-max']);
  assert.deepEqual(s, ['gpt-4o-mini']);
  assert.deepEqual(suggestModels('zzzz', ['a', 'b']), []);
});

/* ------------------------------------------------------------------ *
 * 安全级检查不受时间预算影响（回归测试）
 *
 * 现场：预检预算默认只有 3ms，机器一忙就会被击穿。
 * 修复前，"危险命令"扫描排在预算守卫**之后**，于是 CPU 繁忙 == 危险命令拦截自动关闭。
 * 这是安全级失败模式，不是性能取舍。
 * ------------------------------------------------------------------ */

const tightOpts = {
  config: { ...config, precheck: { ...config.precheck, budgetUs: 1 } } as LossReductionConfig,
  dangerousPatterns: compileDangerousPatterns(config.precheck.dangerousCommandPatterns),
};

function runTight(body: Record<string, unknown>) {
  return precheck({ endpoint: '/v1/chat/completions', body, catalog }, tightOpts);
}

const rmrf = (name: string) => ({
  model: 'deepseek-chat',
  messages: [
    { role: 'user', content: 'x' },
    {
      role: 'assistant',
      tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify({ cmd: 'rm -rf / --no-preserve-root' }) } }],
    },
  ],
});

test('预算被打穿时，危险命令仍然必须被拦截（安全级不受时间预算影响）', () => {
  // 1µs 预算：任何时间守卫都会立刻判定超预算
  const r = runTight(rmrf('run_command'));
  assert.ok(
    codes(r).includes(PRECHECK_CODES.DANGEROUS_COMMAND),
    '预算耗尽绝不能等于"安全拦截关闭"',
  );
  assert.equal(r.ok, false, 'block 级违规必须让 ok=false');
});

test('预算被打穿时，提示级检查确实被跳过（证明预算仍然生效，不是被删掉了）', () => {
  // json_object 但没有 JSON 字样 → 本该出一条 warn
  const body = {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '把结果给我' }],
    response_format: { type: 'json_object' },
  };
  assert.ok(
    codes(run(body)).includes(PRECHECK_CODES.JSON_MODE_WITHOUT_INSTRUCTION),
    '预算充足时这条 warn 应该在',
  );
  assert.ok(
    !codes(runTight(body)).includes(PRECHECK_CODES.JSON_MODE_WITHOUT_INSTRUCTION),
    '预算耗尽时提示级检查应被跳过',
  );
});
