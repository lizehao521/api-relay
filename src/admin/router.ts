/**
 * 管理面路由表（AdminApi 拆分的第三层）。
 *
 * 把 `handle` 里 421 行的 switch 拆成两部分：
 *   - **路由决策**（本文件）：`METHOD action` → handler 的映射，是**声明式数据**
 *   - **业务 handler**：仍在 AdminApi 上（它们读 this.deps 的多个服务，符合判据③）
 *
 * 为什么值得拆：路由表变成可审计的数据 —— 「文档列出的端点是否都注册了」
 * 「有没有重复/冲突的路由」这类问题，从读 420 行 switch 变成读一张表。
 * 而且路由解析（resolveRoute）可以脱离 AdminApi 单独单测。
 *
 * handler 用箭头函数闭包捕获 this，因此**不需要**把 deps/state 传来传去 ——
 * 这是本层能成立的关键：路由表是数据，但 handler 的 this 绑定在构建时就固定了。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** 路由处理器的入参。handle 的前置逻辑（鉴权/解析 body/审计身份）算好后传进来。 */
export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: Record<string, unknown> | undefined;
  /** 审计身份（manual#179：不可逆运营动作要能查出来是谁） */
  actor: string;
}

/** 返回 true 表示「已处理」，调用方据此短路。 */
export type RouteHandler = (ctx: RouteContext) => boolean;

export interface Route {
  method: string;
  action: string;
  handler: RouteHandler;
}

/** 精确匹配 `METHOD action`。大小写敏感（与 switch 语义一致）。 */
export function resolveRoute(routes: readonly Route[], method: string, action: string): Route | undefined {
  return routes.find((r) => r.method === method && r.action === action);
}
