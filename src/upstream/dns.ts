/**
 * 上游域名解析：**不信系统解析器**，自己问可信 DNS。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么必须这么做（2026-09-14 实测）
 * ─────────────────────────────────────────────────────────────────────
 * 本机 systemd-resolved 的上游列表是 `114.114.114.114 223.5.5.5 …`，
 * 而 114 对 `api.agnes-ai.cn` 回了一个**假地址**：
 *
 *   @114.114.114.114   183.131.87.105     ← 假（TCP 能连上，但永不回数据）
 *   @223.5.5.5         118.180.26.76      ← 真
 *   @119.29.29.29      118.180.26.76      ← 真
 *   @8.8.8.8           118.180.26.76      ← 真
 *   @127.0.0.53        183.131.87.105     ← 本机 stub 跟着错（114 排第一）
 *
 * 实测后果：网关进程里能看到一条 `ESTABLISHED → 183.131.87.105:443`，
 * 而那条请求一个字节都收不到 —— 一直等到首字节超时才换路。
 * 客户侧表现为"时快时慢、偶发几十秒"，也就是"速度堪忧"。
 *
 * 所以：解析用 c-ares 直连可信 DNS（`dns.Resolver`，不走 getaddrinfo / NSS），
 * 拿到真 IP 后**按 IP 建连、SNI 与 :authority 仍用真域名**（证书校验照旧）。
 *
 * 注意：这是**应用层**的兜底，不动系统配置、不需要 root。
 * 若哪天把机器 DNS 换干净（把 114 从上游列表里去掉），这里继续工作也无害。
 */

import { Resolver } from 'node:dns/promises';

/** 可信解析器：阿里、腾讯、Google。**不含 114**（它给过假答案）。 */
const TRUSTED_SERVERS = ['223.5.5.5', '119.29.29.29', '8.8.8.8'];

/** 解析结果缓存（毫秒）。上游 IP 会变，所以不缓存太久。 */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  ip: string;
  at: number;
}

const cache = new Map<string, CacheEntry>();
/** 已经解析失败过的域名，短时间内不再反复问（避免每个请求都白等三个 DNS） */
const failures = new Map<string, number>();

/** 供测试与排障使用 */
export function setTrustedServersForTest(servers: string[]): void {
  trustedResolver = makeResolver(servers);
  cache.clear();
  failures.clear();
}

function makeResolver(servers: string[]): Resolver {
  const r = new Resolver({ timeout: 3_000, tries: 2 });
  r.setServers(servers);
  return r;
}

let trustedResolver: Resolver = makeResolver(TRUSTED_SERVERS);

/**
 * 用可信 DNS 解析一个域名，返回 IPv4 地址。
 * 解析不出来返回 `undefined` —— 调用方自行回退（比如交给系统解析器）。
 */
export async function resolveTrusted(host: string, now = Date.now()): Promise<string | undefined> {
  const hit = cache.get(host);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.ip;

  const failedAt = failures.get(host);
  if (failedAt !== undefined && now - failedAt < CACHE_TTL_MS) {
    // **stale-if-error**（2026-09-14 审计 D-P2-8）：
    // 解析器抖一下时，返回**上次的好 IP** 而不是掉回被污染的系统解析器 ——
    // 老代码在这里直接 return undefined，调用方（client.performRequest）就会走
    // fetch（系统解析器 → 114 的假 IP → 请求挂 90 秒才换路）。
    // 只要曾经解析成功过，临时失败就该用旧 IP 续命；真实 IP 变了顶多错一小段时间。
    const stale = cache.get(host);
    if (stale) return stale.ip;
    return undefined;
  }

  try {
    const ips = await trustedResolver.resolve4(host);
    const ip = ips.find((x) => typeof x === 'string' && x.length > 0);
    if (!ip) {
      failures.set(host, now);
      const stale = cache.get(host);
      return stale ? stale.ip : undefined;
    }
    cache.set(host, { ip, at: now });
    failures.delete(host);
    return ip;
  } catch {
    failures.set(host, now);
    // **第一次失败也照样用旧 IP 续命**（首次失败时 failedAt 分支还没建立，
    // 走不到上面的 stale-if-error —— 测试当场抓住：61s 过期 + 死解析器 → undefined）
    const stale = cache.get(host);
    return stale ? stale.ip : undefined;
  }
}

/** 供测试：直接种一条解析缓存（不必真打 DNS） */
export function seedTrustedCacheForTest(host: string, ip: string): void {
  cache.set(host, { ip, at: Date.now() });
}

/** 清掉缓存（测试与配置热更用） */
export function clearTrustedCache(): void {
  cache.clear();
  failures.clear();
}
