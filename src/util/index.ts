/** 小型工具集：零依赖，全部为纯函数或显式带副作用的窄接口。 */

import { createHash, createHmac, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

/* ------------------------------------------------------------------ *
 * ID 与哈希
 * ------------------------------------------------------------------ */

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function shortId(len = 12, prefix = ''): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length];
  return prefix ? `${prefix}_${out}` : out;
}

/** OpenAI 风格 response id：chatcmpl-xxx */
export function nowMs(): number {
  return Date.now();
}

/** 单调时钟，用于延迟测量（不受系统时间调整影响） */
export function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

export function monotonicUs(): number {
  return Number(process.hrtime.bigint() / 1_000n);
}

export function sha256Hex(input: string | Uint8Array, salt = ''): string {
  const h = createHash('sha256');
  if (salt) h.update(salt);
  h.update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input);
  return h.digest('hex');
}

/**
 * HMAC-SHA256 十六进制。
 *
 * 为什么需要它：把 system prompt / 请求体指纹化成"哈希"时，裸 sha256 会被字典反推
 * （system prompt 是低熵文本，攻击者可以穷举常见 Agent 模板）。带进程级密钥的 HMAC
 * 才能让指纹"可比较但不可还原"。
 */
export function hmacHex(key: string, input: string | Uint8Array): string {
  const h = createHmac('sha256', key);
  h.update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input);
  return h.digest('hex');
}

/** 常数时间比较，避免时序侧信道 */
export function timeSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return nodeTimingSafeEqual(ba, bb);
}

export function safeJsonParse<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/**
 * 只取**自有**属性的查找（原型链安全）。
 *
 * 为什么需要它：`obj[key]` 在 key 为 `constructor` / `__proto__` / `toString` /
 * `valueOf` 等时会命中 Object.prototype 上的属性，于是「查不到」变成了「查到一个
 * 函数/对象」。params.ts 的 windowFrom 就是这么中招的（2026-10-02 实测）：一个拼错的
 * `?window=constructor` 让 windowMs 变成函数、看板显示全零、标签把
 * "function Object() { [native code] }" 回显给客户端。
 *
 * 与 Map 的取舍：**键空间固定**的查找用 Map 更彻底（params.ts 的窗口白名单已改 Map）；
 * 这里服务的是「键空间来自配置/用户、容器是普通对象」的场合（modelCapabilities /
 * modelAliases / tiers / modelCapabilities 等），不可能逐个换成 Map。
 *
 * 注意 `in` 运算符和直接索引都会走原型链，都必须避免；`Object.hasOwn` 是唯一正道。
 */
export function ownLookup<T>(obj: Record<string, T> | undefined, key: string): T | undefined {
  if (!obj) return undefined;
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/* ------------------------------------------------------------------ *
 * 数值
 * ------------------------------------------------------------------ */

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = clamp(Math.ceil((p / 100) * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[idx]!;
}

/** 指数加权移动平均 */
export function ewma(prev: number, sample: number, alpha = 0.3): number {
  if (!Number.isFinite(prev) || prev <= 0) return sample;
  return prev * (1 - alpha) + sample * alpha;
}

export function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/* ------------------------------------------------------------------ *
 * 时间
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 流与异步
 * ------------------------------------------------------------------ */

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 指数退避 + 抖动；base 毫秒 */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const raw = baseMs * 2 ** Math.max(0, attempt);
  const capped = Math.min(raw, maxMs);
  const jitter = Math.random() * capped * 0.25;
  return Math.round(capped * 0.75 + jitter);
}

/** 有界 FIFO 缓存：命中返回缓存值，否则计算并写入 */
export class BoundedCache<V> {
  private readonly map = new Map<string, V>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly capacity: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) {
      this.misses++;
      return undefined;
    }
    // LRU 触碰：删除后重插
    this.map.delete(key);
    this.map.set(key, v);
    this.hits++;
    return v;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  get size(): number {
    return this.map.size;
  }

  stats(): { size: number; hits: number; misses: number } {
    return { size: this.map.size, hits: this.hits, misses: this.misses };
  }

  clear(): void {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

/** 环形缓冲：固定容量、覆盖最旧 */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private cursor = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.items = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    this.items[this.cursor] = item;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** 由新到旧 */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) {
      // 未满时有效元素是 0..count-1（cursor 正好等于 count），不能绕圈取到空槽。
      // 注意这里只能靠索引判断，不能靠 undefined 判断——存 number 时空槽会被填成 0。
      const idx = (this.cursor - 1 - i + this.capacity) % this.capacity;
      if (this.count < this.capacity && idx >= this.count) continue;
      out.push(this.items[idx] as T);
    }
    return out;
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.items.fill(undefined);
    this.cursor = 0;
    this.count = 0;
  }
}

/** 滑动窗口计数器：用于「60s 内同 payload 重复次数」这类无状态化的短窗口统计 */
export class SlidingWindowCounter {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  /** 记录一次发生，返回窗口内累计次数（含本次） */
  hit(key: string, ts = Date.now()): number {
    const arr = this.buckets.get(key) ?? [];
    arr.push(ts);
    const cutoff = ts - this.windowMs;
    while (arr.length > 0 && arr[0]! < cutoff) arr.shift();
    this.buckets.set(key, arr);
    if (this.buckets.size > this.maxKeys) this.evict(ts);
    return arr.length;
  }

  peek(key: string, ts = Date.now()): number {
    const arr = this.buckets.get(key);
    if (!arr) return 0;
    const cutoff = ts - this.windowMs;
    while (arr.length > 0 && arr[0]! < cutoff) arr.shift();
    return arr.length;
  }

  private evict(ts: number): void {
    const cutoff = ts - this.windowMs;
    for (const [k, arr] of this.buckets) {
      if (arr.length === 0 || arr[arr.length - 1]! < cutoff) this.buckets.delete(k);
    }
    // 仍然过大则直接清空最旧的一批
    if (this.buckets.size > this.maxKeys) {
      let dropped = 0;
      for (const k of this.buckets.keys()) {
        this.buckets.delete(k);
        if (++dropped > this.maxKeys / 2) break;
      }
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/* ------------------------------------------------------------------ *
 * 脱敏
 * ------------------------------------------------------------------ */

/** 只保留首尾，中间打码：sk-abcd...wxyz */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 10) return '***';
  return `${secret.slice(0, 6)}...${secret.slice(-4)}`;
}

/** 从可能为 HTML/超长文本的上游错误体里抽出一条可读消息 */
export function condenseErrorText(text: string, maxLen = 600): string {
  if (!text) return '';
  let t = text.trim();
  const parsed = safeJsonParse<Record<string, unknown>>(t);
  if (parsed) {
    const err = parsed['error'];
    if (typeof err === 'string') t = err;
    else if (err && typeof err === 'object') {
      const m = (err as Record<string, unknown>)['message'];
      if (typeof m === 'string') t = m;
    } else if (typeof parsed['message'] === 'string') {
      t = parsed['message'] as string;
    }
  }
  t = t.replace(/<[^>]{0,200}>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
}

export function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 近似 token 估算（无 tokenizer 时的兜底）：中文按 1.5 字符/token，英文按 4 字符/token */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x3000 && code <= 0x9fff) cjk++;
  }
  const rest = text.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 4);
}

/** 估算任意 JSON 值的 token（用于请求体积度量） */
export function estimateJsonTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return estimateTokens(s ?? '');
}

/**
 * 按**字节数**估算 token（用于"上游没回 usage"时的兜底）。
 *
 * ⚠️ 不能用 `estimateJsonTokens(bytes)`：传数字进去它会先 `JSON.stringify`，
 * 于是 `estimateJsonTokens(586000)` 估的是字符串 `"586000"` → **2**，
 * 而真实量级约 14.6 万 —— **少 4 个数量级**。2026-09-14 审计发现（当时是休眠的雷：
 * 四个上游都接受 include_usage 注入，走不到这条兜底；换个上游就会静默白送）。
 *
 * 比例取 **4 字节/token** —— 与本项目实盘测得的 4.05 一致（客户那批 520KB 请求）。
 * 它只是兜底估个量级；真正的账以上游回的 usage 为准。
 */
export function estimateTokensFromBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / 4);
}
