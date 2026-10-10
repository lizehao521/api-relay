/**
 * AgentContextProvider：把网关运营数据打包成 LLM 可读的快照。
 * 不依赖 HTTP，直接读 admin 的同源数据（pool snapshot / store events / meter），
 * 这样 Agent 巡检不受 admin 鉴权影响，也方便单测。
 */

import type { AgentContextProvider, AgentOpsSnapshot } from './runner.js';
import type { ProviderPool } from '../upstream/pool.js';
import type { Store } from '../store/index.js';
import type { KbStore } from '../kb/store.js';
import type { Meter } from '../loss/meter.js';

export interface AgentContextDeps {
  pool: ProviderPool;
  store: Store;
  meter: Meter;
  kb?: KbStore | undefined;
  recentEvents?: number;
}

export function createAgentContext(deps: AgentContextDeps): AgentContextProvider {
  const limit = deps.recentEvents ?? 30;
  return {
    async collect(): Promise<AgentOpsSnapshot> {
      const windowMs = 86_400_000; // 24h
      const overview: Record<string, unknown> = {
        uptime_s: Math.round(process.uptime()),
        window24h: deps.meter.summarize(windowMs),
      };
      const providers = deps.pool.snapshot().map((p) => ({
        id: p.id,
        label: p.label,
        disabled: p.disabled,
        breakerOpen: p.health.openUntil > Date.now(),
        totalRequests: p.health.totalRequests,
        totalFailures: p.health.totalFailures,
        consecutiveFailures: p.health.consecutiveFailures,
      }));
      const recentEvents = deps.store.listEvents(limit).map((e) => ({
        ts: e['ts'],
        level: e['level'],
        kind: e['kind'],
        detail: e['detail'],
      }));
      return { overview, providers, recentEvents, kbHits: [] };
    },
  };
}
