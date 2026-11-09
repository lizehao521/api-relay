/** 套餐目录：配置优先，未配置时给一套可直接演示的示例包。 */

import type { BusinessConfig, PackConfig } from '../core/types.js';

export const DEFAULT_PACKS: PackConfig[] = [
  {
    id: 'chat-100',
    name: '标准对话 100 次',
    uses: 100,
    priceCny: 9.9,
    models: ['mock-small'],
    validDays: 90,
    description: '顾客扫码即用，含 AI 对话',
  },
  {
    id: 'chat-500',
    name: '标准对话 500 次',
    uses: 500,
    priceCny: 39.9,
    models: ['mock-small'],
    validDays: 180,
    description: '适合桌贴长期使用，单次更便宜',
  },
  {
    id: 'image-20',
    name: 'AI 画图 20 张',
    uses: 20,
    priceCny: 19.9,
    models: ['mock-image'],
    validDays: 90,
    description: '顾客扫码生成图片，每张计 1 次',
  },
];

export function resolvePacks(business: BusinessConfig): PackConfig[] {
  return business.packs.length > 0 ? business.packs : DEFAULT_PACKS;
}

export function findPack(packs: PackConfig[], id: string): PackConfig | undefined {
  return packs.find((p) => p.id === id);
}

export function packPrice(pack: PackConfig, quantity: number): number {
  return Math.round(pack.priceCny * quantity * 100) / 100;
}
