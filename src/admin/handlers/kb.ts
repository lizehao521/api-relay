/**
 * 知识库管理 handler（P2 拆分第四层）。
 *
 * 从 AdminApi 切出：KB 视图 / 创建 / 删除 / 子路由分发（PUT 元数据、docs 增删查、search、stats）。
 * 依赖只有三个（config.kb / kb / store），是全类里内聚度最高的一组——最适合做第四层的首刀。
 *
 * 关键：新类沿用同样的 `this.deps` 形状（config/store/kb），因此方法体**几乎原样搬移**，
 * 只把 `private` 去掉。这样切分的风险最低：不改逻辑，只改归属。
 */

import type { ServerResponse } from 'node:http';
import type { RelayConfig } from '../../core/types.js';
import type { Store } from '../../store/index.js';
import { KbStore } from '../../kb/store.js';
import { json, badRequest } from '../response.js';

/** KB handler 的最小依赖集（不接收整个 AdminDeps——那样只是把上帝类搬个地方） */
export interface KbHandlerDeps {
  config: RelayConfig;
  store: Store;
  /** undefined = 未启用 */
  kb?: KbStore | undefined;
}

export class KbHandlers {
  constructor(private readonly deps: KbHandlerDeps) {}

  /**
   * KB 管理视图。KB 存储未启用（config.kb 缺省 / 初始化失败）时返回 enabled:false，
   * 调用方（面板）据此隐藏 KB 页，而不是报 404 让用户以为接口坏了。
   */
  view(): Record<string, unknown> {
    const kb = this.deps.kb;
    // KB 配置快照（manual#266）：path/chunkSize/chunkOverlap 此前只存在于 relay-net.yaml，
    // 视图不暴露——运营在面板上看不到 KB 库在哪、分块参数是多少（主库路径在 storage 行显，
    // KB 是独立库 by design）。与 #265 同族：在役配置要暴露。
    const kbCfg = this.deps.config.kb;
    const kbConfig = kbCfg && kbCfg.path
      ? { path: kbCfg.path, chunkSize: kbCfg.chunkSize ?? 512, chunkOverlap: kbCfg.chunkOverlap ?? 64 }
      : null;
    if (!kb || !kb.ok) {
      return {
        enabled: false,
        health: kb?.health ?? { ok: false, path: '' },
        kbs: [],
        config: kbConfig,
        note: '知识库存储未启用或初始化失败；在配置里设 storage.kb 路径后重启生效',
      };
    }
    const kbs = kb.listKbs().map((k) => ({
      ...k,
      stats: kb.kbStats(k.id),
    }));
    return {
      enabled: true,
      health: kb.health,
      count: kbs.length,
      kbs,
      config: kbConfig,
    };
  }

  create(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    const kb = this.deps.kb;
    if (!kb || !kb.ok) return json(res, 503, { error: { message: '知识库存储不可用（未启用或数据库故障）', type: 'kb_unavailable', code: 'kb_unavailable' } });
    if (!body) return badRequest(res, '缺少请求体');
    // 类型验证（manual#144）：String() 强转会把数字/对象一起收下（name:123 → "123"，
    // description:{} → "[object Object]" 污染库记录）——字符串字段必须真的是字符串。
    const strField = (v: unknown, dflt: string): string => (typeof v === 'string' ? v.trim() : (v === undefined || v === null ? dflt : ''));
    const name = strField(body['name'], '');
    if (!name || name.length > 64) return badRequest(res, 'name 必填且 ≤64 字（字符串）');
    // 长度上限（manual#264，与 kbUpdate #248 对齐）：此前 create 的 description/allowedKeys
    // 无上限而 update 有 ≤256——同族两端校验不一致（create 收 500 字、update 拒）。
    const description = strField(body['description'], '');
    const allowedKeys = strField(body['allowedKeys'], '*') || '*';
    if (description.length > 256) return badRequest(res, 'description ≤256 字');
    if (allowedKeys.length > 256) return badRequest(res, 'allowedKeys ≤256 字');
    const explicit = strField(body['id'], '');
    const id = explicit || `kb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    if (kb.getKb(id)) return json(res, 409, { error: { message: `知识库已存在: ${id}`, type: 'conflict_error', code: 'kb_exists' } });
    const rec = kb.createKb(
      id,
      name,
      description,
      allowedKeys,
      actor ?? 'panel',
    );
    this.deps.store.logEvent('info', 'kb.create', { id, name, actor });
    // 创建类统一 201（manual#157）：keys/create 早就是 201，KB 创建却是 200——
    // 同一面板上两种创建语义。前端 raw() 只看 res.ok 不受影响，但 API 消费者
    // （curl 脚本/未来集成）按状态码分流时需要一致。
    return json(res, 201, { ok: true, kb: rec });
  }

  del(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    const kb = this.deps.kb;
    if (!kb || !kb.ok) return json(res, 503, { error: { message: '知识库存储不可用', type: 'kb_unavailable', code: 'kb_unavailable' } });
    const id = String(body?.['id'] ?? '').trim();
    if (!id) return badRequest(res, '缺少 id');
    if (!kb.deleteKb(id)) return json(res, 404, { error: { message: `知识库不存在: ${id}`, type: 'not_found_error', code: 'not_found' } });
    this.deps.store.logEvent('warn', 'kb.delete', { id, actor });
    return json(res, 200, { ok: true, deleted: id });
  }

  /**
   * /admin/api/kb/{id}/... 子路由分发：KB 元数据 + 文档管理 + 检索。
   * 形如：
   *   PUT    kb/{id}                 更新元数据 {description?, allowedKeys?, owner?}（manual#97）
   *   GET    kb/{id}/docs            列出文档
   *   POST   kb/{id}/docs            添加文档 {title, content, source?}
   *   DELETE kb/{id}/docs/{docId}    删除文档
   *   POST   kb/{id}/search          检索 {query, topK?}
   *   GET    kb/{id}/stats           规模统计
   */
  route(
    method: string,
    action: string,
    url: URL,
    body: Record<string, unknown> | undefined,
    res: import('node:http').ServerResponse,
    actor?: string,
  ): boolean {
    const kb = this.deps.kb;
    if (!kb || !kb.ok) return json(res, 503, { error: { message: '知识库存储不可用', type: 'kb_unavailable', code: 'kb_unavailable' } });
    // action 形如 'kb/{id}/docs/{docId}' 或 'kb/{id}/search'
    const parts = action.split('/'); // [kb, {id}, docs?, {docId}? / search / stats]
    const id = parts[1] ?? '';
    if (!id || !kb.getKb(id)) {
      return json(res, 404, { error: { message: `知识库不存在: ${id}`, type: 'not_found_error', code: 'not_found' } });
    }
    const sub = parts.slice(2).join('/'); // 'docs' | 'docs/{docId}' | 'search' | 'stats' | ''

    // sub 形如: 'docs' | 'docs/1' | 'search' | 'stats'
    const subParts = sub.split('/');
    const subCmd = subParts[0] ?? '';

    /*
     * 路由深度纪律（manual#96 全分支审计固化）：
     * 父路径分支一律带 subParts.length 条件——一级分支 length===1，深层分支 length>=2 且校验 subParts[1]。
     * 违反此规则的同型 bug 已两连踩：#94 GET 列表分支（不看深度）短路 /docs/{docId}；
     * #95 POST 单篇分支（不看深度）短路 /docs/batch。单测覆盖不到路由分支顺序，
     * 根治靠：①本条纪律 ②端到端实测 ③路由纪律测试（需 src/test/ 白名单扩张，待签字）。
     * 新增子路径功能时，必须回头检查所有同前缀父分支。
     */

    // PUT /kb/{id} → 更新 KB 元数据（manual#97：updateKb store 层早有，管理面补路由+GUI；
    // 描述/允许 key/owner 可改，名称不可改——KbRecord 的 name 不在 updateKb 的 patch 类型里）
    if (method === 'PUT' && subCmd === '' && subParts.length === 1) {
      // 类型验证（manual#144）：同 kbCreate——String() 强转会把对象/数字收成 "[object Object]"/"123"
      // 字段语义修正（manual#248）：此前三字段用「真值才更新」——运营在 GUI 清空描述/owner
      // 保存后旧值静默保留（清空=不传=不改）。改为「提供了就更新（含显式空串=清除）」：
      // ①给了但类型不对 → 400（#144 严格化，不静默丢弃）；②给了空串 → 清除；
      // ③没给 → 不动。updateKb 用 ?? 兜底，传 '' 能真正写空值（store 层已支持）。
      const sField = (field: string): { provided: boolean; value: string } => {
        const v = body?.[field];
        if (v === undefined || v === null) return { provided: false, value: '' };
        if (typeof v !== 'string') { badRequest(res, field + ' 必须为字符串'); return { provided: false, value: '' }; }
        return { provided: true, value: v.trim() };
      };
      const description = sField('description');
      const allowedKeys = sField('allowedKeys');
      const owner = sField('owner');
      // 长度上限（manual#248，#247 全家福的 kb 编辑侧）：description/owner 此前裸奔
      // （500 字描述能存——实测过，且无清除入口时只能留占位）。
      if (description.provided && description.value.length > 256) return badRequest(res, 'description ≤256 字');
      if (allowedKeys.provided && allowedKeys.value.length > 256) return badRequest(res, 'allowedKeys ≤256 字');
      if (owner.provided && owner.value.length > 64) return badRequest(res, 'owner ≤64 字');
      const rec = kb.updateKb(id, {
        ...(description.provided ? { description: description.value } : {}),
        ...(allowedKeys.provided ? { allowedKeys: allowedKeys.value } : {}),
        ...(owner.provided ? { owner: owner.value } : {}),
      });
      if (!rec) return json(res, 404, { error: { message: `知识库不存在: ${id}`, type: 'not_found_error', code: 'not_found' } });
      this.deps.store.logEvent('info', 'kb.update', { id, description: !!description, allowedKeys: !!allowedKeys, owner: !!owner, actor });
      return json(res, 200, { ok: true, kb: rec });
    }
    // GET /docs → 列文档（仅一级；/docs/{docId} 交给下面的详情分支）; GET /stats → 统计
    if (method === 'GET' && subCmd === 'docs' && subParts.length === 1) {
      return json(res, 200, { kb: id, docs: kb.listDocs(id) });
    }
    if (method === 'GET' && subCmd === 'stats' && subParts.length === 1) {
      return json(res, 200, { kb: id, stats: kb.kbStats(id) });
    }
    // POST /docs → 加文档（仅一级；/docs/batch 与 /docs/{docId} 见下方分支）; DELETE /docs/{docId} → 删文档
    if (method === 'POST' && subCmd === 'docs' && subParts.length === 1) {
      const title = String(body?.['title'] ?? '').trim();
      const content = String(body?.['content'] ?? '').trim();
      if (!title || !content) return badRequest(res, 'title 与 content 必填');
      // 标题长度上限（manual#247，#151 的 label 模式）：KB name/key label 早有 ≤64，
      // doc 标题却裸奔——500 字标题会把文档表格拉爆（无 ellipsis）。128 对现有最长
      // 标题（56，每轮+几个字的错题本）留足余量。
      if (title.length > 128) return badRequest(res, 'title ≤128 字（字符串）');
      const r = kb.addDoc(id, title, content, String(body?.['source'] ?? 'api'));
      if ('error' in r) return json(res, 400, { error: { message: r.error, type: 'kb_error', code: 'kb_error' } });
      this.deps.store.logEvent('info', 'kb.doc_add', { id, title, chunks: r.chunkCount, actor });
      return json(res, 201, { ok: true, doc: r });
    }
    // GET /docs/{docId} → 文档详情（含正文+分块；manual#94 编辑表单预填用）
    if (method === 'GET' && subCmd === 'docs' && subParts.length >= 2) {
      const docId = Number(subParts[1] ?? '0');
      if (!Number.isFinite(docId) || docId <= 0) return badRequest(res, 'docId 非法');
      const doc = kb.getDoc(id, docId);
      if (!doc) return json(res, 404, { error: { message: `文档不存在: ${docId}`, type: 'not_found_error', code: 'not_found' } });
      return json(res, 200, { kb: id, doc });
    }
    // PUT /docs/{docId} → 替换文档（manual#94：KbStore 无 updateDoc，store 层不动——
    // 管理面用 delete+add 实现替换并记审计事件；UI 明示「ID 会变、分块重算」）
    // POST /docs/batch → 批量灌入（manual#95：KB 播种是 N 篇一轮的工作流，逐篇手填低效）；
    // 逐篇 addDoc，单篇失败不影响其余；返回逐篇结果供 UI 汇总。
    if (method === 'POST' && subCmd === 'docs' && subParts[1] === 'batch') {
      const docs = body?.['docs'];
      if (!Array.isArray(docs) || docs.length === 0) return badRequest(res, 'docs 必须为非空数组');
      if (docs.length > 50) return badRequest(res, '单次批量上限 50 篇');
      const results: unknown[] = [];
      let okCount = 0;
      for (const item of docs) {
        const title = String((item as Record<string, unknown>)?.['title'] ?? '').trim();
        const content = String((item as Record<string, unknown>)?.['content'] ?? '').trim();
        const source = String((item as Record<string, unknown>)?.['source'] ?? 'batch');
        if (!title || !content) {
          results.push({ title: title || '(无标题)', ok: false, error: 'title 与 content 必填' });
          continue;
        }
        if (title.length > 128) {
          results.push({ title: title.slice(0, 24) + '…', ok: false, error: 'title ≤128 字' });
          continue;
        }
        const r = kb.addDoc(id, title, content, source);
        if ('error' in r) {
          results.push({ title, ok: false, error: r.error });
        } else {
          okCount += 1;
          results.push({ title, ok: true, id: r.id, chunkCount: r.chunkCount });
        }
      }
      this.deps.store.logEvent('info', 'kb.doc_batch', { id, total: docs.length, ok: okCount, fail: docs.length - okCount, actor });
      return json(res, 200, { ok: true, total: docs.length, okCount, failCount: docs.length - okCount, results });
    }
    if (method === 'PUT' && subCmd === 'docs' && subParts.length >= 2) {
      const docId = Number(subParts[1] ?? '0');
      if (!Number.isFinite(docId) || docId <= 0) return badRequest(res, 'docId 非法');
      const title = String(body?.['title'] ?? '').trim();
      const content = String(body?.['content'] ?? '').trim();
      if (!title || !content) return badRequest(res, 'title 与 content 必填');
      const old = kb.getDoc(id, docId);
      if (!old) return json(res, 404, { error: { message: `文档不存在: ${docId}`, type: 'not_found_error', code: 'not_found' } });
      // 先加后备删（manual#95）：删除先行时「删成功+加失败」= 文档丢失；先加后删把极端失败
      // 降级为「新旧并存」（可人工清理），数据安全方向更优。彻底事务化需 store 层支持（能力层）。
      const r = kb.addDoc(id, title, content, String(body?.['source'] ?? old.source ?? 'api'));
      if ('error' in r) return json(res, 400, { error: { message: r.error, type: 'kb_error', code: 'kb_error' } });
      if (!kb.deleteDoc(id, docId)) {
        this.deps.store.logEvent('warn', 'kb.doc_replace_partial', { id, docId, newDocId: r.id, actor, note: 'new_added_old_delete_failed' });
        return json(res, 200, { ok: true, replaced: docId, doc: r, warning: '新文档已写入，但旧文档删除失败——请手动删除旧文档 ' + docId });
      }
      this.deps.store.logEvent('warn', 'kb.doc_replace', { id, docId, newDocId: r.id, chunks: r.chunkCount, actor });
      return json(res, 200, { ok: true, replaced: docId, doc: r });
    }
    if (method === 'DELETE' && subCmd === 'docs' && subParts.length === 2) {
      const docId = Number(subParts[1] ?? '0');
      if (!Number.isFinite(docId) || docId <= 0) return badRequest(res, 'docId 非法');
      if (!kb.deleteDoc(id, docId)) return json(res, 404, { error: { message: `文档不存在: ${docId}`, type: 'not_found_error', code: 'not_found' } });
      this.deps.store.logEvent('warn', 'kb.doc_delete', { id, docId, actor });
      return json(res, 200, { ok: true, deleted: docId });
    }
    if (method === 'POST' && subCmd === 'search' && subParts.length === 1) {
      const query = String(body?.['query'] ?? '').trim();
      if (!query) return badRequest(res, 'query 必填');
      // topK 显式校验（manual#147）：Number('abc')=NaN 会穿过 Math.min/max  clamp，
      // 让检索静默返回 0 条（看起来像『没有匹配』而不是『参数错了』）——与 #144~#146
      // 同一族：给错类型必须报错。GUI 侧发的本就是数字（dashboard.ts Number() 转换），不受影响。
      const topKRaw = body?.['topK'];
      if (topKRaw !== undefined && topKRaw !== null && (typeof topKRaw !== 'number' || !Number.isFinite(topKRaw))) {
        return badRequest(res, 'topK 必须为数字（1-20）');
      }
      const topK = Math.min(20, Math.max(1, Number(topKRaw ?? 5)));
      // 按文档去重（manual#251）：kb.search 是分块级 top-K——一篇长文档（如每轮增长的
      // 校准文）能把整个结果列表占满（同一篇出现 5 次），别的文档被挤出视野。
      // 检索的语义是『找相关文档』：按 docId 保留最高分块，仍给 topK 条。
      // 响应形状不变（seq/docId/docTitle/score/text 都在），只是同文档不重复出现。
      // 取窗口要足够大（manual#258 修正 #251）：topK*3 不够——一篇巨文（每轮增长的
      // 校准文档）的高分块能占满整个窗口，去重后凑不满 topK 篇（实测 topK=2 只回 1 篇）。
      // 固定取 30 块再按文档去重（kb.search 成本随 limit 线性，30 可忽略）。
      const hits = kb.search(id, query, Math.max(30, topK * 5));
      // RAG 视角（manual#321）：chunks=true 时跳过去重直接回 topK 个原始块——客户端 ask 的
      // 检索就是 chunk 级（同一篇可占多席），运营验证检索质量时要看的就是引擎实际会引用的
      // 那些块；默认（不传）仍是文档视角（按 docId 去重），契约不变。
      if (body?.['chunks'] === true) {
        return json(res, 200, { kb: id, query, chunks: true, results: hits.slice(0, topK) });
      }
      const seen = new Set<string>();
      const results: typeof hits = [];
      for (const h of hits) {
        const key = String(h.docId ?? h.seq);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(h);
        if (results.length >= topK) break;
      }
      return json(res, 200, { kb: id, query, chunks: false, results });
    }
    return json(res, 404, { error: { message: `未知 KB 子路由 ${method} kb/${id}/${sub}`, type: 'not_found_error', code: 'not_found' } });
  }
}
