# 调研综述（把三份调研收敛成可用结论）

> 三份原始调研在 `docs/research/`。本文是**给实现者与决策者的收敛版**：
> 只保留会改变行动的部分，并标注每条的可信度。
>
> 可信度标记：**[V]** 有原文/源码实证 ｜ **[I]** 行业推断 ｜ **[U]** 未核实

---

## 1. 三份调研的产出与体量

| 文档 | 体量 | 核心问题 |
|---|---|---|
| `01-竞品与生态矩阵.md` | 79 KB / 727 行 | OneAPI / NewAPI / LiteLLM / Portkey / Helicone / OpenRouter 逐项对比；fork 还是自研 |
| `02-上游协议与错误契约.md` | 54 KB / 627 行 | 对外要实现的 OpenAI 契约、各上游错误口径、归因规则素材 |
| `03-降损层在网关层的落点裁决.md` | 76 KB / 641 行 | P1~P8 逐条落到 HTTP 语义、fail-open 分阶段、合规、反方压力测试 |

方法：`web_search` 在本环境不可用（无 API key），全部结论来自**直接抓取**（GitHub REST API、仓库浅克隆到 file:line、
官方 OpenAPI spec、OpenTelemetry 指标规范、厂商文档原始源）。抓取受限的部分被逐条列在"未核实事项"里。

---

## 2. 改变行动的六条结论

### 2.1 [V] NewAPI 已是 AGPL-3.0 + Section 7 → 闭源 fork 路径被否决

`Calcium-Ion/new-api` 已 301 迁移到 `QuantumNous/new-api`，许可 AGPL-3.0，
README:474-488 额外要求：修改版必须保留 `Frontend design and development by New API contributors.` 署名，
且任何带 UI 的修改版必须保留指向原项目的可见链接。

**行动**：不 fork NewAPI。OneAPI（MIT）可作为设计参考，但不复制代码。

### 2.2 [V] OneAPI 没有多上游 key 池，且错误语义全丢

`model.Channel.Key` 是单个 `string`（`model/channel.go:23`）；
`RelayErrorHandler`（`relay/controller/error.go:55`）对非 OpenAI 上游错误只抽出一个字符串，
`type`/`code` 固定为 `upstream_error`/`bad_response_status_code`。

**行动**：多 key 池与归因层必须自研（已实现 `KeyRotator` 与 `loss/attribution.ts`）。

### 2.3 [V] P3 不是业内空白 —— 差异化必须收窄到"可执行化"

- OpenRouter 已有完整的**机器可读类型化错误**：`error_type` 词表 + `provider_code` + `metadata.raw` +
  `Retry-After`，甚至有 `HTTP 200 + error + finish_reason:"error"` 的中途流式错误协议。
- LiteLLM 已有 31 类语义化异常 + `RateLimitErrorCategory`（区分 `vendor_rate_limit` 与 `litellm_rate_limit`，
  直接回答"是谁限流的"）。

**真正的空白**：
1. 把错误翻译成 **`suggested_next` / `quick_action`**（面向 Agent 的一行可执行动作）；
2. 覆盖 **HTTP 200 里的失败信号**（`finish_reason=content_filter`，不走 `APIStatusError`）。

**行动**：
- 对外的差异化话术从"错误的分类"改为"错误的**可执行化**"；
- `failure_reason` 枚举**对齐 OpenRouter 的 `error_type` 命名风格**（小写下划线英语），
  这样同时用两者的 Agent 框架零成本适配；
- 归因规则必须同时覆盖 HTTP 错误路径与 200-with-error 路径（已实现）。

### 2.4 [V] `stream_options.include_usage` 的精确语义（双源核实）

spec 原文 + 阿里云百炼兼容模式实测输出一致：开启后会在 `data: [DONE]` **之前**多发一个 chunk，
该 chunk 的 `usage` 是整请求统计且 `choices` **恒为空数组**；其余 chunk 的 `usage` 为 `null`；
流被中断则**可能收不到**该 chunk。

**行动**：
- 流式度量必须在流结束时从 transcript 里取 usage，且要能容忍"没有 usage"（按字符估算并标注来源）——已实现；
- 计费不能依赖每个 chunk 的 usage。

### 2.5 [V] 上游错误体形态差异巨大，归因器必须多路兼容

| 上游 | 形态 | 缺什么 |
|---|---|---|
| OpenAI / DeepSeek / DashScope 兼容 | `{"error":{"message","type","param","code"}}` | — |
| 智谱 GLM | `{"error":{"code":"1001","message":"..."}}` | 缺 `type`/`param` |
| Kimi | `{"error":{"type","message"}}` | 缺 `code`/`param` |
| **SiliconFlow** | `{"code":20012,"message":"...","data":null}` | **完全没有 `error` 包裹层** |
| **OpenRouter** | `{"error":{"code":429,...}}` | **`code` 是数字 HTTP 状态码**，语义类型在 `metadata.error_type` |

**行动**：解析器已覆盖上述全部形态（有单测）；对外输出**永远补齐** schema 必填字段，
否则严格解码器直接崩。

### 2.6 [V] 附加字段的唯一合法位置在 `body.error` 内部

openai-node `src/core/error.ts`：`const error = errorResponse?.['error']`，再读 `error.code/param/type`。
openai-python `src/core/_client.py`：`data = body.get("error", body)`。

**行动**：归因字段放在 `error.relay_attribution`；顶层附加字段对官方 SDK 无效（会看不见）。

---

## 3. P1~P8 在中转站层的最终裁决

| 模式 | 裁决 | 落地形态 | 一句话理由 |
|---|---|---|---|
| P1 符号态提炼 | **不做** | — | API 层流经的全是符号数据，没有"原始载荷"可提炼；正确落点在 Agent 框架与工具之间 |
| P2 调用前预检 | **做（enforce/observe 分层）** | `loss/precheck.ts` | 只拦"上游必然拒绝"的通用规则；fail-open + 逃生舱 |
| P3 失败归因 | **做（核心差异）** | `loss/attribution.ts` | 零冲突纯增值：不省成功 token，只减少失败重试 |
| P4 跨 turn 意图栈 | **降级为 P4-lite** | `loss/fingerprint.ts` | `messages` 本身就是会话窗口，不需要留存内容状态 |
| P5 轨迹可视化 | **降级为 request-level trace** | `loss/tracer.ts` | 看到一次请求内的全部步骤；是规则回归的样本源 |
| P6 符号态缓存 | **响应缓存不做，纯函数产物缓存做** | `util/BoundedCache` | 命中即零收入；但归因规则结果是纯函数，可安全缓存 |
| P7 同轮去重 | **降级为重复观测** | `DuplicateObserver` | 不干预用户请求，只统计 `duplicateInWindow` 供运营提示 |
| P8 损耗量化基线 | **做（第一优先级）** | `loss/meter.ts` | 没有度量就没有下一步优化 |

### 3.1 P2 的 fail-open 必须按"判定点在上游之前/之后"分阶段

这是研究 03 最修正行动的一条：

| 阶段 | 后果 |
|---|---|
| 尚未发上游 | 可以返回 4xx 拦截（我们已做到：**上游请求数为 0**，有测试断言） |
| 上游已应答 | 必须透传上游的 status，不能覆盖 |
| 已 200 且流已开始 | 只能注入 SSE `error` 帧 + `finish_reason:"error"`（本版尚未实现，已列入已知边界） |

**拦错的恢复机制**（已实现）：JSON Pointer 可机器修复 + `X-Relay-Precheck: off` 绕过 +
被拦不计费（拦截发生在计费之前）。

### 3.2 P8 的指标必须含"降损层自身开销"与"误拦率"

否则 fail-open 与"不拖慢主流程"就只是口号。已实现 `overheadRatio`（预检+归因耗时 / 总耗时）
与 `precheckDegraded`（fail-open 次数，应恒为 0）。
命名参考 OpenTelemetry GenAI 语义约定（`gen_ai.client.token.usage` / `operation.duration` / `time_to_first_chunk`），
本地扩展用 `relay.*`。

**新增的重要指标**：prompt cache 命中率（OpenAI `prompt_tokens_details.cached_tokens` /
DeepSeek `prompt_cache_hit_tokens`）——这是**唯一"不改内容就能降本"的路径**。

---

## 4. 对原产品评估文档的修订建议（12 条中最关键的 6 条）

原文档是 `API中转站产品评估_传话层降损_20260905.md`。以下是调研后必须修订的部分：

1. **§3.2「P3 是所有中转站里独一份」需收窄**：OpenRouter / LiteLLM 已有错误分类。
   独有的是**可执行化**（`suggested_next`）与 200-with-error 覆盖。
2. **§9「降损省 40% 上游」是高估**：P2/P3 只减少失败重试，量级是个位数百分比。
   建议先跑 2~4 周 P8 基线再定 Pro 价，并从对外话术删除该数字。
3. **§8 技术栈已被实际选型取代**：Go/Python/PG/ClickHouse → Node 22 + TS + 原生 http + SQLite。
4. **§5.1「白嫖党纯转发」应加上限速与模型白名单**：这是防"连坐封号"的唯一低成本手段。
5. **成功响应从"绝不碰"细化为"改写 vs 附加"**：禁止改写既有字段与语义；默认不附加；
   仅在 opt-in 下允许 relay 命名空间字段 + 始终允许 `X-Relay-*` 响应头。
6. **Pro 层的定位建议从"卖降损"改为"卖可观测与可诊断"**，降损作为可选模块；
   企业客户默认全关（合规与采购阻力）。

---

## 5. 未核实事项（诚实清单）

| 事项 | 状态 | 影响 | 如何补 |
|---|---|---|---|
| 火山方舟错误码与限流口径 | **[U] 完全未核实**（官方文档纯 JS 渲染，`RateLimit` 命中 0 次） | 归因规则缺整组方舟规则，走兜底，准确率下降 | 用测试账号真机触发各类错误落盘，或抓其 SDK 异常定义 |
| OpenAI 官方错误码页 | **[I] 403 被拦**，具体 code 串为行业推断 | 错误体**形状**已由官方 OpenAPI spec 权威确认，不受影响 | 用真实 key 触发 401/429/429 配额/400 超长/404 各一次落盘 |
| 误拦的非线性代价 | **[I] 推断**，无实测 | 决定 precheck 默认是 observe 还是 enforce（当前默认 enforce，但灰度建议先 observe） | Dify / LangChain / openai-python 做"注入 400"对照实验 |
| 严格客户端是否拒绝成功响应新增字段 | **[I] 未实测** | 已按"默认不附加"的保守方案规避 | 实测 Vercel AI SDK / Pydantic `.strict()` |
| Google Vertex AI 是否有第一方 AI Gateway | **[U] 网络不通**（cloud.google.com 全部 000） | 竞品矩阵该格为空白 | 换网络环境补 |
| aihubmix 等国内站点 | **[U] 零证据**（域名仅解析到 IPv6 且无路由） | 国内形态结论仅 CloseAI 单点证据 | 需补 |

---

## 6. 调研过程中被证伪的三条（避免后人重犯）

1. **"Portkey 开源版没有后台"** —— 错误。它有内置 Admin UI（`/public/`，`conf.json.admin_token` 鉴权，
   `--headless` 可禁用，含 `/log/stream` SSE）。这是调研员的自我更正，一并记录以示"未核验的格子值得再查"。
2. **"中转站需要符号态提炼（P1）"** —— 错误。API 层流经的全是符号数据，没有可提炼的原始载荷。
3. **"OneAPI 有现成的多 key 轮换"** —— 错误。多 key 是 NewAPI 的增量，OneAPI 是单 key。
