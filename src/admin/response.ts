/**
 * 管理面 HTTP 响应助手。
 *
 * 从 AdminApi 抽出的第一层（P2 God Class 拆分）。抽它的理由：
 * 这五个函数**只依赖入参、不依赖 this**——是纯函数，抽出去零风险，
 * 却能让 AdminApi 瘦掉一层「怎么写响应」的重复样板
 * （全站 137 处调用，每处都要重复 secHeaders + content-type + cache-control + writeHead）。
 *
 * 抽出的判据（本轮确立，后续各层沿用）：
 *   ① 不读 this.* → 可直接抽成模块级函数；
 *   ② 读 this.* 但只读一个明确依赖 → 抽成「依赖注入」的类；
 *   ③ 读 this.deps 的多个服务 → 留在 AdminApi，靠组合而非继承复用。
 */

import type { ServerResponse } from 'node:http';

/** 安全响应头（管理面统一：禁嗅探 / 禁嵌套 / 禁引用来源） */
export function secHeaders(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
}

/** JSON 响应。返回 true 表示「已处理」，调用方据此短路。 */
export function json(res: ServerResponse, status: number, payload: unknown): boolean {
  secHeaders(res);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.writeHead(status);
  // PERF-007 修复：紧凑格式（无缩进），减少 ~15% 体积。管理面是内网 API，不需要可读性。
  res.end(JSON.stringify(payload));
  return true;
}

/** 纯文本响应（健康检查/探测类客户端用） */
export function text(res: ServerResponse, status: number, payload: string): boolean {
  secHeaders(res);
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.writeHead(status);
  res.end(payload);
  return true;
}

/**
 * 400 坏请求。
 * type 三件套（manual#194）：此前只设 {message, code}，而 401/413 等路径带 type——
 * 错误对象形状全站统一 {message, type, code}，外部消费者按 type 分流不再拿到 undefined。
 */
export function badRequest(res: ServerResponse, message: string): boolean {
  return json(res, 400, { error: { message, type: 'invalid_request_error', code: 'invalid_request_error' } });
}

/**
 * 按错误消息内容分流 404 / 400。
 * 消息含「不存在」→ 404 not_found，否则 400 invalid_request。
 * 返回值语义与 json 一致（true = 已处理）。
 */
export function notFoundOrBad(res: ServerResponse, err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const notFound = message.includes('不存在');
  return json(res, notFound ? 404 : 400, {
    error: { message, type: notFound ? 'not_found_error' : 'invalid_request_error', code: notFound ? 'not_found' : 'invalid_request_error' },
  });
}
