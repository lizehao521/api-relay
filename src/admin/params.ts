/**
 * 管理面 URL 查询参数解析（P2 拆分第四层附带）。
 *
 * 三个函数都是**纯函数**（不读 this）——按拆分判据①，它们本就不该留在 AdminApi 里。
 * 切出 Agent handler 时 `numParam` 被 handlers/agent.ts 需要，正好一起归位。
 *
 * 这三个函数有真实的正确性价值，不只是搬代码：
 *   - windowFrom/windowLabel：标签必须反映**实际生效**的窗口，不能原样回显参数
 *     （曾把「24 小时的数据」标成「10 分钟的数据」）
 *   - numParam：Number('abc')=NaN 会穿过 ?? 默认值，让下游 slice(0,NaN)=[] 表现为
 *     「莫名空结果」而非报错——全站一个数值入口语义
 */

/**
 * 窗口白名单。用 **Map** 而不是对象字面量 —— 对象字面量的 `map[raw]` 会走原型链：
 * `?window=constructor` / `__proto__` / `toString` / `valueOf` 会命中
 * Object.prototype 上的属性，于是 windowFrom 返回一个**函数或对象**而不是数字。
 *
 * 实测后果（2026-10-02，四个管理端点全中）：
 *   /admin/api/metrics?window=constructor
 *     → windowLabel 把 "function Object() { [native code] }" 回显给客户端
 *   /admin/api/overview?window=__proto__
 *     → windowMs 序列化成 {}，summary.from=null、requests/errors 全 0
 *       （24h 实际有 729 个请求 —— 看板显示全零，比报错更坏）
 *   /admin/api/series?window=constructor
 *     → since 变 NaN，图表**静默变空**（对照 ?window=24h 有 24 个点）
 * 即：一个拼错的 window 参数能让看板「不能说谎」的承诺整个失效。
 */
const WINDOW_MS = new Map<string, number>([
  ['5m', 5 * 60_000],
  ['1h', 3_600_000],
  ['24h', 86_400_000],
  ['7d', 7 * 86_400_000],
  ['30d', 30 * 86_400_000],
]);

/** 生效毫秒数 → 规范标签（反向表，供 windowLabelFor 查） */
const WINDOW_LABEL = new Map<number, string>([
  [300_000, '5m'],
  [3_600_000, '1h'],
  [86_400_000, '24h'],
  [604_800_000, '7d'],
  [2_592_000_000, '30d'],
]);

/** 原始 window 参数 → 生效毫秒数。保底 24h；返回值一定是**有限正数**。 */
function windowMsFromRaw(raw: string | null): number {
  if (raw) {
    const hit = WINDOW_MS.get(raw);
    if (hit !== undefined) return hit;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 86_400_000;
}

/**
 * 生效毫秒数 + 原始参数 → 展示标签。
 *
 * 标签必须反映**实际生效**的窗口，不能原样回显参数。曾经 `?window=10m` 不在白名单里
 * → windowFrom 静默退回 24h，而标签照样写着 "10m"，于是面板/看护脚本把「24 小时的
 * 数据」当成「10 分钟的数据」读（实测踩到：10m 报出 187 请求，而真正的 10 分钟只有
 * 4 条）。这与"清单不能说谎"是同一类问题。
 */
function windowLabelFor(effectiveMs: number, raw: string | null): string {
  const effective = WINDOW_LABEL.get(effectiveMs) ?? `${effectiveMs}ms`;
  if (!raw || raw === effective) return effective;
  // `!WINDOW_LABEL.has(Number(raw))`：原始参数不是一个规范毫秒数时才提示"未识别"。
  // 注意别写成 Number.isNaN(Number(raw)) —— `?window=0` 的 Number 是 0 不是 NaN，
  // 但它同样不在白名单里，同样该提示（原有断言盯着这个分支）。
  return effective === '24h' && !WINDOW_LABEL.has(Number(raw))
    ? `${effective}（未识别的 window=${raw}，已按 ${effective} 处理）`
    : effective;
}

export function windowFrom(url: URL): number {
  return windowMsFromRaw(url.searchParams.get('window'));
}

export function windowLabel(url: URL): string {
  return windowLabelFor(windowFrom(url), url.searchParams.get('window'));
}

/**
 * 一次取出窗口的**生效毫秒数**与**展示标签**。
 *
 * 为什么要这个合并入口（P3 收口，2026-10-02）：
 *   ① 省：windowLabel 内部要调两次 windowFrom，而它自己又读一次 searchParams。
 *      「windowFrom(url) + windowLabel(url)”这个常见组合实际会读 **4 次** window
 *      参数、做 2 次 Number() 转换；api.ts 的 report 端点甚至调了 3 次。
 *   ② 对齐：windowFrom 与 windowLabel 各自 get('window')，两个数值可能来自**不同的
 *      参数读取** —— 一旦出现「标签说 24h、数值是 10m」，就是清单说谎（g-v439 同族）。
 *      合并后只读一次，返回的 { windowMs, label } 保证同源。
 *   ③ 原本 params.ts 里的白名单对象字面量每次调用都重建一遍，现已提为模块级常量。
 */
export function windowOf(url: URL): { windowMs: number; label: string } {
  const raw = url.searchParams.get('window');
  const windowMs = windowMsFromRaw(raw);
  return { windowMs, label: windowLabelFor(windowMs, raw) };
}

/**
 * URL 数值参数解析（manual#148）：Number('abc')=NaN 会穿过 ?? 默认值（?? 只拦 null/undefined），
 * 让下游拿到 NaN——slice(0,NaN)=[]、SQL LIMIT NaN，表现为"莫名空结果"而非报错（#147 同族）。
 * 这里：缺省/空串→默认值；非有限数→默认值；越界→clamp。五处查询参数（traces/events/
 * auth-failures/bucketMs/agent runs 的 limit）共用，全站一个数值入口语义。
 */
/**
 * 掩码密钥：留头 6 尾 4，中间打码。短密钥（≤10 字符）整体打码——
 * 头 6 + 尾 4 已经占满，再截等于没掩。
 *
 * 为什么放在 params.ts：它是**纯函数**（不读 this），按抽层判据① 本就不该留在
 * AdminApi 里。此前它内联在 api.ts 的 configView 中，且**重复了两份**
 * （providers.apiKey 与 clients.key），而 providers 的 **apiKeys（多 key 池数组）
 * 完全漏了掩码** —— `{...p}` 展开会把原始 key 数组原样带出 /config（潜伏泄漏）。
 */
export function maskSecret(v: string): string {
  return v.length > 10 ? `${v.slice(0, 6)}...${v.slice(-4)}` : '***';
}

export function numParam(url: URL, key: string, dflt: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}
