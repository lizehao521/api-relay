/**
 * 知识库（KB）存储层：把「中转平台 + 通用框架」升级为垂直 Agent 聚合平台的
 * 第一个垂直能力——每个客户/Agent 可以建一个知识库，把文档灌进去，
 * 然后通过网关的 /v1/kb/{id}/chat 拿到「带上自己知识」的模型应答。
 *
 * 设计约束（与主库 src/store 一致）：
 * - 零外部依赖：node:sqlite + 纯 JS 关键词检索（对中英文都有效的双字 bigram 分词）。
 * - KB 数据不进入网关转发主路径；主路径（鉴权/路由/透传）完全不碰这里。
 * - 数据库故障 fail-open：init 失败时 KB 退化为"不可用"，网关其余功能照常。
 * - 密钥不进库：KB 本身不存任何上游 key；向量/embedding 走网关已配置的
 *   provider（/v1/embeddings），本模块只存原文 + 倒排索引。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

export interface KbRecord {
  id: string;
  name: string;
  description: string;
  /** 允许访问该 KB 的 key_id（逗号分隔；'*' = 所有 key） */
  allowedKeys: string;
  owner: string;
  createdAt: number;
  updatedAt: number;
}

export interface KbDocRecord {
  id: number;
  kbId: string;
  title: string;
  /** 来源说明（URL / 文件名 / 手动录入） */
  source: string;
  /** 正文（MVP 存原文；分块存在 kb_chunk） */
  content: string;
  chunkCount: number;
  createdAt: number;
}

export interface KbChunkRecord {
  docId: number;
  kbId: string;
  /** 0-based 块序号 */
  seq: number;
  /** 分块后的正文（已做双字切分前的原文） */
  text: string;
}

export interface KbSearchResult {
  kbId: string;
  docId: number;
  docTitle: string;
  seq: number;
  score: number;
  text: string;
}

/* ------------------------------------------------------------------ *
 * 分词 / 关键词检索
 * ------------------------------------------------------------------ */

const STOPWORD_ZH = new Set([
  '的', '了', '在', '是', '我', '你', '他', '她', '它', '我们', '你们', '他们',
  '一个', '这个', '那个', '可以', '可能', '没有', '什么', '怎么', '为什么',
  '如何', '吗', '吧', '啊', '呢', '和', '与', '或', '及', '等', '之', '其',
]);
const STOPWORD_EN = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in',
  'on', 'for', 'and', 'or', 'but', 'it', 'its', 'this', 'that', 'with', 'as',
  'at', 'by', 'from', 'we', 'you', 'they', 'i', 'he', 'she', 'not', 'no',
]);

/**
 * 把文本切成检索单元：
 * - 英文：按 [a-z0-9]+ 切，统一小写，长度 >=2；
 * - 中文：双字 bigram（滑窗 2），这是无分词器下对中文最有效的关键词近似。
 * 返回 Set，去重。
 */
export function tokenize(text: string): Set<string> {
  const units = new Set<string>();
  // 英文词 / 数字
  const en = text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? [];
  for (const w of en) units.add(w.length >= 2 ? w : '');
  // 中文双字 bigram（含单字兜底：对只出现一次的单字也给个单元，避免全丢）
  const zh = text.match(/[\u4e00-\u9fff]/g) ?? [];
  if (zh.length > 0) {
    // 按连续中文段滑窗
    const segs = text.match(/[\u4e00-\u9fff]+/g) ?? [];
    for (const seg of segs) {
      if (seg.length === 1) units.add(seg);
      else for (let i = 0; i + 2 <= seg.length; i++) units.add(seg.slice(i, i + 2));
    }
  }
  for (const u of units) if (u) units.delete(''); // 清理空串
  return units;
}

/** 对单条查询做同样的分词，返回 (unit, 原始出现次数) 列表 */
export function queryTerms(text: string): { term: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const u of tokenize(text)) {
    // 简单加权：中文 bigram 权重 1，英文词权重 1；停用词丢弃
    if (STOPWORD_ZH.has(u) || STOPWORD_EN.has(u)) continue;
    counts.set(u, (counts.get(u) ?? 0) + 1);
  }
  return [...counts.entries()].map(([term, count]) => ({ term, count }));
}

/* ------------------------------------------------------------------ *
 * 存储
 * ------------------------------------------------------------------ */

const KB_SCHEMA = `
CREATE TABLE IF NOT EXISTS kb (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  allowed_keys TEXT NOT NULL DEFAULT '*',
  owner TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_doc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(kb_id) REFERENCES kb(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_kb_doc_kb ON kb_doc(kb_id);
CREATE TABLE IF NOT EXISTS kb_chunk (
  doc_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kb_id TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY(doc_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_kb_chunk_kb ON kb_chunk(kb_id);
`;

export interface KbStoreOptions {
  path: string;
  /** 分块大小（字符）。MVP 固定 512，允许覆盖便于测试 */
  chunkSize?: number;
  /** 分块重叠（字符） */
  chunkOverlap?: number;
}

export class KbStore {
  private db: DatabaseSync | undefined;
  readonly degraded = 0;
  private lastError: string | undefined;
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;

  constructor(private readonly opts: KbStoreOptions) {
    this.chunkSize = opts.chunkSize ?? 512;
    this.chunkOverlap = opts.chunkOverlap ?? 64;
  }

  get ok(): boolean {
    return !!this.db;
  }
  get health(): { ok: boolean; path: string; lastError?: string } {
    return { ok: !!this.db, path: this.opts.path, lastError: this.lastError };
  }

  async init(): Promise<void> {
    try {
      mkdirSync(dirname(this.opts.path), { recursive: true });
      const db = new DatabaseSync(this.opts.path);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA busy_timeout = 3000;');
      db.exec(KB_SCHEMA);
      this.db = db;
    } catch (err) {
      this.db = undefined;
      this.lastError = err instanceof Error ? err.message : String(err);
      // fail-open：KB 不可用不影响网关
    }
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }

  /* ---------------- KB 生命周期 ---------------- */

  createKb(id: string, name: string, description = '', allowedKeys = '*', owner = ''): KbRecord {
    const now = Date.now();
    const row = { id, name, description, allowedKeys, owner, createdAt: now, updatedAt: now };
    this.db
      ?.prepare('INSERT INTO kb (id,name,description,allowed_keys,owner,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, name, description, allowedKeys, owner, now, now);
    return row;
  }

  getKb(id: string): KbRecord | undefined {
    const r = this.db?.prepare('SELECT * FROM kb WHERE id=?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    // 归一化：node:sqlite 在部分版本（如 Node 22.5.0）对"无结果"返回 {列:null} 占位对象，
    // 而非 undefined；把所有字段都是 null 的占位视为"未找到"，避免 getKb 返回假记录。
    const vals = Object.values(r);
    if (vals.length > 0 && vals.every((v) => v === null)) return undefined;
    return this.toKb(r);
  }

  listKbs(): KbRecord[] {
    const rows = this.db?.prepare('SELECT * FROM kb ORDER BY created_at DESC').all() as Record<
      string,
      unknown
    >[];
    return (rows ?? []).map((r) => this.toKb(r));
  }

  updateKb(
    id: string,
    patch: Partial<Pick<KbRecord, 'description' | 'allowedKeys' | 'owner'>>,
  ): KbRecord | undefined {
    const cur = this.getKb(id);
    if (!cur) return undefined;
    const next = {
      description: patch.description ?? cur.description,
      allowedKeys: patch.allowedKeys ?? cur.allowedKeys,
      owner: patch.owner ?? cur.owner,
    };
    this.db
      ?.prepare('UPDATE kb SET description=?, allowed_keys=?, owner=?, updated_at=? WHERE id=?')
      .run(next.description, next.allowedKeys, next.owner, Date.now(), id);
    return this.getKb(id);
  }

  deleteKb(id: string): boolean {
    // 先删子表再删父表（与外键语义一致）；FK 未开 pragma 时手动级联
    this.db?.prepare('DELETE FROM kb_chunk WHERE kb_id=?').run(id);
    this.db?.prepare('DELETE FROM kb_doc WHERE kb_id=?').run(id);
    const ch = this.db?.prepare('DELETE FROM kb WHERE id=?').run(id).changes ?? 0n;
    return ch > 0;
  }

  /* ---------------- 文档 / 分块 ---------------- */

  addDoc(
    kbId: string,
    title: string,
    content: string,
    source = 'manual',
  ): KbDocRecord | { error: string } {
    if (!this.getKb(kbId)) return { error: 'kb_not_found' };
    const now = Date.now();
    const info = this.db
      ?.prepare('INSERT INTO kb_doc (kb_id,title,source,content,chunk_count,created_at) VALUES (?,?,?,?,?,?)')
      .run(kbId, title, source, content, 0, now);
    if (!info) throw new Error('kb: insert kb_doc failed (no DB)');
    const docId = Number(info?.lastInsertRowid ?? 0);
    const chunks = chunkText(content, this.chunkSize, this.chunkOverlap);
    const ins = this.db?.prepare('INSERT INTO kb_chunk (doc_id,seq,kb_id,text) VALUES (?,?,?,?)');
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (c !== undefined) ins?.run(docId, i, kbId, c);
    }
    this.db?.prepare('UPDATE kb_doc SET chunk_count=? WHERE id=?').run(chunks.length, docId);
    this.db?.prepare('UPDATE kb SET updated_at=? WHERE id=?').run(now, kbId);
    return {
      id: docId,
      kbId,
      title,
      source,
      content,
      chunkCount: chunks.length,
      createdAt: now,
    };
  }

  listDocs(kbId: string): KbDocRecord[] {
    const rows = this.db
      ?.prepare('SELECT * FROM kb_doc WHERE kb_id=? ORDER BY created_at DESC, id DESC')
      .all(kbId) as Record<string, unknown>[];
    return (rows ?? []).map((r) => this.toDoc(r));
  }

  getDoc(kbId: string, docId: number): (KbDocRecord & { chunks: KbChunkRecord[] }) | undefined {
    const row = this.db
      ?.prepare('SELECT * FROM kb_doc WHERE id=? AND kb_id=?')
      .get(docId, kbId) as Record<string, unknown> | undefined;
    void row;
    if (!row) return undefined;
    const chunks = this.listChunks(kbId, docId);
    return { ...this.toDoc(row), chunks };
  }

  private listChunks(kbId: string, docId: number): KbChunkRecord[] {
    const rows = this.db
      ?.prepare('SELECT doc_id,seq,kb_id,text FROM kb_chunk WHERE kb_id=? AND doc_id=? ORDER BY seq')
      .all(kbId, docId) as Record<string, unknown>[];
    return (rows ?? []).map((r) => ({
      docId: docId,
      kbId,
      seq: Number(r.seq),
      text: String(r.text),
    }));
  }

  /**
   * 同题 upsert（manual#392·用户 round-392 签字授权）：agent 每 30 分钟沉淀同一主题的
   * 迭代笔记，addDoc 无判重→同题文档无限堆积（#368 实证：159 篇只有 54 个标题，单个
   * 标题最多 41 篇重复；RAG 检索窗口被自家重复文档占用）。upsertDoc 语义：
   *   ① 同 kb+title 不存在 → 走 addDoc（首篇）
   *   ② 已存在 → **原地更新最新那篇**（保留 docId 与 createdAt——『这条笔记从何时就
   *      存在』可追溯），内容换新、块重切
   *   ③ 同题的历史 agent 副本顺势清除（#368 堆积的治愈通道；其他 source 不动）
   * 写路径唯一：agent 回写与将来的同题写入都走这里，addDoc 保留给显式新增的 API。
   */
  upsertDoc(
    kbId: string,
    title: string,
    content: string,
    source = 'agent',
  ): KbDocRecord | { error: string } {
    // 只把**同源**同题文档当候选（manual#392 功能测试纠错）：其他 source 的同题文档
    // （如运营手写）是旁观者——不当候选、不清除、不覆盖。按 created_at ASC 取**最旧**
    // 的作原篇（『这条笔记从何时就存在』可追溯；历史堆积副本的 created_at 更新，若取
    // 最新会把原篇当副本删掉——功能测试 ③④ 两项实测抓到此错）。
    const mine = this.listDocs(kbId).filter((d) => d.title === title && d.source === source);
    if (mine.length === 0) return this.addDoc(kbId, title, content, source);
    const ordered = [...mine].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
    const keep = ordered[0];
    if (!keep) return this.addDoc(kbId, title, content, source);
    const older = ordered.slice(1);
    const now = Date.now();
    const chunks = chunkText(content, this.chunkSize, this.chunkOverlap);
    this.db?.prepare('DELETE FROM kb_chunk WHERE doc_id=?').run(keep.id);
    const ins = this.db?.prepare('INSERT INTO kb_chunk (doc_id,seq,kb_id,text) VALUES (?,?,?,?)');
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (c !== undefined) ins?.run(keep.id, i, kbId, c);
    }
    this.db?.prepare('UPDATE kb_doc SET content=?, source=?, chunk_count=? WHERE id=?')
      .run(content, source, chunks.length, keep.id);
    this.db?.prepare('UPDATE kb SET updated_at=? WHERE id=?').run(now, kbId);
    // 历史同题同源副本清理（older 已由 mine 过滤=全是同源，manual#392：上一次替换
    // 误把循环留成注释，功能测试 ③ 3→3 抓到——清理没发生）
    for (const d of older) {
      this.deleteDoc(kbId, d.id);
    }
    return { ...keep, content, source, chunkCount: chunks.length };
  }

  deleteDoc(kbId: string, docId: number): boolean {
    const ch = this.db?.prepare('DELETE FROM kb_doc WHERE id=? AND kb_id=?').run(docId, kbId).changes ?? 0n;
    this.db?.prepare('DELETE FROM kb_chunk WHERE kb_id=? AND doc_id=?').run(kbId, docId);
    if (ch > 0) this.db?.prepare('UPDATE kb SET updated_at=? WHERE id=?').run(Date.now(), kbId);
    return ch > 0;
  }

  /* ---------------- 检索 ---------------- */

  /**
   * 在指定 KB 内做关键词检索，返回 topK 命中块。
   * 评分：命中的 distinct 词数 * 每词加权（出现在越多块 = 越泛，降权；
   * 出现在越少块 = 越特异，升权，近似 TF-IDF 的 idf 端）。
   */
  search(
    kbId: string,
    query: string,
    topK = 5,
  ): KbSearchResult[] {
    if (!this.getKb(kbId)) return [];
    const terms = queryTerms(query);
    if (terms.length === 0) return [];

    // 载入该 KB 全部块的文本与分词
    const chunks = this.db
      ?.prepare('SELECT doc_id,seq,text FROM kb_chunk WHERE kb_id=?')
      .all(kbId) as Record<string, unknown>[];
    if (!chunks || chunks.length === 0) return [];

    // 文档标题缓存
    const docTitles = new Map<number, string>();
    for (const c of chunks) {
      const did = Number((c as Record<string, unknown>).doc_id);
      if (!docTitles.has(did)) {
        const d = this.db?.prepare('SELECT title FROM kb_doc WHERE id=?').get(did) as
          | Record<string, unknown>
          | undefined;
        docTitles.set(did, d ? String(d.title) : '');
      }
    }

    // 词 -> 出现块集合（用于 idf）
    const posting = new Map<string, Set<number>>();
    const chunkUnits: Set<string>[] = [];
    chunks.forEach((c, idx) => {
      const units = tokenize(String((c as Record<string, unknown>).text));
      chunkUnits.push(units);
      for (const u of units) {
        let s = posting.get(u);
        if (!s) {
          s = new Set();
          posting.set(u, s);
        }
        s.add(idx);
      }
    });

    const N = chunks.length;
    const results: KbSearchResult[] = [];
    for (const { term } of terms) {
      const docUnits = tokenize(term); // 查询词本身也要分词（中文 bigram）
      for (const ut of docUnits) {
        const occ = posting.get(ut);
        if (!occ || occ.size === 0) continue;
        const idf = Math.log(1 + N / occ.size);
        for (const ci of occ) {
          const row = chunks[ci] as Record<string, unknown>;
          results.push({
            kbId,
            docId: Number(row.doc_id),
            docTitle: docTitles.get(Number(row.doc_id)) ?? '',
            seq: Number(row.seq),
            score: idf,
            text: String(row.text),
          });
        }
      }
    }

    // 按 (docId, seq) 聚合
    const agg = new Map<string, { r: KbSearchResult; score: number }>();
    for (const r of results) {
      const k = `${r.docId}:${r.seq}`;
      const cur = agg.get(k);
      if (cur) cur.score += r.score;
      else agg.set(k, { r, score: r.score });
    }
    const ranked = [...agg.values()].sort((a, b) => b.score - a.score).slice(0, topK);
    return ranked.map((x) => ({ ...x.r, score: Math.round(x.score * 1000) / 1000 }));
  }

  /** 统计某 KB 的规模（面板展示用） */
  kbStats(kbId: string): { docs: number; chunks: number; bytes: number } | undefined {
    const row = this.db
      ?.prepare('SELECT COUNT(*) AS docs, COALESCE(SUM(chunk_count),0) AS chunks, COALESCE(SUM(LENGTH(content)),0) AS bytes FROM kb_doc WHERE kb_id=?')
      .get(kbId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { docs: Number(row.docs), chunks: Number(row.chunks), bytes: Number(row.bytes) };
  }

  /* ---------------- 内部 ---------------- */

  private toKb(r: Record<string, unknown>): KbRecord {
    return {
      id: String(r.id),
      name: String(r.name),
      description: String(r.description ?? ''),
      allowedKeys: String(r.allowed_keys ?? '*'),
      owner: String(r.owner ?? ''),
      createdAt: Number(r.created_at ?? 0),
      updatedAt: Number(r.updated_at ?? 0),
    };
  }
  private toDoc(r: Record<string, unknown>): KbDocRecord {
    return {
      id: Number(r.id),
      kbId: String(r.kb_id),
      title: String(r.title),
      source: String(r.source ?? ''),
      content: String(r.content ?? ''),
      chunkCount: Number(r.chunk_count ?? 0),
      createdAt: Number(r.created_at ?? 0),
    };
  }
}

/** 按固定窗口 + 重叠切块，优先在换行/句号边界断开（MVP：硬切 + 重叠）。 */
export function chunkText(text: string, size: number, overlap: number): string[] {
  const t = text.trim();
  if (t.length === 0) return [];
  if (t.length <= size) return [t];
  const out: string[] = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(start + size, t.length);
    // 尽量在空白/句号边界断
    if (end < t.length) {
      let b = end;
      while (b > start + size * 0.5 && !/[\s。，；！？.!?]/.test(t[b] ?? '')) b--;
      if (b > start + size * 0.5) end = b;
    }
    out.push(t.slice(start, end).trim());
    if (end >= t.length) break;
    start = end - overlap;
    if (start <= 0) start = end;
  }
  return out.filter((s) => s.length > 0);
}
