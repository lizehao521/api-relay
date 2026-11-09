/** 二维码 SVG：不依赖 canvas / 图片库，商家打印和屏幕展示共用同一份输出。 */

import { qrcodegen } from './vendor/qrcodegen.js';

export function qrSvg(text: string, opts: { border?: number } = {}): string {
  const border = opts.border ?? 4;
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const dim = qr.size + border * 2;
  let path = '';
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.getModule(x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < qr.size && qr.getModule(x, y)) x++;
      path += `M${start + border} ${y + border}h${x - start}v1h-${x - start}z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim * 8}" height="${dim * 8}" shape-rendering="crispEdges" role="img" aria-label="二维码">` +
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/>` +
    '</svg>'
  );
}

/** 给测试/调试用：返回模块矩阵（true = 黑块） */
export function qrMatrix(text: string): { size: number; modules: boolean[][] } {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const modules: boolean[][] = [];
  for (let y = 0; y < qr.size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < qr.size; x++) row.push(qr.getModule(x, y));
    modules.push(row);
  }
  return { size: qr.size, modules };
}
