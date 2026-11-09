/** 核销码：Crockford Base32，8 位分两段展示（XXXX-XXXX）。 */

import { randomInt } from 'node:crypto';

/** 去掉 I/L/O/U，避免手抄混淆 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RAW_LEN = 8;

export function generateCode(): string {
  let raw = '';
  for (let i = 0; i < RAW_LEN; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return formatCode(raw);
}

export function formatCode(raw: string): string {
  const r = raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  return `${r.slice(0, 4)}-${r.slice(4)}`;
}

/** 接受大小写、带不带连字符；字符集或长度不对返回 null */
export function normalizeCode(input: string): string | null {
  const raw = input.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (raw.length !== RAW_LEN) return null;
  for (const ch of raw) if (!ALPHABET.includes(ch)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** 一码一把 relay key：id 稳定，重启后还能对上账 */
export function codeKeyId(code: string): string {
  return `pk_${code.replace(/-/g, '').toLowerCase()}`;
}
