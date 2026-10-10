/**
 * 上游 provider 运营动作（P2 拆分第四层第四刀）。
 *
 * 两个方法都是**写操作**，且都走 pool 自己的方法（setDisabled / resetBreaker）——
 * 这是 g-v437-reset-must-persist-when-sibling-does 的教训：直接改 entry.health 字段
 * 会绕过 persistBreaker，于是「重置成功」只对当前进程生效、重启后熔断原样回来
 * （实测：置 openUntil=+30min → POST reset 回 200 → 重启 → 仍熔断剩 1673 秒）。
 *
 * deps 只给这三个，不给整个 AdminDeps —— 传整个对象只是把上帝类换个地方。
 */
import type { ServerResponse } from 'node:http';
import { json } from '../response.js';
import type { Logger } from '../../core/logger.js';
import type { ProviderPool } from '../../upstream/pool.js';
import type { Store } from '../../store/index.js';

export interface ProviderHandlerDeps {
  pool: ProviderPool;
  logger: Logger;
  store: Store;
}

export class ProviderHandlers {
  constructor(private readonly deps: ProviderHandlerDeps) {}

  toggle(res: ServerResponse, body: Record<string, unknown> | undefined): boolean {
    const id = typeof body?.['id'] === 'string' ? (body['id'] as string) : '';
    if (!id) {
      json(res, 400, { error: { message: '缺少 id', type: 'invalid_request_error', code: 'invalid_request_error' } });
      return true;
    }
    // disabled 必须显式布尔（manual#146）：'yes'/'true' 等非布尔此前被 === true 洗成 false——
    // 调用方本想摘除上游，实际静默启用（或维持），意图被反转。缺省/非布尔一律 400。
    const rawDisabled = body?.['disabled'];
    if (typeof rawDisabled !== 'boolean') {
      json(res, 400, { error: { message: 'disabled 必须为布尔值（true=摘除 / false=恢复）', type: 'invalid_request_error', code: 'invalid_request_error' } });
      return true;
    }
    const disabled = rawDisabled;
    const ok = this.deps.pool.setDisabled(id, disabled);
    this.deps.logger.warn('admin.provider_toggle', { id, disabled, ok });
    if (ok) this.deps.store.logEvent('warn', 'provider.toggle', { id, disabled });
    json(res, ok ? 200 : 404, ok ? { ok: true, id, disabled } : { error: { message: `上游不存在: ${id}`, type: 'not_found_error', code: 'not_found' } });
    return true;
  }

  reset(res: ServerResponse, body: Record<string, unknown> | undefined): boolean {
    const id = typeof body?.['id'] === 'string' ? (body['id'] as string) : '';
    const entry = this.deps.pool.get(id);
    if (!entry) {
      json(res, 404, { error: { message: `上游不存在: ${id}`, type: 'not_found_error', code: 'not_found' } });
      return true;
    }
    // 走 pool.resetBreaker()（清熔断 **并落盘**），不再直接改 entry.health 字段。
    // 此前不落盘 → 重启后从 breaker_state 恢复旧 openUntil，熔断原样回来，
    // 而面板已回过 200「重置成功」。
    this.deps.pool.resetBreaker(id);
    this.deps.logger.warn('admin.provider_reset', { id });
    this.deps.store.logEvent('warn', 'provider.reset', { id });
    json(res, 200, { ok: true, id, health: entry.health });
    return true;
  }
}
