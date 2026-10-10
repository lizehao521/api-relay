/**
 * 引擎 ↔ HTTP 的协议契约（与传输实现解耦，便于单测直接驱动引擎）。
 */

export type EngineErrorCode =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'request_too_large'
  | 'rate_limit_error'
  | 'insufficient_quota'
  | 'upstream_error'
  | 'upstream_timeout'
  | 'relay_internal_error'
  | 'model_not_found';

/** 非流式响应 */
export interface EngineJson {
  kind: 'json';
  status: number;
  /** 响应体：字符串表示原样字节透传（成功路径），或已构造好的 JSON */
  body: string;
  headers: Record<string, string>;
  usage?: import('../core/types.js').UsageBreakdown;
}

/** 流式响应：上游 SSE 字节原样转发 */
export interface EngineStream {
  kind: 'stream';
  status: number;
  headers: Record<string, string>;
  stream: ReadableStream<Uint8Array>;
  ttfbMs: number;
  /**
   * 转发截止时刻（ms 时间戳，请求起点 + upstreamTimeoutMs）。
   *
   * 2026-09-14 审计 D-P0-2：upstreamTimeoutMs 此前从未真正 arm —— 首块之后没有
   * 任何看门狗，上游"头之后慢慢流"就能无限期挂住。server 的转发循环到点必须截断
   * 并记 aborted，否则"单次请求总上限"就只是面板上的一句假话。
   */
  deadlineAt?: number;
  /**
   * 流结束时回调（写入度量与轨迹）。
   *
   * 返回 Promise：流式记账要等旁路那一支把 transcript 解析完，
   * 调用方**应当 await**（否则拿不到 usage，token 记成 0）。
   */
  onEnd: (info: { bytes: number; aborted: boolean; transcriptChars: number }) => void | Promise<void>;
}

export type EngineResult = EngineJson | EngineStream;

/** 严格 JSON 的 OpenAI 错误体形状（我们对外承诺的兼容面） */
export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
    relay_attribution?: {
      failure_reason: string;
      suggested_next: { action: string; retryAfterMs?: number; autoPerformed?: boolean };
      recoverable: boolean;
      upstream: string;
      confidence: number;
      evidence?: string[];
    };
    relay_details?: Record<string, unknown>;
  };
}
