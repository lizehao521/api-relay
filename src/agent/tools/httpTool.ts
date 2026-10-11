/**
 * 外部 HTTP 工具：运营人员注册的第三方 API 调用（受平台规则约束的受管出口）。
 *
 * 出口闸门（C8 同款语义，零依赖 node 内置实现）：
 * - 仅 http/https 协议；
 * - 主机名经 node:dns 解析后逐地址检查：loopback / 私网 / 链路本地 / 保留 / 云元数据
 *   （169.254.169.254）一律拒绝——Agent 不允许反向探测平台内网与本机管理面；
 * - 字面量 IP（含十进制/八进制/十六进制绕过形态）先归一化再判定；
 * - GET/HEAD 免审批；POST/PUT/DELETE/PATCH 走审批流（fail-closed，approved=true 才执行）；
 * - 超时 15s + 响应体 64KB 上限。
 */
import { lookup } from 'node:dns/promises';
import type { AgentTool, AgentToolContext, ToolResult } from '../types.js';

export interface HttpToolConfig {
  name: string;
  description?: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/** 字面量 IP 归一化：接受十进制/八进制/十六进制/点分形式，返回标准点分或 null */
export function normalizeIpv4(host: string): string | null {
  // 四段点分即可（逐段允许 十六进制0x/八进制0前缀/十进制 混写——IE 式绕过形态
  // 0x7f.0.0.1 / 0177.1.2.3 等是真实绕过向量，逐段归一后判定）；
  // 任一段非数字 = 非 IP 字面量，返回 null 走域名解析路径
  if (/^[^.]+\.[^.]+\.[^.]+\.[^.]+$/.test(host)) {
    const parts = host.split('.').map((p) => {
      if (/^0x[0-9a-f]+$/i.test(p)) return parseInt(p, 16);
      if (/^0[0-7]+$/.test(p)) return parseInt(p, 8);
      if (/^\d+$/.test(p)) return parseInt(p, 10);
      return NaN;
    });
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return parts.join('.');
  }
  return null;
}

/** 地址是否为内网/保留/元数据（拒发） */
export function isBlockedAddress(ip: string): boolean {
  const v4 = normalizeIpv4(ip);
  if (v4) {
    const nums = v4.split('.').map(Number);
    const a = nums[0] ?? -1;
    const b = nums[1] ?? -1;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // 链路本地 + 云元数据
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true; // 00/8 + 2
    if (a >= 224) return true; // 组播/保留/广播
    return false;
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (low.startsWith('fe80:')) return true;
  if (low.startsWith('fc') || low.startsWith('fd')) return true; // ULA
  if (low.startsWith('::ffff:')) return isBlockedAddress(low.slice(7)); // v4 映射
  if (/^[0-9a-f:]+$/.test(low)) return false;
  return true; // 解析结果异常保守拒
}

const BLOCK_MSG = '出口闸门拒绝：目标解析到内网/保留/元数据地址（或协议非 http(s)）——Agent 只允许访问公网 API';

export type GateCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** 出口闸门：协议 + DNS 解析 + 逐地址内网检查（async，因需真实解析） */
export async function gateEgress(rawUrl: string): Promise<GateCheck> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return { ok: false, reason: '出口闸门拒绝：URL 非法' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: BLOCK_MSG };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const v4 = normalizeIpv4(host);
  if (v4) return isBlockedAddress(v4) ? { ok: false, reason: BLOCK_MSG } : { ok: true, url: u };
  if (host.includes(':')) return isBlockedAddress(host) ? { ok: false, reason: BLOCK_MSG } : { ok: true, url: u };
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.length === 0) return { ok: false, reason: '出口闸门拒绝：域名解析为空' };
    for (const a of addrs) if (isBlockedAddress(a.address)) return { ok: false, reason: BLOCK_MSG };
    return { ok: true, url: u };
  } catch {
    return { ok: false, reason: '出口闸门拒绝：域名解析失败' };
  }
}

const MAX_RESP = 64 * 1024;

export function createHttpTool(cfg: HttpToolConfig, deps: { fetchImpl?: typeof fetch } = {}): AgentTool {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const method = (cfg.method || 'GET').toUpperCase();
  const needApproval = WRITE_METHODS.has(method);
  return {
    name: cfg.name,
    description: cfg.description ?? ('HTTP ' + method + ' ' + cfg.url),
    parameters: { type: 'object', properties: { args: { type: 'object', description: '可选：{\\"path_params\\": {}, \\"query\\": {}}' } } },
    async run(_args: Record<string, unknown>, _ctx: AgentToolContext, approved: boolean): Promise<ToolResult> {
      if (needApproval && !approved) {
        return { ok: false, needApproval: true, content: '需审批：' + method + ' 写操作已挂起审批单（异步），批准后执行', pendingPayload: { tool: cfg.name, method, url: cfg.url } };
      }
      const g = await gateEgress(cfg.url);
      if (!g.ok) return { ok: false, content: g.reason };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 15000);
      try {
        const res = await fetchImpl(g.url, {
          method,
          headers: { 'user-agent': 'api-relay-agent/1', ...(cfg.headers ?? {}) },
          signal: controller.signal,
        });
        const body = (await res.text()).slice(0, MAX_RESP);
        const okStatus = res.status >= 200 && res.status < 300;
        return { ok: okStatus, content: 'HTTP ' + res.status + ' ' + res.statusText + '\n' + body };
      } catch (e) {
        return { ok: false, content: 'HTTP 调用失败: ' + (e instanceof Error ? e.message : String(e)) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
