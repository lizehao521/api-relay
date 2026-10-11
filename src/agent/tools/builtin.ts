/**
 * 平台内置工具：把中转平台的既有能力封装成 Agent 可调用的 tool。
 * 这些工具天然受网关护栏保护（鉴权/计量/归因/熔断），是"沙箱=平台规则"的核心。
 */
import type { AgentTool } from '../types.js';
import type { KbStore } from '../../kb/store.js';
import type { Store } from '../../store/index.js';
import type { Router } from '../../upstream/pool.js';

export interface BuiltinToolDeps {
  kb?: KbStore | undefined;
  store?: Store | undefined;
  router?: Router | undefined;
  kbAsk?: (kbId: string, question: string) => Promise<{ answer: string }> | undefined;
}

function ok(content: string): { ok: boolean; content: string } {
  return { ok: true, content };
}

export function createBuiltinTools(deps: BuiltinToolDeps): AgentTool[] {
  const tools: AgentTool[] = [];

  tools.push({
    name: 'kb_search',
    description: '在中转平台知识库里检索相关文档块（中英文 bigram + TF 加权）。返回命中片段。',
    parameters: {
      type: 'object',
      properties: {
        kb_id: { type: 'string', description: '知识库 id' },
        query: { type: 'string', description: '检索问句' },
        top_k: { type: 'number', description: '返回条数，默认 5' },
      },
      required: ['kb_id', 'query'],
    },
    async run(args) {
      const kbId = String(args.kb_id ?? '');
      const query = String(args.query ?? '');
      if (!deps.kb) return { ok: false, content: '知识库未启用' };
      const hits = deps.kb.search(kbId, query, Number(args.top_k ?? 5));
      if (hits.length === 0) return ok('未检索到相关文档块');
      const text = hits
        .map((h, i) => '[' + (i + 1) + '] ' + h.docTitle + ' (score=' + h.score.toFixed(2) + '): ' + h.text.slice(0, 300))
        .join('\n');
      return ok(text);
    },
  });

  tools.push({
    name: 'kb_ask',
    description: '用知识库回答一个问题（模型带上检索到的知识生成回答）。',
    parameters: {
      type: 'object',
      properties: { kb_id: { type: 'string' }, question: { type: 'string' } },
      required: ['kb_id', 'question'],
    },
    async run(args) {
      if (!deps.kbAsk) return { ok: false, content: '知识库问答未配置' };
      const r = await deps.kbAsk(String(args.kb_id), String(args.question));
      return ok(r?.answer ?? '无回答');
    },
  });

  tools.push({
    name: 'list_keys_masked',
    description: '列出平台已配置的客户端 key 元数据（keyHash 脱敏，不含明文），用于运营核查。',
    parameters: { type: 'object', properties: {} },
    async run() {
      if (!deps.store) return { ok: false, content: '存储未启用' };
      const metas = deps.store.listKeyMeta();
      const text = metas
        .map((m) => 'id=' + m.keyId + ' tier=' + m.tier + ' enabled=' + m.enabled + ' label=' + m.label + ' origin=' + m.origin)
        .join('\n');
      return ok(text || '暂无 key');
    },
  });

  tools.push({
    name: 'flow_status',
    description: '返回上游可达性、可用模型目录与限流状态（平台流量健康快照）。',
    parameters: { type: 'object', properties: {} },
    async run() {
      if (!deps.router) return { ok: false, content: '路由未启用' };
      const reach = deps.router.reachability();
      const catalog = deps.router.availableCatalog();
      // reachability() 形状 {model, providers[], ladder?}：providers 空=不可达（与面板同口径）
      const up = (r: { providers: string[] }) => r.providers.length > 0;
      const lines = reach.map((r) => r.model + ': ' + (up(r) ? 'ok' : 'DOWN') + ' (' + r.providers.length + ' providers)');
      const models = catalog.slice(0, 40).join(', ');
      return ok('reachable=' + reach.filter(up).length + '/' + reach.length + '\n' + lines.join('\n') + '\n目录示例: ' + models);
    },
  });

  tools.push({
    name: 'list_events',
    description: '列出最近的平台运营事件（鉴权失败、熔断、配置变更等），用于排查。',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: '条数，默认 20' } } },
    async run(args) {
      if (!deps.store) return { ok: false, content: '存储未启用' };
      const evs = deps.store.listEvents(Number(args.limit ?? 20));
      const text = evs.map((e) => '[' + ((e.ts as number) || 0) + '] ' + e.kind + ': ' + JSON.stringify(e.detail)).join('\n');
      return ok(text || '暂无事件');
    },
  });

  tools.push({
    name: 'model_list',
    description: '返回平台当前可用模型目录（含上游归属）。',
    parameters: { type: 'object', properties: {} },
    async run() {
      if (!deps.router) return { ok: false, content: '路由未启用' };
      const catalog = deps.router.availableCatalog();
      // availableCatalog(): string[]（对外模型目录）
      return ok(catalog.join('\n') || '暂无模型');
    },
  });

  return tools;
}
