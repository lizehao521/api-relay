# 设计契约与红线

> 这份文档是**实现与评审的共同依据**。任何绕过它的改动都必须先改这份文档，并说明理由。
> 每条红线后面都标注了它在代码里的落点与对应的测试。

---

## 0. 第一性原理

**Agent = 模型 ↔ 环境之间的传话层；中转站 = 客户端 ↔ 上游之间的传话层。**

两条推论决定了本项目的全部取舍：

1. **传话层最大的损耗在错误路径，不在成功路径。** 成功路径做得越少越好（逐字节转发就是最优）；
   错误路径做得越多越好（把"为什么败、下一步做什么"翻译成机器可执行的信号）。
2. **传话层的信任来自"我没有动你的数据"。** 任何对成功响应的加工都在削弱这个信任，
   而信任一旦破了，价格优势也救不回来。

---

## 红线 1：成功响应零改写

**契约**：HTTP 2xx 响应体与 SSE 帧序列**逐字节**保持上游原样。中转站不得增删字段、重排帧、改变 usage 数值。

**唯一例外（受控）**：当上游回显的 `model` 与客户端请求的 `model` 不同时（别名/映射场景），
把该字段改写回客户端请求的名字。理由：官方 SDK 与严格解码器（Vercel AI SDK 判别联合、Go/Rust 严格结构体）
会在 model 不匹配时崩，而"客户端拿到自己请求的模型名"是所有网关的既有契约（OpenRouter 等亦如此）。
**只改这一个字段**，其余字节不变。

**允许的附加**：响应头（`x-relay-mode`、`x-relay-loss-reduction`、`x-request-id`、`x-relay-content-hmac-*`）。
响应头不进任何 SDK 的 body 解析路径。

**落点**：`gateway/engine.ts` — 成功分支直接 `body: outcome.bodyText`；`upstream/client.ts` — `tee` 转发原始分支。
**测试**：`e2e.test.ts` "非流式成功请求"（断言无 `relay_attribution`）、"流式 SSE 线路格式"（逐帧结构）、
`engine.test.ts` "响应体原样透传"。

---

## 红线 2：错误路径必须可归因，但不得改写上游原文

**契约**：任何非 2xx 响应，在层策略允许时附带归因；但上游的 `message` / `code` **一律保留原值**。

**实现**：
- `error.message` / `error.code` 取上游原文；
- 只在**缺失**时补齐 `error.type` / `error.param`（GLM 缺两者、SiliconFlow 无 `error` 包裹层、
  OpenRouter 的 `code` 是数字状态码）——不补齐会让严格解码器崩；
- 归因作为**附加**字段 `error.relay_attribution`（full 模式）或响应头 `X-Relay-Attribution`（header 模式）；
- 无法解析的上游错误体解码为文本后走统一 `errorBody()`，并把原始体放进 `error.relay_details.upstream_raw` 以免信息丢失。

**落点**：`gateway/engine.ts#upstreamErrorPassthrough` / `#applyAttribution`，
`loss/attribution.ts`（规则库负责"翻译"，不负责"改写"）。
**测试**：`engine.test.ts` "内容过滤：透传上游错误体 + 附带归因"（断言 message 等于上游原文）。

---

## 红线 3：fail-open（治理层永不是主流程的单点故障）

**契约**：预检、归因、度量、轨迹、指纹任一环节的**内部异常**都不得让请求失败。

**唯一的 fail-closed 是鉴权**——那是安全边界，异常时必须拒绝（并归因为 `relay_internal_error` 计入度量）。

**具体落点**：
| 环节 | fail-open 方式 | 可观测信号 |
|---|---|---|
| 预检 | 异常/超预算 → 放行 + `result.degraded = true` | `precheckDegraded` 计数（应恒为 0） |
| 归因 | 顶层 try/catch → 返回 `unknown` 卡片 | `byFailureReason` 里的 `unknown` 占比 |
| 度量 | `Meter.record` 全包 try/catch | `snapshot().lastError` |
| 轨迹 | `TraceStore.save` 吞异常；上限 64 步 | `traceRing` 大小 |
| 指纹 | 异常 → 返回 `kind='unknown', score=0` | `byClientKind` 里的 `unknown` |
| 存储 | 初始化失败 → 降级纯内存；flush 失败 → 丢弃该批并计数 | `store.degradedEvents`、`store.ok` |
| 熔断状态持久化 | 失败静默忽略 | 日志 `upstream.breaker_open` |

**测试**：`loss.test.ts` "Meter 在 store 抛异常时 fail-open"、
`precheck.test.ts` "预检预算耗尽时 fail-open 放行"、`config.test.ts` 校验宽松模式。

---

## 红线 4：纯函数审查（记忆化之前必须先证明纯函数性）

**契约**：凡是要缓存/复用的逻辑，必须先确认"输入确定 → 输出确定"。

| 函数 | 纯？ | 可缓存？ | 依据 |
|---|---|---|---|
| `precheck()` | ✅（时钟只用于预算检查，不影响结论） | 可（当前未缓存） | 有纯函数测试 |
| `classifyFailure(input, nowMs)` | ✅（`nowMs` 显式传入、不读全局时钟） | 可 | 缓存键必须覆盖 `attempt` 与 `retry-after` |
| `computeFingerprint()` | ✅ | 可 | HMAC 盐是输入的一部分 |
| `assessComplexity()` | ✅ | 可 | — |
| `transcriptFromSse()` | ✅ | 可 | — |
| **预检结果缓存** | ❌ | **不可** | 依赖模型目录（随上游禁用/熔断变化） |

**记忆化的两条附加规则**：
1. 缓存键必须覆盖**全部**影响输出的输入（`classifyCacheKey` 含 body 片段、headers、attempt、网络错误码）。
2. **低置信度（< 0.5）的兜底结论不缓存**——把"我不知道"固化成事实是最糟的记忆化。

**测试**：`attribution.test.ts` "归因卡片是纯函数"、"缓存键覆盖全部输入"、"低置信度结果不进入缓存"。

---

## 红线 5：归因必须给出**可执行**的下一步

**契约**：`suggested_next.action` 必须是有限枚举（11 个 `quick_action`）之一，能被 Agent 直接翻译成一行代码；
`retryAfterMs` 在可退避场景必须给出具体毫秒（不让客户端猜）。

**反面例子（不许出现）**：`"suggested_next": "请检查你的请求"` —— 这不是动作，是废话。

**动作枚举 → 客户端应有的反应**：
| action | 客户端该做什么 |
|---|---|
| `retry_with_backoff` / `wait_and_retry` | 等 `retryAfterMs` 后重发同一请求 |
| `retry_same` | 立即可重发（幂等前提） |
| `reduce_context` | 裁剪 messages/文档后重发 |
| `raise_max_tokens` | 提高输出上限 |
| `switch_model` | 换模型（或换更便宜/更强的上游） |
| `rewrite_input` | 改写输入（内容安全触发） |
| `top_up_balance` | 充值/换 key |
| `fix_credentials` | 修 key（中转站侧问题，用户可联系运营） |
| `fix_request` | 修请求结构 |
| `abort` | 停止，不要重试 |

**关键区分**（有测试钉住）：
- `429 + insufficient balance` → `quota_exhausted` + `top_up_balance`（**不可重试**）。
  若错判为 `rate_limited`，Agent 框架会对 `RateLimitError` 疯狂重试。
- 余额/额度不足的 HTTP 状态码是 **402 而非 429**（同一理由）。
- `finish_reason=content_filter`（HTTP 200 内）也必须产出归因，但**不改写响应体**。

---

## 红线 6：不落盘用户正文

**契约**：默认不存 prompt / completion 正文。可落盘字段白名单见 `ARCHITECTURE.md` §4。

**技术手段**：
- 指纹用 **HMAC-SHA256（进程级盐）+ 截断 16 字符**，不用裸 sha256。
  理由：system prompt 是低熵文本，裸哈希可被字典反推。
- 正文哈希只在需要"同 payload 重复检测"时计算（可关闭：`meter.hashPayloads`）。
- `retentionDays` 可设为 0 之外的小值，`Store.prune()` 会物理删除。
- 轨迹步骤摘要会包含上游错误 message 片段（≤ 240 字符）——这是**运营必需**（否则无法排障），
  因此在文档与用户协议中必须明确告知，而不是悄悄记录。

**测试**：`loss.test.ts` "指纹只输出 system prompt 的 HMAC 前缀，不泄漏正文"（断言序列化结果不含原文）。

---

## 红线 7：透明、可控、可逆、渐进

继承自原技能的安全原则，逐条落到实现：

| 原则 | 落点 |
|---|---|
| **透明** | `X-Relay-Mode` 始终回显 `tier/precheck/attribution/meter/client`；`/v1/attribution/catalog` 公开完整的归因词表与投递方式；看板公开归因率与降损层开销 |
| **可控** | 每层可独立开关 precheck/attribution/meter；`X-Relay-Precheck: off` 是客户端级逃生舱；部署级 `RELAY_PRECHECK_ENABLED` 等环境开关 |
| **可逆** | 每个降损模式都是独立模块，可单独停用（配置即回滚）；熔断可人工 `reset`；上游可人工摘除 |
| **渐进** | 默认 `standard=observe` 而非 `enforce`；先度量（P8）再优化；`free` 层默认全关 |

---

## 8. 兼容性契约（对外承诺的"最小惊讶"）

| 行为 | 承诺 |
|---|---|
| 错误体形状 | 始终满足 OpenAI `Error` schema 的 required：`{message, type, param, code}`（`param`/`code` 可为 null） |
| `usage` | 成功响应原样；流式由上游决定（含 `stream_options.include_usage` 的末帧） |
| `model` 回显 | 始终等于客户端请求的 model |
| SSE | 帧序列与内容不变；`data:` 前缀、空行分隔、`[DONE]` 结尾；不重排、不合帧 |
| 响应头 | 只增加 `x-relay-*` 与透传白名单内的上游头（`retry-after`、`x-ratelimit-*`、`x-request-id` 等） |
| 上游身份 | 不泄漏上游真实 baseUrl/密钥；上游 `x-request-id` 可透传（便于对账） |
| 可验证性 | 带 `X-Relay-Verify-Nonce` 时返回内容 HMAC，客户端可自证响应未被篡改 |

---

## 9. 主动放弃的能力（写在文档里，避免被当成 bug）

| 放弃 | 原因 | 若将来要做 |
|---|---|---|
| 成功响应摘要/结构化改写 | 红线 1；且提炼出的"符号"缺用户环境上下文，对 Agent 无用 | 不做（这是 Agent 框架层的事） |
| 响应缓存 | 命中=零收入 + 陈旧结果事故 | 仅在 Pro 层、用户显式 opt-in、且标注"缓存命中"的前提下评估 |
| 跨请求意图栈 | 有状态 + 会话内容留存 + 多客户端串意图 | 用 P4-lite 无状态指纹替代 |
| 同轮去重 / 返回陈旧结果 | 中转站没有"轮"，也不该替用户返回旧结果 | 只做重复观测并在看板提示用户 |
| 服务端内容安全审查 | 会引入"我们审你的内容"的信任问题与合规责任 | 只在免费层做**限速与模型白名单**，内容风控交给上游 |
| 流式内容的完整校验证明 | 需要缓冲整条流（破坏流式价值） | 已提供 mid-stream 错误帧的解析与记录；后续可注入 SSE `error` 帧 |
