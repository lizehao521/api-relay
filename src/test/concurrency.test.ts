/** 并发限流器：释放一个额度只能唤醒一个等待者（审计 P2-8，对冲会放大该缺陷）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyLimiter } from '../upstream/pool.js';

test('limiter: 释放一个额度不超发（active 不越过 limit）', async () => {
  const lim = new ConcurrencyLimiter(2);
  const r1 = await lim.acquire();
  const r2 = await lim.acquire();
  const p3 = lim.acquire();
  const p4 = lim.acquire();
  const p5 = lim.acquire();
  assert.equal(lim.active, 2);
  assert.equal(lim.waiting, 3);
  r1(); // 释放一个：只应唤醒一个等待者
  assert.equal(lim.active, 2, '释放一个后 active 仍应为 2（不能超发）');
  assert.equal(lim.waiting, 2, '只应唤醒一个等待者');
  r2();
  const r3 = await p3;
  assert.equal(lim.active, 2);
  assert.equal(lim.waiting, 1);
  r3();
  const r4 = await p4;
  r4();
  const r5 = await p5;
  r5();
  assert.equal(lim.active, 0);
  assert.equal(lim.waiting, 0);
});
