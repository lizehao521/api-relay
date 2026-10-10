/**
 * 管理面鉴权（AdminApi 拆分的第二层）。
 *
 * 从 AdminApi.authorize 抽出。它读 this.deps.config 与两个实例字段
 * （authRateLimits / lastAuthCleanup），按本轮确立的抽层判据属于
 * 「② 读 this.* 但只读一个明确依赖 → 抽成依赖注入的类」。
 *
 * 自持状态的好处：速率限制表与清理计时器跟着鉴权逻辑走，
 * 不再与 2300 行的业务 handler 混在一个类里——以后要调阈值/换存储
 * （比如多实例共享）只动这一个文件。
 */

import type { IncomingMessage } from 'node:http';
import { timeSafeEqual } from '../util/index.js';

/**
 * 从 Authorization 头取令牌。
 * 与 gateway/keys.ts 的 extractBearer 语义**刻意不同**：那里无 Bearer 前缀时
 * 仅在「不含空格」时兜底，这里无条件回落 header.trim()——管理面历史上一直如此，
 * 改动会让某些客户端的鉴权方式静默失效，故原样搬来而不是「统一」。
 */
function extractBearerToken(header?: string): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : header.trim();
}

/** 连续失败上限：达到即锁定 */
const LOCK_THRESHOLD = 20;
/** 锁定时长 5 分钟 */
const LOCK_MS = 5 * 60 * 1000;
/** 速率限制表清理周期 10 分钟（Q001/F3/SEC-002/PERF-006：防内存泄漏） */
const CLEANUP_MS = 10 * 60 * 1000;

interface RateEntry {
  fails: number;
  lockedUntil: number;
}

export interface AuthResult {
  ok: boolean;
  reason?: string;
}

export class AdminAuth {
  /** 按 remote IP 跟踪失败次数（challenge#1·S1） */
  private readonly rateLimits = new Map<string, RateEntry>();
  private lastCleanup = 0;

  constructor(private readonly adminToken: string | undefined) {}

  /**
   * 校验管理令牌。
   * - 未配置 adminToken：仅允许本机（体验模式，配置了才对外）
   * - 支持 X-Admin-Token 头与 Authorization: Bearer 两种携带方式
   * - 连续失败 20 次锁定 5 分钟；第 5 次起在消息里带退避提示
   */
  authorize(req: IncomingMessage, headers: Record<string, string>): AuthResult {
    const remote = req.socket.remoteAddress ?? '';
    const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!this.adminToken) {
      return isLocal ? { ok: true } : { ok: false, reason: '未配置 adminToken，管理接口仅允许本机访问' };
    }

    const now = Date.now();
    if (now - this.lastCleanup > CLEANUP_MS) {
      this.lastCleanup = now;
      for (const [ip, rl] of this.rateLimits) {
        if (rl.lockedUntil < now && rl.fails === 0) this.rateLimits.delete(ip);
      }
    }

    // 锁定期间直接拒绝
    const rl = this.rateLimits.get(remote);
    if (rl && rl.lockedUntil > now) {
      return { ok: false, reason: '管理令牌无效（已锁定，请稍后重试）' };
    }

    const provided = headers['x-admin-token'] ?? extractBearerToken(headers['authorization']);
    if (provided && timeSafeEqual(provided, this.adminToken)) {
      if (rl && rl.fails > 0) this.rateLimits.set(remote, { fails: 0, lockedUntil: 0 });
      return { ok: true };
    }

    const fails = (rl?.fails ?? 0) + 1;
    const lockedUntil = fails >= LOCK_THRESHOLD ? now + LOCK_MS : 0;
    this.rateLimits.set(remote, { fails, lockedUntil });
    // SEC-003/SEC-004：不泄露具体锁定时长和内部头名
    const backoff = fails >= 5 ? `（第 ${fails} 次失败${fails >= LOCK_THRESHOLD ? '，已锁定' : ''}）` : '';
    return { ok: false, reason: `管理令牌无效${backoff}` };
  }
}
