/** 零依赖结构化日志：JSON Lines 到 stdout/stderr，可直接接 Loki/ELK。 */


export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  [key: string]: unknown;
}

export class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = 'info', private readonly sink: (line: string) => void = defaultSink) {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  child(base: LogFields): Logger {
    const parent = this;
    const child = new Logger(this.level, this.sink);
    child.base = { ...this.base, ...base };
    child.parent = parent;
    // 子 logger 的级别跟随父级（便于运行时调整）
    Object.defineProperty(child, 'level', {
      get: () => parent.level,
      set: (v: LogLevel) => {
        parent.level = v;
      },
    });
    return child;
  }

  private base: LogFields = {};
  private parent?: Logger;

  debug(msg: string, fields?: LogFields): void {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.write('error', msg, fields);
  }

  private write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.base,
      // r22：脱敏在此接线（此前 redact() 是死代码，而两处文档都承诺过它）。
      // 只掩**真的是秘密**的字段名（apiKey/secret/token/...），
      // keyId/keyLength/kbId 等标识符不掩 —— 否则管理日志失去关联能力。
      ...(fields !== undefined ? redact(fields) : {}),
    };
    try {
      this.sink(JSON.stringify(record));
    } catch {
      // 日志绝不能拖垮主流程（fail-open）
      this.sink(JSON.stringify({ ts: record.ts, level, msg, logError: 'serialize_failed' }));
    }
  }
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * 敏感字段脱敏，避免日志泄露 key。
 *
 * 为何重写（r22，死代码扫描的收获）：这个函数**从未被调用过** ——
 * 而 docs/DEPLOYMENT.md 与 docs/ARCHITECTURE.md 两处都写着「日志经 redact() 脱敏」
 * 「敏感字段自动脱敏」。实测 Logger.write() 原样输出，`logger.info('x',{apiKey:'sk-...'})`
 * 会把明文写进日志。即：文档承诺了一道不存在的控制（与 r19 的 clientIp / trustProxy
 * 同一族失真）。现在把它接进 Logger.write()，让承诺成真。
 *
 * 重写时避开两个坑：
 *   ① 旧正则 `/key|token|.../i` 会把 **keyId** 也匹配上（含子串 key），
 *      打成 `***` —— 而 keyId 是管理日志的唯一关联字段，脱敏它等于毁掉可追溯性。
 *      现在只有 `apiKey`/`key`（整名）/`secret`/`token`/`password`/`authorization`/
 *      `credential`/`bearer` 这类**真的是秘密**的才掩，keyId/keyLength/kbId 等标识符不掩。
 *   ② 旧版只扫一层，`{ nested: { apiKey } }` 原样穿透（实测泄漏）。现在递归。
 *
 * 顺带去掉旧版的「>2000 字符截断」：那是另一条策略（日志体量控制），从未生效过，
 * 混在脱敏里会让将来的接线悄悄改变错误文案的完整性 —— 要截断应单独一个开关。
 */
export function redact(fields: LogFields): LogFields {
  const mask = (v: string): string => (v.length > 10 ? `${v.slice(0, 6)}...${v.slice(-4)}` : '***');
  // 递归要走**值**而不只是对象的字段：`{ arr: [{ secret }] }` 里秘密藏在数组元素中，
  // 只 walk 对象层会整块穿透（回归测试实测抓到过这个缺口）。
  const walkValue = (v: unknown, keyName: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walkValue(x, keyName));
    if (v && typeof v === 'object') return walk(v as LogFields);
    if (typeof v === 'string' && isSensitiveField(keyName)) return mask(v);
    return v;
  };
  const walk = (src: LogFields): LogFields => {
    const out: LogFields = {};
    for (const [k, v] of Object.entries(src)) out[k] = walkValue(v, k);
    return out;
  };
  return walk(fields);
}

/** 字段名是否是秘密（注意别把 keyId/keyLength/kbId 这类标识符算进来） */
function isSensitiveField(name: string): boolean {
  return /(api[-_]?key|secret|token|password|authorization|credential|bearer)/i.test(name)
    || name.toLowerCase() === 'key';
}
