// 前端新鲜度校验（CI 用）。
// 抓「改了 src/admin/dashboard.ts 的 APP_SRC 却忘了 node src/admin/gen-app-min.mjs」的过期。
// 2026-10-10 实测：发生过一次，min 比源码早 4 天，压缩收益静默失效数月才发现。
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const dash = await import(pathToFileURL(join(root, 'dist', 'admin', 'dashboard.js')).href);
const min = await import(pathToFileURL(join(root, 'dist', 'admin', 'dashboard-app-min.js')).href);

const APP_SRC = dash.APP_SRC;
if (typeof APP_SRC !== 'string' || APP_SRC.length < 10000) {
  console.error('FAIL: dist/admin/dashboard.js 未导出有效 APP_SRC（CI 要先 npm run build）');
  process.exit(1);
}
const srcSha = createHash('sha256').update(APP_SRC, 'utf8').digest('hex');
const recordedSha = min.DASHBOARD_APP_SHA;
if (srcSha !== recordedSha) {
  console.error('FAIL: dashboard-app-min.ts 过期（与当前 APP_SRC 的 sha256 不匹配）');
  console.error('  src   : ' + srcSha);
  console.error('  min   : ' + recordedSha);
  console.error('  => 跑 `npm run build && node src/admin/gen-app-min.mjs` 重新生成，再提交。');
  console.error('  （不匹配时 appJs() 会 fail-open 回落源码，页面仍正确但 -37% 压缩收益失效）');
  process.exit(1);
}
console.log('OK: 前端 min 产物与源码新鲜度一致 (sha256=' + srcSha.slice(0, 16) + '...)');
