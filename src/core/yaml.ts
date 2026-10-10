/**
 * 极简 YAML 子集解析器（零依赖）。
 *
 * 支持：
 * - 注释 `#`（引号内不算注释，`#` 前必须有空白）
 * - 缩进嵌套 map / `- ` 序列 / 序列内 map
 * - 标量：string / number / boolean / null / `~`
 * - 引号字符串（单双引号，双引号支持 \\n \\t \\" \\\\ 转义）
 * - 行内数组 `[a, b]` 与行内对象 `{a: 1, b: 2}`（作为值、也可整体作为一个序列项 `- {a: 1}`）
 * - 块标量 `|` 与 `>`（含 `|-` `>-`）
 *
 * 不支持（显式报错，避免"以为支持但静默错读"）：锚点/别名、多文档、复杂流式嵌套、
 * 制表符缩进。对本项目的配置面足够，且依赖面为零。
 */

export class YamlError extends Error {
  constructor(message: string, readonly line: number) {
    super(`YAML 解析失败 (line ${line + 1}): ${message}`);
    this.name = 'YamlError';
  }
}

type Scalar = string | number | boolean | null;
type Node = Scalar | Node[] | { [k: string]: Node };

interface Line {
  indent: number;
  text: string;
  raw: string;
  no: number;
}

const TRUE = new Set(['true', 'yes', 'on']);
const FALSE = new Set(['false', 'no', 'off']);
const NULL = new Set(['null', '~', '']);

function stripComment(raw: string): string {
  let inS = false;
  let inD = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD) {
      if (i === 0 || /\s/.test(raw[i - 1]!)) return raw.slice(0, i);
    }
  }
  return raw;
}

function unescapeDouble(s: string, line: number): string {
  return s.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '0':
        return '\0';
      default:
        throw new YamlError(`不支持的转义 \\${ch}`, line);
    }
  });
}

function parseScalar(token: string, line: number): Node {
  const t = token.trim();
  if (t === '') return null;
  const first = t[0]!;
  if (first === '"' || first === "'") {
    if (t.length < 2 || t[t.length - 1] !== first) throw new YamlError(`未闭合的引号: ${t}`, line);
    const inner = t.slice(1, -1);
    return first === '"' ? unescapeDouble(inner, line) : inner.replace(/''/g, "'");
  }
  if (first === '[') return parseInlineArray(t, line);
  if (first === '{') return parseInlineMap(t, line);
  const lower = t.toLowerCase();
  if (NULL.has(lower)) return null;
  if (TRUE.has(lower)) return true;
  if (FALSE.has(lower)) return false;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return t;
}

function splitTopLevel(s: string, sep = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inS = false;
  let inD = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    if (!inS && !inD) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === sep && depth === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
    }
    cur += c;
  }
  if (cur.trim() !== '' || parts.length > 0) parts.push(cur);
  return parts;
}

function parseInlineArray(t: string, line: number): Node[] {
  const inner = t.slice(1, -1).trim();
  if (inner === '') return [];
  return splitTopLevel(inner).map((p) => parseScalar(p, line));
}

function parseInlineMap(t: string, line: number): Record<string, Node> {
  const inner = t.slice(1, -1).trim();
  const out: Record<string, Node> = {};
  if (inner === '') return out;
  for (const part of splitTopLevel(inner)) {
    const idx = findKeySep(part);
    if (idx < 0) throw new YamlError(`行内对象缺少 ':' → ${part}`, line);
    const k = part.slice(0, idx).trim();
    out[unquoteKey(k)] = parseScalar(part.slice(idx + 1), line);
  }
  return out;
}

/**
 * 找到顶层 key 分隔符 ':'。
 * 「顶层」是实打实的：引号内、`[...]`/`{...}` 内、以及 URL 的 '://' 都不算。
 * 少了括号深度这一条，`{ id: c1, ... }` 会在 `id:` 处被切开，
 * 把整个流式对象降级成一个名为 `{ id` 的畸形键（见 ADR-015）。
 */
function findKeySep(s: string): number {
  let inS = false;
  let inD = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (!inS && !inD && (c === '[' || c === '{')) depth++;
    else if (!inS && !inD && (c === ']' || c === '}')) {
      if (depth > 0) depth--;
    } else if (c === ':' && !inS && !inD && depth === 0) {
      const next = s[i + 1];
      if (next === '/' || next === ':') continue;
      return i;
    }
  }
  return -1;
}

function unquoteKey(k: string): string {
  const t = k.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

function tokenize(source: string): Line[] {
  const out: Line[] = [];
  const rawLines = source.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    if (raw.includes('\t')) throw new YamlError('不允许 Tab 缩进，请用空格', i);
    const stripped = stripComment(raw);
    if (stripped.trim() === '') continue;
    const indent = stripped.length - stripped.trimStart().length;
    out.push({ indent, text: stripped.trim(), raw: stripped, no: i });
  }
  return out;
}

export function parseYaml(source: string): Node {
  const lines = tokenize(source);
  if (lines.length === 0) return null;
  const [value, next] = parseBlock(lines, 0, lines[0]!.indent);
  if (next < lines.length) {
    throw new YamlError(`意外的缩进层级：${lines[next]!.text}`, lines[next]!.no);
  }
  return value;
}

function parseBlock(lines: Line[], start: number, indent: number): [Node, number] {
  const first = lines[start]!;
  if (first.text.startsWith('- ') || first.text === '-') return parseSequence(lines, start, indent);
  return parseMapping(lines, start, indent);
}

function parseSequence(lines: Line[], start: number, indent: number): [Node[], number] {
  const out: Node[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError(`序列项缩进异常: ${line.text}`, line.no);
    if (!(line.text === '-' || line.text.startsWith('- '))) break;
    const rest = line.text === '-' ? '' : line.text.slice(2).trim();

    if (rest === '') {
      // 序列项是嵌套块
      const nextLine = lines[i + 1];
      if (!nextLine || nextLine.indent <= indent) {
        out.push(null);
        i++;
        continue;
      }
      const [child, next] = parseBlock(lines, i + 1, nextLine.indent);
      out.push(child);
      i = next;
      continue;
    }

    // 序列项本身就是流式集合（`- {k: v}` / `- [a, b]`）：整项交给 parseScalar。
    // 必须挡在下面的块映射分支之前——否则 `{ id: c1 }` 会被当成 `{ id` 这个键。
    if (rest.startsWith('{') || rest.startsWith('[')) {
      if (!rest.endsWith('}') && !rest.endsWith(']')) {
        throw new YamlError(`行内集合未闭合: ${rest}`, line.no);
      }
      const sibling = lines[i + 1];
      if (sibling && sibling.indent > indent) {
        throw new YamlError(
          `行内集合占满整个序列项，后面不能再跟同一项的其它键: ${sibling.text}`,
          sibling.no,
        );
      }
      out.push(parseScalar(rest, line.no));
      i++;
      continue;
    }

    const sep = findKeySep(rest);
    if (sep >= 0) {
      // 序列项是 map（可能同行还有兄弟键）
      const obj: Record<string, Node> = {};
      const k = unquoteKey(rest.slice(0, sep));
      const vTok = rest.slice(sep + 1).trim();
      if (vTok === '' ) {
        const nextLine = lines[i + 1];
        if (nextLine && nextLine.indent > indent) {
          const [child, next] = parseBlock(lines, i + 1, nextLine.indent);
          obj[k] = child;
          i = next;
        } else {
          obj[k] = null;
          i++;
        }
      } else if (vTok === '|' || vTok === '>' || /^[|>][-+]?$/.test(vTok)) {
        const [child, next] = parseBlockScalar(lines, i, indent, vTok);
        obj[k] = child;
        i = next;
      } else {
        obj[k] = parseScalar(vTok, line.no);
        i++;
      }
      // 合并同一序列项下、缩进大于本项的后续键
      while (i < lines.length && lines[i]!.indent > indent) {
        const l2 = lines[i]!;
        if (l2.text.startsWith('- ') || l2.text === '-') break;
        const s2 = findKeySep(l2.text);
        if (s2 < 0) throw new YamlError(`无法解析键值对: ${l2.text}`, l2.no);
        const k2 = unquoteKey(l2.text.slice(0, s2));
        const v2 = l2.text.slice(s2 + 1).trim();
        if (v2 === '') {
          const nl = lines[i + 1];
          if (nl && nl.indent > l2.indent) {
            const [child, next] = parseBlock(lines, i + 1, nl.indent);
            obj[k2] = child;
            i = next;
          } else {
            obj[k2] = null;
            i++;
          }
        } else if (/^[|>][-+]?$/.test(v2)) {
          const [child, next] = parseBlockScalar(lines, i, l2.indent, v2);
          obj[k2] = child;
          i = next;
        } else {
          obj[k2] = parseScalar(v2, l2.no);
          i++;
        }
      }
      out.push(obj);
      continue;
    }

    out.push(parseScalar(rest, line.no));
    i++;
  }
  return [out, i];
}

function parseMapping(lines: Line[], start: number, indent: number): [Record<string, Node>, number] {
  const out: Record<string, Node> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError(`键缩进异常: ${line.text}`, line.no);
    if (line.text.startsWith('- ') || line.text === '-') break;
    const sep = findKeySep(line.text);
    if (sep < 0) throw new YamlError(`无法解析键值对: ${line.text}`, line.no);
    const key = unquoteKey(line.text.slice(0, sep));
    const valTok = line.text.slice(sep + 1).trim();

    if (valTok === '') {
      const nextLine = lines[i + 1];
      if (nextLine && nextLine.indent > indent) {
        const [child, next] = parseBlock(lines, i + 1, nextLine.indent);
        out[key] = child;
        i = next;
      } else {
        out[key] = null;
        i++;
      }
      continue;
    }
    if (/^[|>][-+]?$/.test(valTok)) {
      const [child, next] = parseBlockScalar(lines, i, indent, valTok);
      out[key] = child;
      i = next;
      continue;
    }
    out[key] = parseScalar(valTok, line.no);
    i++;
  }
  return [out, i];
}

function parseBlockScalar(lines: Line[], headerIdx: number, indent: number, marker: string): [string, number] {
  const headerNo = lines[headerIdx]!.no;
  const rawAll = lines[headerIdx]!.raw;
  const fold = marker.startsWith('>');
  const chomp = marker.includes('-') ? 'strip' : marker.includes('+') ? 'keep' : 'clip';
  const keyIndent = indent;
  void keyIndent;
  const collected: string[] = [];
  let i = headerIdx + 1;
  let blockIndent = -1;
  void rawAll;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent <= indent) break;
    if (blockIndent < 0) blockIndent = line.indent;
    collected.push(line.raw.slice(Math.min(blockIndent, line.indent)));
    i++;
  }
  if (collected.length === 0) return ['', i];
  let value: string;
  if (fold) {
    value = collected.join(' ').replace(/\s+/g, ' ').trim();
  } else {
    value = collected.join('\n');
  }
  if (chomp === 'clip') value = value.replace(/\n+$/, '') + '\n';
  else if (chomp === 'strip') value = value.replace(/\n+$/, '');
  else value = value + '\n';
  void headerNo;
  return [value, i];
}

/* ------------------------------------------------------------------ *
 * 环境变量插值
 * ------------------------------------------------------------------ */

/**
 * 插值语法：
 * - `{ENV:NAME}`        必需，缺失则抛错
 * - `{ENV:NAME:-default}` 可选，缺失用默认值
 */
export function interpolateEnv(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  onMissing?: (name: string) => void,
): string {
  return value.replace(/\{ENV:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => {
    const v = env[name];
    if (v !== undefined && v !== '') return v;
    if (def !== undefined) return def;
    if (onMissing) {
      onMissing(name);
      return `__MISSING_ENV_${name}__`;
    }
    throw new Error(`环境变量 ${name} 未设置（配置中引用了 {ENV:${name}}）`);
  });
}

/** 递归对对象内所有字符串做环境变量插值 */
export function interpolateTree<T>(
  value: T,
  env: NodeJS.ProcessEnv = process.env,
  onMissing?: (name: string) => void,
): T {
  if (typeof value === 'string') return interpolateEnv(value, env, onMissing) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => interpolateTree(v, env, onMissing)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = interpolateTree(v, env, onMissing);
    return out as T;
  }
  return value;
}
