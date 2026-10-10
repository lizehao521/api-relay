/**
 * manual#394：APP_SRC → minify 生成器（签字层授权④ HTML minify 的配套工具）。
 * 用法（改过 dashboard.ts 的 APP_SRC 之后）：
 *   node src/admin/gen-app-min.mjs && npm run build
 * 机理：从 dist 读 APP_SRC（唯一定义处）→ esbuild minify（charset utf8 保中文字符量，
 * 矩阵字符串标记逐字节存活的前提）→ JSON.stringify 安全注入模板 → 记录源码 sha256
 * （appJs() 的新鲜度校验用；不等即回落源码，永不服务过期页面）。
 * 注意 esbuild 目前是传递依赖——若哪天不在 node_modules，本脚本报错即提醒，
 * 页面行为退回回落模式（大页面但正确），不会白屏。
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = join(here, '..', '..');

// dist 的 dashboard.js 导出 APP_SRC（源码真源）
// Windows 上裸绝对路径（C:\...）会被 ESM loader 拒绝，必须走 file:// URL（跨平台同样合法）
const mod = await import(pathToFileURL(join(root, 'dist', 'admin', 'dashboard.js')).href);
const APP_SRC = mod.APP_SRC;
if (typeof APP_SRC !== 'string' || APP_SRC.length < 10000) {
  console.error('FAIL: dist/admin/dashboard.js 未导出有效 APP_SRC（先 npm run build）');
  process.exit(1);
}
const sha = createHash('sha256').update(APP_SRC, 'utf8').digest('hex');

let esbuild;
try {
  esbuild = require(join(root, 'node_modules', 'esbuild')); // CJS require 接受裸路径，无需转换
} catch {
  console.error('FAIL: esbuild 不可用（传递依赖消失？）——min 未生成，页面回落源码模式（正确但大）');
  process.exit(1);
}
const min = esbuild.transformSync(APP_SRC, { minify: true, target: 'es2020', charset: 'utf8' }).code;

const out = `// manual#394 生成文件（src/admin/gen-app-min.mjs 产出，勿手改）
// src sha256=${sha}
export const DASHBOARD_APP_SHA = '${sha}';
export const DASHBOARD_APP_MIN = ${JSON.stringify(min)};
`;
writeFileSync(join(here, 'dashboard-app-min.ts'), out);
const zlib = await import('node:zlib');
const gz = (b) => zlib.gzipSync(Buffer.from(b, 'utf8')).length;
console.log('min 已生成: APP_SRC %d B (gzip %d) → min %d B (gzip %d, -%.0f%%)',
  APP_SRC.length, gz(APP_SRC), min.length, gz(min), 100 * (1 - gz(min) / gz(APP_SRC)));
console.log('sha256=%s（appJs 新鲜度校验用）', sha.slice(0, 16));
