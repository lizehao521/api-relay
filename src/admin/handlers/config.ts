/**
 * 配置与目录视图（P2 拆分第四层第四刀）。
 *
 * 四个方法都是**只读**，且都不读 this.*：
 *   - configView 读 deps.config
 *   - modelList 读 deps.router + deps.keys（经 allowedModelsFor）
 *   - attributionCatalog 是纯静态数据
 * 按抽层判据①（不读 this.* → 模块级纯函数 / 依赖注入类），它们本就不该留在 AdminApi 里。
 *
 * allowedModelsFor 是 modelList 的私有辅助，跟着一起搬。
 *
 * deps 只给这三个，不给整个 AdminDeps。
 */
import { extractBearer } from '../../gateway/keys.js';
import { maskSecret } from '../params.js';
import type { RelayConfig } from '../../core/types.js';
import type { Router } from '../../upstream/pool.js';
import type { KeyRegistry } from '../../gateway/keys.js';

export interface ConfigHandlerDeps {
  config: RelayConfig;
  router: Router;
  keys: KeyRegistry;
}

export class ConfigHandlers {
  constructor(private readonly deps: ConfigHandlerDeps) {}

  view(): Record<string, unknown> {
    const c = this.deps.config;
    return {
      sourcePath: c.sourcePath,
      // 超时/阈值必须一起给面板：2026-09-14 两次踩坑（TTFB 30s 误杀、maxMessages 512 误杀）
      // 都卡在"面板上看不到生效值，只能去翻配置文件"。这里逐字段列出，
      // **绝不含 adminToken**（只给 adminTokenSet 布尔）。
      server: {
        host: c.server.host,
        port: c.server.port,
        trustProxy: c.server.trustProxy,
        adminTokenSet: !!c.server.adminToken,
        maxBodyBytes: c.server.maxBodyBytes,
        upstreamTimeoutMs: c.server.upstreamTimeoutMs,
        upstreamTtfbTimeoutMs: c.server.upstreamTtfbTimeoutMs,
        upstreamStallTimeoutMs: c.server.upstreamStallTimeoutMs,
        shutdownGraceMs: c.server.shutdownGraceMs,
        publicQuota: c.server.publicQuota,
        publicQuotaRemote: c.server.publicQuotaRemote,
      },
      storage: c.storage,
      logLevel: c.logLevel,
      tiers: c.tiers,
      lossReduction: c.lossReduction,
      providers: c.providers.map((p) => ({
        ...p,
        apiKey: maskSecret(p.apiKey),
        // apiKeys 是**多 key 池**（轮换用），同样必须掩码。此前只掩了 apiKey，
        // `{...p}` 展开会把 apiKeys 原样带出 /config（潜伏泄漏）。
        ...(p.apiKeys ? { apiKeys: p.apiKeys.map(maskSecret) } : {}),
      })),
      clients: c.clients.map((k) => ({ ...k, key: maskSecret(k.key) })),
      modelAliases: c.modelAliases,
      // 档位阶梯（manual#265）：GUI 的『模型别名』行此前读 modelAliases（旧机制，恒空）——
      // 真正的 ladder 数据（7 个中文阶梯）从没暴露过，ops 页一直显示『无』而路由在用。
      modelLadders: c.modelLadders ?? {},
    };
  }

  /**
   * 对外 `GET /v1/models` 的模型清单。
   *
   * 带上有效 key 时**按该 key 的白名单过滤**。不过滤的后果实测过：客户拿 Agnes 的 key
   * 看到 `mimo-*`，以为可以用，选了就被 403 挡回 —— 看起来像"key 坏了"，
   * 而实际上是清单在说谎。清单只说这个 key 能用的东西。
   *
   * 未带 key / key 无效 / 白名单为空（= 不限）时返回全部：仍有客户端不带 key 探测，
   * 这条路径保持原样，免得把兼容性一起改掉。
   */
  modelList(authorization?: string): { id: string; object: string; created: number; owned_by: string }[] {
    const now = Math.floor(Date.now() / 1000);
    const reach = this.deps.router.reachability();
    const providersByModel = new Map(reach.map((r) => [r.model, r.providers]));
    // 对外列的是**此刻能服务**的模型，不是全部认识的名字
    const catalog = this.deps.router.availableCatalog();
    const allowed = this.allowedModelsFor(authorization);
    const ids = allowed ? catalog.filter((id) => allowed.includes(id)) : catalog;
    return ids.map((id) => ({
      id,
      object: 'model',
      created: now,
      owned_by: `relay:${(providersByModel.get(id) ?? ['unknown']).join(',')}`,
    }));
  }

  /** 从 Authorization 头解析该 key 的模型白名单；未带 / 无效 / 不限 → undefined */
  private allowedModelsFor(authorization?: string): string[] | undefined {
    const token = extractBearer(authorization);
    if (!token) return undefined;
    const r = this.deps.keys.resolveSecret(token);
    if (!r.found || r.status !== 'ok') return undefined;
    const allowed = r.key?.allowedModels;
    return Array.isArray(allowed) && allowed.length > 0 ? allowed : undefined;
  }

  attributionCatalog(): Record<string, unknown> {
    return {
      version: 1,
      description:
        '中转站的失败归因目录：任何非 2xx 响应都会附带 relay_attribution（或在仅 header 模式下的 X-Relay-Attribution）。客户端可据此自动决策，不必解析上游错误文本。',
      delivery: {
        full: '错误体 error.relay_attribution 字段（Pro 层默认）',
        header: 'X-Relay-Attribution 响应头（标准层默认）',
        off: '不投递（免费层默认，保持纯管道语义）',
      },
      full_error_body_example: {
        error: {
          message: '上游原文……',
          type: 'rate_limit_error',
          param: null,
          code: 'rate_limited',
          relay_attribution: {
            failure_reason: 'rate_limited',
            suggested_next: { action: 'retry_with_backoff', retryAfterMs: 2400 },
            recoverable: true,
            upstream: 'deepseek',
            confidence: 0.9,
          },
        },
      },
      failure_reasons: [
        { reason: 'rate_limited', recoverable: true, action: 'retry_with_backoff', 中文: '上游限流' },
        { reason: 'quota_exhausted', recoverable: false, action: 'top_up_balance', 中文: '上游余额/配额不足' },
        { reason: 'auth_invalid', recoverable: false, action: 'fix_credentials', 中文: '上游密钥无效' },
        { reason: 'permission_denied', recoverable: false, action: 'fix_credentials', 中文: '上游权限/风控' },
        { reason: 'model_not_found', recoverable: true, action: 'switch_model', 中文: '模型不存在' },
        { reason: 'model_overloaded', recoverable: true, action: 'retry_with_backoff', 中文: '模型过载' },
        { reason: 'upstream_timeout', recoverable: true, action: 'retry_with_backoff', 中文: '上游超时' },
        { reason: 'upstream_unavailable', recoverable: true, action: 'retry_with_backoff', 中文: '上游 5xx' },
        { reason: 'network_error', recoverable: true, action: 'retry_with_backoff', 中文: '链路失败' },
        { reason: 'context_length_exceeded', recoverable: true, action: 'reduce_context', 中文: '上下文超限' },
        { reason: 'content_filtered', recoverable: false, action: 'rewrite_input', 中文: '内容安全拦截' },
        { reason: 'invalid_request', recoverable: false, action: 'fix_request', 中文: '请求格式非法' },
        { reason: 'tool_call_invalid', recoverable: false, action: 'fix_request', 中文: 'tool_calls 结构非法' },
        { reason: 'stream_interrupted', recoverable: true, action: 'retry_same', 中文: '流被中断' },
        { reason: 'client_aborted', recoverable: false, action: 'abort', 中文: '客户端自己断开（不是上游故障，不计入熔断）' },
        { reason: 'relay_internal_error', recoverable: true, action: 'retry_same', 中文: '中转站内部错误' },
        { reason: 'unknown', recoverable: true, action: 'retry_same', 中文: '无法归因（原样透传）' },
      ],
      precheck: {
        description: '预检拦截（HTTP 400）时 error.code 为具体违规码，error.relay_details.violations 给出每条违规的 pointer 与 fix。',
        rejects_before_upstream: true,
        fail_open: '预检异常/超预算时一律放行，并在 x-relay-precheck 头标注',
      },
    };
  }
}
