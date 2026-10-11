/**
 * 知识库（KB）单测：分块、中英文检索、文档 CRUD、KB 规模统计。
 * 用临时 SQLite 库跑真实 KbStore，确保检索与分块逻辑可用。
 */

import { test } from 'node:test';
import { rmTmp } from './testcleanup.js';import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KbStore, chunkText, tokenize, queryTerms } from '../kb/store.js';

function tempKb(t: string): { store: KbStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), t));
  const store = new KbStore({ path: join(dir, 'kb.db'), chunkSize: 128, chunkOverlap: 16 });
  return { store, cleanup: async () => { await rmTmp(dir); } };
}

async function boot(t: string): Promise<{ store: KbStore; cleanup: () => void }> {
  const r = tempKb(t);
  await r.store.init();
  assert.ok(r.store.ok, 'kb 库应初始化成功');
  return { store: r.store, cleanup: r.cleanup };
}

test('kb: 英文词切词与双字中文 bigram', () => {
  const units = tokenize('relay gateway 知识库知识');
  assert.ok(units.has('relay'), '英文词保留');
  assert.ok(units.has('gateway'), '英文词保留');
  assert.ok(units.has('识库'), '中文 bigram 切片');
});

test('kb: 分块在长度边界重叠', () => {
  const chunks = chunkText('a'.repeat(400), 128, 16);
  assert.ok(chunks.length > 2, '应切成多块');
  for (const c of chunks) assert.ok(c.length <= 128, '块超长');
  assert.equal(chunks[0]!.slice(-16), chunks[1]!.slice(0, 16), '相邻块重叠 16');
});

test('kb: 创建 → 加文档 → 检索命中相关块', async () => {
  const { store, cleanup } = await boot('kb-create');
  try {
    store.createKb('k1', '测试库', '描述', '*', 'tester');
    const d = store.addDoc('k1', '文档A', 'OpenAI 兼容的中转网关支持流式 SSE 透传与失败归因卡片。知识库垂直 Agent 可以检索自有文档并生成回答。', 'manual');
    assert.ok('chunkCount' in d, 'addDoc 应返回 KbDocRecord');
    assert.ok(d.chunkCount >= 1, '应至少 1 块');
    const hits = store.search('k1', '失败归因', 3);
    assert.ok(hits.length > 0, '应检索到含关键词的块');
    const stats = store.kbStats('k1');
    assert.equal(stats?.docs, 1);
    assert.ok((stats?.chunks ?? 0) >= 1);
  } finally {
    store.close();
    cleanup();
  }
});

test('kb: 删除 KB 级联清文档与块', async () => {
  const { store, cleanup } = await boot('kb-delete');
  try {
    store.createKb('kx', '待删');
    store.addDoc('kx', 't', 'x'.repeat(300));
    assert.equal(store.deleteKb('kx'), true);
    assert.equal(store.getKb('kx'), undefined);
    assert.equal(store.listDocs('kx').length, 0, '级联清文档');
    assert.equal(store.search('kx', 'x', 5).length, 0, '级联清块');
  } finally {
    store.close();
    cleanup();
  }
});

test('kb: 对未知 KB 检索返回空', async () => {
  const { store, cleanup } = await boot('kb-unknown');
  try {
    assert.deepEqual(store.search('nope', 'query', 5), []);
    assert.equal(store.getKb('nope'), undefined);
    assert.equal(store.deleteKb('nope'), false);
  } finally {
    store.close();
    cleanup();
  }
});

test('kb: queryTerms 过滤停用词', () => {
  const terms = queryTerms('the 知识库 is 好的');
  const names = terms.map((t) => t.term);
  assert.ok(!names.includes('the'), '英文停用词被丢');
  assert.ok(!names.includes('is'), '英文停用词被丢');
});

test('kb: allowedKeys 存储与读取', async () => {
  const { store, cleanup } = await boot('kb-allowed');
  try {
    const rec = store.createKb('k2', '受限库', '', 'pro,standard', 'owner');
    assert.equal(rec.allowedKeys, 'pro,standard');
    const got = store.getKb('k2');
    assert.equal(got?.allowedKeys, 'pro,standard');
  } finally {
    store.close();
    cleanup();
  }
});

test('kb: 删除 KB 后文档与分块全部清空（先子后父）', async () => {
  const { store, cleanup } = await boot('kb-cascade');
  try {
    store.createKb('kc', '级联测试');
    store.addDoc('kc', 'doc1', 'aaaa'.repeat(50));
    store.addDoc('kc', 'doc2', 'bbbb'.repeat(50));
    assert.equal(store.deleteKb('kc'), true, '删除父 KB');
    assert.equal(store.listDocs('kc').length, 0, '子文档已清');
    assert.equal(store.search('kc', 'a', 5).length, 0, '子分块已清');
  } finally {
    store.close();
    cleanup();
  }
});
