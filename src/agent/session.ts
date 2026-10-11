import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentMessage } from './types.js';

/**
 * Agent 持久化层：会话 / 工具注册 / 审批单 / 运行记录。
 * 独立 SQLite 库（agent.db），与网关主 store 解耦；Agent 故障绝不影响主路径。
 */
export interface StoredSession { id: string; kbId?: string; messages: AgentMessage[]; createdAt: number; updatedAt: number; }
export interface StoredTool { name: string; kind: 'builtin' | 'http'; configJson: string; enabled: boolean; createdAt: number; }
export interface StoredApproval { id: string; sessionId: string; tool: string; payloadJson: string; status: 'pending' | 'approved' | 'rejected' | 'expired'; createdAt: number; decidedAt?: number; actor?: string; }
export interface StoredRun { id: string; sessionId: string; tool: string; kind: 'builtin' | 'http'; ok: boolean; summary: string; createdAt: number; }

export class AgentDb {
  private db?: DatabaseSync;
  constructor(private readonly path: string) {}
  init(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new DatabaseSync(this.path);
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec(`CREATE TABLE IF NOT EXISTS agent_session (id TEXT PRIMARY KEY, kb_id TEXT, messages TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_tool (name TEXT PRIMARY KEY, kind TEXT NOT NULL, config_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_approval (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER, actor TEXT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_run (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool TEXT NOT NULL, kind TEXT NOT NULL, ok INTEGER NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    this.db = db;
  }
  private get db_(): DatabaseSync { if (!this.db) throw new Error('agent db not initialized'); return this.db; }
  close(): void { this.db?.close(); this.db = undefined; }

  saveSession(s: StoredSession): void {
    this.db_.prepare('INSERT OR REPLACE INTO agent_session (id, kb_id, messages, created_at, updated_at) VALUES (?,?,?,?,?)').run(s.id, s.kbId ?? null, JSON.stringify(s.messages), s.createdAt, s.updatedAt);
  }
  getSession(id: string): StoredSession | undefined {
    const r = this.db_.prepare('SELECT * FROM agent_session WHERE id=?').get(id) as any;
    if (!r) return undefined;
    return { id: r.id, kbId: r.kb_id ?? undefined, messages: JSON.parse(r.messages), createdAt: r.created_at, updatedAt: r.updated_at };
  }
  listSessions(limit = 50): StoredSession[] {
    return (this.db_.prepare('SELECT * FROM agent_session ORDER BY updated_at DESC LIMIT ?').all(limit) as any[]).map((r) => ({ id: r.id, kbId: r.kb_id ?? undefined, messages: JSON.parse(r.messages), createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  saveTool(t: StoredTool): void {
    this.db_.prepare('INSERT OR REPLACE INTO agent_tool (name, kind, config_json, enabled, created_at) VALUES (?,?,?,?,?)').run(t.name, t.kind, t.configJson, t.enabled ? 1 : 0, t.createdAt);
  }
  listTools(): StoredTool[] {
    return (this.db_.prepare('SELECT * FROM agent_tool').all() as any[]).map((r) => ({ name: r.name, kind: r.kind, configJson: r.config_json, enabled: !!r.enabled, createdAt: r.created_at }));
  }
  getTool(name: string): StoredTool | undefined {
    const r = this.db_.prepare('SELECT * FROM agent_tool WHERE name=?').get(name) as any;
    return r ? { name: r.name, kind: r.kind, configJson: r.config_json, enabled: !!r.enabled, createdAt: r.created_at } : undefined;
  }
  deleteTool(name: string): void { this.db_.prepare('DELETE FROM agent_tool WHERE name=?').run(name); }

  saveApproval(a: StoredApproval): void {
    this.db_.prepare('INSERT OR REPLACE INTO agent_approval (id, session_id, tool, payload_json, status, created_at, decided_at, actor) VALUES (?,?,?,?,?,?,?,?)').run(a.id, a.sessionId, a.tool, a.payloadJson, a.status, a.createdAt, a.decidedAt ?? null, a.actor ?? null);
  }
  getApproval(id: string): StoredApproval | undefined {
    const r = this.db_.prepare('SELECT * FROM agent_approval WHERE id=?').get(id) as any;
    if (!r) return undefined;
    return { id: r.id, sessionId: r.session_id, tool: r.tool, payloadJson: r.payload_json, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at ?? undefined, actor: r.actor ?? undefined };
  }
  listApprovals(status?: string, limit = 50): StoredApproval[] {
    const rows = status ? this.db_.prepare('SELECT * FROM agent_approval WHERE status=? ORDER BY created_at DESC LIMIT ?').all(status, limit) as any[] : this.db_.prepare('SELECT * FROM agent_approval ORDER BY created_at DESC LIMIT ?').all(limit) as any[];
    return rows.map((r) => ({ id: r.id, sessionId: r.session_id, tool: r.tool, payloadJson: r.payload_json, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at ?? undefined, actor: r.actor ?? undefined }));
  }
  saveRun(r: StoredRun): void {
    this.db_.prepare('INSERT OR REPLACE INTO agent_run (id, session_id, tool, kind, ok, summary, created_at) VALUES (?,?,?,?,?,?,?)').run(r.id, r.sessionId, r.tool, r.kind, r.ok ? 1 : 0, r.summary, r.createdAt);
  }
  listRuns(limit = 50): StoredRun[] {
    return (this.db_.prepare('SELECT * FROM agent_run ORDER BY created_at DESC LIMIT ?').all(limit) as any[]).map((r) => ({ id: r.id, sessionId: r.session_id, tool: r.tool, kind: r.kind, ok: !!r.ok, summary: r.summary, createdAt: r.created_at }));
  }
}
