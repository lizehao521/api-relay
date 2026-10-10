/**
 * 内部 Agent handler（P2 拆分第四层，第二刀）。
 *
 * 从 AdminApi 切出：Agent 状态视图 / 手动触发 / 子路由分发（last、runs）。
 * 依赖三个：agent / store / logger。
 *
 * 这里有个真实收益：`lastFromEvent` 的重启回退逻辑（内存 ring 空时用持久
 * agent.decision 事件重建）只被本组内部消费，切出后不必再暴露在 AdminApi 上。
 */

import type { ServerResponse } from 'node:http';
import type { Store } from '../../store/index.js';
import type { Logger } from '../../core/logger.js';
import { AgentRunner } from '../../agent/runner.js';
import { json } from '../response.js';
import { numParam } from '../params.js';

/**
 * Agent handler 的最小依赖集。
 *
 * ⚠️ `agent` 必须是**取值函数**而不是值：app.ts 的构造顺序是
 *   ① new AdminApi()（此时 agent 尚未创建）→ ② new AgentRunner() → ③ 回填 deps.agent
 * 若在这里按值捕获，拿到的是构造那一刻的 undefined，回填永远看不到——
 * Agent 会在配置 enabled:true 的情况下静默显示「未启用」（本层拆分时实际踩到）。
 * 用 getter 把「agent 可能晚于本 handler 构建」这个约束写进类型，杜绝复发。
 */
export interface AgentHandlerDeps {
  store: Store;
  logger: Logger;
  /** 惰性取值：undefined = 未启用 */
  agent: () => AgentRunner | undefined;
}

export class AgentHandlers {
  constructor(private readonly deps: AgentHandlerDeps) {}

  view(): Record<string, unknown> {
    const agent = this.deps.agent();
    if (!agent || !agent.enabled) {
      return { enabled: false, note: '内部 Agent 系统未启用（config.agent.enabled 为 false）' };
    }
    const status = agent.status();
    // 重启回退（manual#255，#183 模式）：/agent 与 /agent/last、/agent/runs 同款——
    // 内存 ring 空时用持久 agent.decision 事件重建（status.lastRun 与 runs 都补，
    // 否则 ov 页能力区的『Agent 最新』和 Agent 页的 runs 列表重启后全是空的）。
    // 惰性化（manual#340 复测，#330 模式第四处）：此前无条件调 lastFromEvent()——
    // 它 listEvents(500) 全量事件扫描，而结果只在回落分支（runs 空或 lastRun 空）被消费；
    // 稳态下每请求白扫 500 条事件（实测 /agent 6.6ms 的大头）。需要才扫。
    const runs = agent.runs();
    const lastMem = agent.lastRun();
    const rebuilt = (runs.length === 0 || !lastMem) ? this.lastFromEvent() : undefined;
    const list = runs.length ? runs : (rebuilt ? [rebuilt] : []);
    return {
      enabled: true,
      status: { ...status, lastRun: lastMem ?? rebuilt ?? null },
      // manual#353：视图 runs 只保留最新一轮——本字段的全体消费者只有 ov 页班次摘要的
      // runs[0]（Agent 页决策历史走 /agent/runs?limit=N 专用端点按需拉取），此前
      // slice(0,20) 让视图载荷随内存 ring 线性增长：每轮决策 ~1.2KB compact，20 轮
      // ≈ 25KB compact/43KB wire；实测 2 轮即 6.3KB 撞 5KB 体积天花板（#353 矩阵抓到）。
      // 最新一轮（+status.lastRun）已覆盖全部消费点，完整历史按 limit 拉取——视图做摘要，
      // 不做档案馆。若未来 ov 页真要展示多轮，应给 /agent/runs 加聚合参数而非回退这里。
      runs: list.slice(0, 1),
    };
  }

  trigger(res: ServerResponse, _body: Record<string, unknown> | undefined, actor?: string): boolean {
    const agent = this.deps.agent();
    if (!agent || !agent.enabled) {
      return json(res, 503, { error: { message: 'Agent 系统未启用', type: 'agent_disabled', code: 'agent_disabled' } });
    }
    if (agent.isRunning) {
      return json(res, 409, { error: { message: 'Agent 上一轮仍在运行', type: 'conflict_error', code: 'agent_running' } });
    }
    void agent.run('manual').then((run) => {
      this.deps.store.logEvent('info', 'agent.manual_trigger', { actor, ok: run.ok, kind: run.decision.kind });
    }).catch((e) => {
      this.deps.logger.error('agent.manual_trigger_failed', { error: String(e), actor });
    });
    return json(res, 202, { ok: true, note: '已触发，稍后查 agent 状态/events 看结果', actor });
  }

  /**
   * 从持久事件库重建最近一轮 Agent 运行（manual#255，#183 模式）。
   *
   * 场景：agent 的 history ring 是**进程内**的——网关重启后 runs/lastRun 全空，
   * Agent 页显示『尚无运行记录』、agent/last 返 404，但事件库（SQLite）里
   * 重启前的 agent.decision 都在（#99 的 trace 回退、#183 的教训同款）。
   * 这里把最近一条 agent.decision 事件重建成 run 形状（字段对齐 GUI renderRun），
   * 带 fromEvent 标记供 GUI 标注『重启前·来自事件记录』。
   */
  lastFromEvent(): Record<string, unknown> | undefined {
    // 窗口 500（manual#276）：此前 50——KB 刷新每轮产生 2-3 条事件（kb.update+doc_replace），
    // 实测重启后累积 58 条就把 agent.decision 挤出窗口，回退失效（runs 空+last 404）。
    // 与 #258 的 KB 检索窗口同族：按最坏分布定，且 500 与 events 端点的帽一致。
    const ev = (this.deps.store.listEvents(500) as { kind?: string; ts?: number; detail?: Record<string, unknown> }[])
      .find((e) => e.kind === 'agent.decision');
    if (!ev) return undefined;
    const d = ev.detail ?? {};
    const ev2 = Array.isArray(d['evidence']) ? (d['evidence'] as unknown[]).map((x) => String(x)) : [];
    return {
      startedAt: Number(ev.ts ?? 0),
      trigger: String(d['trigger'] ?? 'auto'),
      durationMs: 0,
      model: '',
      promptTokens: 0,
      completionTokens: 0,
      decision: {
        kind: String(d['kind'] ?? 'ops'),
        summary: String(d['summary'] ?? ''),
        confidence: typeof d['confidence'] === 'number' ? d['confidence'] : null,
        evidence: ev2,
        ok: d['ok'] !== false,
      },
      fromEvent: true,
    };
  }

  route(method: string, action: string, url: URL, _body: Record<string, unknown> | undefined, res: ServerResponse, actor?: string): boolean {
    const agent = this.deps.agent();
    if (!agent || !agent.enabled) {
      return json(res, 503, { error: { message: 'Agent 系统未启用', type: 'agent_disabled', code: 'agent_disabled' } });
    }
    const parts = action.split('/'); // [agent, sub...]
    const sub = parts.slice(1).join('/');
    if (method === 'GET' && (sub === '' || sub === 'runs')) {
      const runs = agent.runs();
      // 重启回退（manual#255，#183 模式）：内存 ring 重启即空——runs 全空时把持久事件
      // 重建的那轮补在头部，Agent 页不再是一片『尚无运行记录』。
      // 惰性化（manual#340 复测，#330 模式第四处·同 /agent）：rebuilt 只在 runs 空时被
      // 消费，稳态每请求白扫 listEvents(500)——需要才扫。
      const rebuilt = runs.length === 0 ? this.lastFromEvent() : undefined;
      const list = runs.length ? runs : (rebuilt ? [rebuilt] : []);
      return json(res, 200, { status: agent.status(), runs: list.slice(0, numParam(url, 'limit', 20, 1, 200)) });
    }
    if (method === 'GET' && sub === 'last') {
      const last = agent.lastRun() ?? this.lastFromEvent();
      return json(res, last ? 200 : 404, last ? { last } : { error: { message: '尚无 Agent 运行记录', type: 'not_found_error', code: 'not_found' } });
    }
    return json(res, 404, { error: { message: `未知 Agent 子路由 ${method} agent/${sub}`, type: 'not_found_error', code: 'not_found' } });
  }
}
