import { randomUUID } from 'node:crypto';
import type { AgentDb, StoredApproval } from './session.js';

/**
 * 审批流：越界动作（外部写、平台变更）生成 pending 审批单，人工 approve/reject；
 * 超时未批自动 reject（fail-closed）。
 */
export class ApprovalCenter {
  constructor(private readonly db: AgentDb, private readonly timeoutMs = 30 * 60 * 1000) {}

  create(sessionId: string, tool: string, payload: unknown): StoredApproval {
    const a: StoredApproval = { id: randomUUID(), sessionId, tool, payloadJson: JSON.stringify(payload), status: 'pending', createdAt: Date.now() };
    this.db.saveApproval(a);
    return a;
  }
  get(id: string): StoredApproval | undefined { return this.db.getApproval(id); }
  list(status?: string): StoredApproval[] { return this.db.listApprovals(status); }
  decide(id: string, action: 'approve' | 'reject', actor?: string): StoredApproval | undefined {
    const a = this.db.getApproval(id);
    if (!a || a.status !== 'pending') return a;
    a.status = action === 'approve' ? 'approved' : 'rejected';
    a.decidedAt = Date.now();
    a.actor = actor;
    this.db.saveApproval(a);
    return a;
  }
  /** 把超时未决的 pending 自动置为 expired（fail-closed）。返回被处理的 id 列表。 */
  sweepExpired(): string[] {
    const now = Date.now();
    const pendings = this.db.listApprovals('pending');
    const out: string[] = [];
    for (const a of pendings) {
      if (now - a.createdAt > this.timeoutMs) {
        a.status = 'expired';
        a.decidedAt = now;
        this.db.saveApproval(a);
        out.push(a.id);
      }
    }
    return out;
  }
}
