/**
 * 顾客会话：签名 Cookie，不落库。
 *
 * 顾客扫码后拿到一张「码 + 会话 id + 过期时间」的签名票据即可，
 * 服务端不需要为每次扫码建表；重启后票据照样有效（签名密钥是确定的）。
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface CustomerSession {
  /** 核销码（规范格式 XXXX-XXXX） */
  code: string;
  /** 会话 id，仅用于日志归因 */
  sid: string;
  /** 过期时间戳（ms） */
  exp: number;
}

export const SESSION_COOKIE = 'biz_sid';

export class SessionSigner {
  constructor(private readonly secret: string) {}

  sign(code: string, ttlHours: number, now = Date.now()): { token: string; session: CustomerSession } {
    const session: CustomerSession = {
      code,
      sid: randomUUID(),
      exp: now + Math.round(ttlHours * 3_600_000),
    };
    const payload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
    return { token: `${payload}.${this.mac(payload)}`, session };
  }

  verify(token: string | undefined, now = Date.now()): CustomerSession | null {
    if (!token) return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const expected = this.mac(payload);
    if (mac.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(mac, 'utf8'), Buffer.from(expected, 'utf8'))) return null;
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<CustomerSession>;
      if (typeof parsed.code !== 'string' || typeof parsed.sid !== 'string' || typeof parsed.exp !== 'number') return null;
      if (parsed.exp <= now) return null;
      return { code: parsed.code, sid: parsed.sid, exp: parsed.exp };
    } catch {
      return null;
    }
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

export function sessionCookie(token: string, ttlHours: number, secure: boolean): string {
  const maxAge = Math.round(ttlHours * 3600);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
