import { rmSync } from 'node:fs';

/**
 * 异步删除临时目录：遇到 Windows 上 SQLite 句柄未释放导致的 EBUSY/ENOTEMPTY 时重试。
 * Node 22.5.0 的 rmSync 内部 rimraf 不重试 EBUSY 会直接抛；Windows 上 close() 后锁释放有延迟，
 * 先用 setTimeout 等一会儿再删。Linux/macOS 上 unlink 打开的文件不会 EBUSY，通常秒过。
 */
export async function rmTmp(dir: string, attempts = 150, waitMs = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e: any) {
      if ((e.code === 'EBUSY' || e.code === 'ENOTEMPTY') && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }
}
