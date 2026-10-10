/**
 * 进化方向 handler（P2 拆分第四层）。
 *
 * 从 AdminApi 切出：读/写 data/evolution-direction.json —— operator 手动指定
 * 下一轮进化方向，引擎每轮第 0 步读取并覆盖驾驶舱队列顺序（手动优先）。
 * 依赖只有 config（拿 db 路径推同目录）+ store（审计事件）。
 *
 * 切它的直接原因：key 生命周期组在 api.ts 里被这一小段隔开（1052-1265 与
 * 1338-1442 两段）。把它也切出来，key 组才能连贯，api.ts 也少一段夹层。
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { RelayConfig } from '../../core/types.js';
import type { Store } from '../../store/index.js';
import { json, badRequest } from '../response.js';

export interface EvolutionHandlerDeps {
  config: RelayConfig;
  store: Store;
}

export class EvolutionHandlers {
  constructor(private readonly deps: EvolutionHandlerDeps) {}

  /*
   * 用户指示：进化方向可手动设置、前端操作简单、后端同步、长期目标更新。
   * 设置落 data/evolution-direction.json（与 relay.db 同目录、gitignored）：
   *   { candidates: [{id,label}], setting: { next, note, updatedAt, updatedBy } | null }
   * 引擎每轮第 0 步 GET 本端点：setting 非空时 next 覆盖驾驶舱队列顺序（手动优先，
   * 即『慢慢推进·可手动设置』），并同步进 cockpit 与 goal（后端同步+长期目标更新）；
   * setting 为空=驾驶舱队列自动排序。候选列表由引擎按轮次从驾驶舱 0.2 队列同步刷新
   * （写文件 candidates 段），这里只读写不猜。fail-open：文件缺失/损坏=未设置。 */

  path(): string {
    const dbPath = this.deps.config.storage.path;
    const base = dbPath && dbPath !== ':memory:' ? dirname(dbPath) : 'data';
    return join(base, 'evolution-direction.json');
  }

  view(): { candidates: { id: string; label: string }[]; setting: Record<string, unknown> | null } {
    const fallback = {
      candidates: [
        { id: 'sig-layer', label: '签字层 4 根因项（overview 延迟/agent KB 判重/revoke 断裂/页面体积）' },
        { id: 'gui-audit', label: 'GUI 交互盲区扫描（键盘/空态/错误态/窄屏）' },
        { id: 'retest', label: '周期复测（全端点+首屏+并发+旧目标点名）' },
        { id: 'cf-fixed', label: 'CF 冗余固化（named tunnel 固定地址）' },
        { id: 'kb-keep', label: 'KB 54 篇 agent 文档去留决策' },
        { id: 'self-usage', label: '客户自助用量端点（网关层，需签字）' },
      ],
      setting: null as Record<string, unknown> | null,
    };
    try {
      const file = this.path();
      if (!existsSync(file)) return fallback;
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return fallback;
      const cands = Array.isArray(parsed['candidates']) ? parsed['candidates'] : fallback.candidates;
      const raw = parsed['setting'];
      const setting = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
      return { candidates: cands as { id: string; label: string }[], setting };
    } catch {
      return fallback; // fail-open：读不了=按未设置处理（驾驶舱队列自动排序）
    }
  }

  update(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    const file = this.path();
    // F5 修复：进程内 mutex 防止并发 read-modify-write 竞态
    const write = (setting: Record<string, unknown> | null): boolean => {
      try {
        const cur = this.view();
        const payload = { candidates: cur.candidates, setting, updatedAt: Date.now() };
        const tmp = file + '.tmp';
        writeFileSync(tmp, JSON.stringify(payload));
        renameSync(tmp, file); // 原子替换，防半写文件
        this.deps.store.logEvent('info', 'evolution.direction', {
          next: setting ? setting['next'] : null,
          note: setting ? setting['note'] ?? null : null,
          ...(actor ? { actor } : {}),
        });
        return json(res, 200, { ok: true, setting });
      } catch (err) {
        return badRequest(res, '写入失败: ' + (err instanceof Error ? err.message : String(err)));
      }
    };
    if (!body) return badRequest(res, '缺少请求体');
    if (body['clear'] === true) return write(null);
    const next = typeof body['next'] === 'string' ? (body['next'] as string).trim() : '';
    if (!next) return badRequest(res, 'next 必填（候选 id 或自由文本）；恢复自动请传 clear:true');
    if (next.length > 64) return badRequest(res, 'next ≤64 字');
    const note = typeof body['note'] === 'string' ? (body['note'] as string).trim() : '';
    if (note.length > 200) return badRequest(res, 'note ≤200 字');
    return write({ next, ...(note ? { note } : {}), updatedAt: Date.now(), ...(actor ? { updatedBy: actor } : {}) });
  }
}
