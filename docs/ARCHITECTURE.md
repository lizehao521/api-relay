# 架构

> 目标读者：接手这个系统的人（包括三个月后的我自己）。
> 本文只讲**结构与边界**；设计契约与红线在 [`DESIGN.md`](DESIGN.md)，部署运维在 [`DEPLOYMENT.md`](DEPLOYMENT.md)。

---

## 1. 全局视图

```
                     ┌──────────────────────────────────────────────────────┐
   客户端            │  RelayServer (node:http, 零依赖)                      │
 (openai SDK /  ────▶│  · 解析 HTTP、注入 requestId、限体积、写响应           │
  脚本 / Agent)      │  · SSE 逐字节转发 + 字节计数                          │
                     └───────────────┬──────────────────────────────────────┘
                                     │ EngineRequest（已解耦传输）
                     ┌───────────────▼──────────────────────────────────────┐
                     │  Engine（管道核心，与 HTTP 无关，可单测直接驱动）      │
                     │                                                      │
                     │  parse → auth → precheck(P2) → fingerprint →          │
                     │  complexity → route → upstream → classify(P3) →      │
                     │  meter(P8) → respond                                 │
                     └──┬────────┬────────┬────────┬────────┬───────────────┘
                        │        │        │        │        │
        ┌───────────────▼┐ ┌─────▼──────┐ │ ┌──────▼─────┐ ┌▼──────────────┐
        │ KeyRegistry    │ │ ProviderPool│ │ │ Classifier │ │ Meter/Tracer  │
        │ 鉴权/限流/额度  │ │ + Router    │ │ │ 归因规则库  │ │ 度量/轨迹      │
        │ （fail-closed）│ │（熔断/多key）│ │ │（纯函数）   │ │（fail-open）  │
        └───────┬────────┘ └─────┬───────┘ │ └────────────┘ └──────┬────────┘
                │                │         │                      │
                │        ┌───────▼─────────▼──────┐        ┌──────▼──────┐
                │        │ UpstreamClient          │        │ Store       │
                │        │ (openai 兼容 / 多key轮换)│        │ SQLite/内存 │
                │        └───────┬─────────────────┘        └─────────────┘
                │                │
                └────────────────┴──▶ 上游模型服务商（DeepSeek / OpenAI / 硅基流动 / OpenRouter / vLLM …）
```

---

## 2. 模块边界（为什么这样切）

| 模块 | 行数 | 职责 | 不做什么 |
|---|---|---|---|
| `core/` | 1,536 | 类型契约、YAML 子集解析、配置装载、结构化日志 | 不含任何业务判断 |
| `util/` | 320 | 纯工具：ID/哈希/HMAC、环形缓冲、有界缓存、滑窗计数、退避 | 无状态、无 IO |
| `loss/` | 2,133 | 降损层：预检、归因、度量、轨迹、指纹 | **不直接接触 HTTP**，纯逻辑可单测 |
| `upstream/` | 1,265 | 上游客户端（含多 key 轮换）、上游池（健康/熔断/并发闸门）、路由 | 不解析业务语义 |
| `gateway/` | 1,889 | 引擎管道、鉴权/限流/额度、HTTP 传输 | 引擎不依赖 `node:http` |
| `store/` | 923 | 度量持久化（SQLite/内存双实现）、维度聚合、key 元数据 | 主路径只入内存队列，绝不阻塞 |
| `admin/` | 697 | 管理 JSON API + 内嵌单页看板 | 只读展示 + 少量运营动作 |
| `mock/` | 383 | 可注入故障的 OpenAI 兼容 mock 上游 | 仅供开发/测试 |

**关键切法**：`Engine` 与 `RelayServer` 之间用 `EngineResult`（JSON 或 Stream）解耦。
带来两个直接好处：
1. 测试可以在进程内直接驱动引擎（快、断言细）；冒烟测试再走真实 HTTP。两层都有覆盖。
2. 以后要换传输（HTTP/2、gRPC、Lambda 适配）只改 `gateway/server.ts`。

---

## 3. 请求生命周期（一次调用的完整记账）

```
Engine.handle()
  │
  ① parseBody            ── JSON 解析失败 → 400（不改写上游，因为根本没到上游）
  │
  ② keys.authenticate()  ── 唯一 fail-CLOSED 的环节（安全边界）
  │     · key sha256 索引查找 → 401 / 403 / 402 / 429 / 并发闸门
  │     · 成功后 take 一个并发额度，finally 必还（含流式结束时）
  │
  ③ precheck(P2)         ── fail-open；仅 enforce 层 + onBlock=reject 才真的拦
  │     · 全上游不可用时跳过模型检查，放行到路由层（否则会误报 400）
  │
  ④ computeFingerprint   ── 纯函数，只用本请求 + 短窗口计数；system prompt 只留 HMAC 前缀
  │
  ⑤ assessComplexity     ── 保守启发式，只给 smart routing 用
  │
  ⑥ 循环：route → limiter.acquire → client.send
  │     · route 排序：未试过 > 试过 > 刚失败（tried/deprioritize 两层集合）
  │     · 成功 → 直接返回（非流式缓冲透传 / 流式建管道返回）
  │     · 失败 → classify(P3) → 若可恢复且策略允许 → 退避 + 重试（最多 1+autoRetry 次）
  │             · 致命归因（密钥/权限/余额）→ 加入 `fatal`，本次请求不再选它
  │             · 瞬态归因（限流/超时/5xx）→ 只加入 `tried`，唯一上游时仍会重试它
  │
  ⑦ 失败返回             ── 上游错误体原样（补齐 schema 必填字段）+ 归因附加/响应头
  │
  ⑧ recordMeter(P8)+trace(P5) ── 内存入队，绝不阻塞；异常全吞（fail-open）
  │
  ⑨ release 并发额度
```

### 3.1 流式路径的特殊处理

```
上游 fetch(body) ──tee──┬─▶ clientSide ──[需要改 model 回显?]──▶ 响应给客户端
                        │                        └─ rewriteSseModel（逐帧只改 model 字段）
                        └─▶ meterSide ──▶ consumeSse 旁路解析 → transcript（字符数/tool_calls/usage/畸形帧）
```

- **tee 的度量分支绝不 backpressure 客户端分支**（否则慢看板会拖慢转发）。
- 流结束后 `onEnd` 才记账（此时才知道真实字节数与 usage）。
- 若上游回显的 model 与客户端请求的 model 不同（别名场景），才启用 `rewriteSseModel`；
  否则**零改写零拷贝**直接透传。这是"既正确又不过度加工"的取舍。

### 3.2 故障转移的两层集合（一个真实踩过的坑）

最初把"失败过的上游"直接放进 `exclude`，结果：**只有一个上游时，重试永远不会发生**——
第一次失败就把唯一候选排除了，用户拿到的是"没有可用上游"这种误导性错误（测试里真的抓到了）。

现在的语义：

| 集合 | 含义 | 是否还选它 |
|---|---|---|
| `fatal` | 密钥/权限/余额类，重试不可能成功 | 否（`exclude`） |
| `tried` | 本次请求试过的 | 是，但排在没试过的后面（`tried` + `deprioritize`） |

配合 `isFatal()` 的职责分离：**熔断**（连续失败计数）与**归因的 recoverable**（是否建议客户端重试）是两件事。
`503 overloaded` 对客户端是 `recoverable: false`（别重试），但对中转站是**瞬态**故障，必须靠计数熔断而非一次就摘。

---

## 4. 数据与状态边界

| 数据 | 位置 | 生命周期 | 是否含正文 |
|---|---|---|---|
| 客户端 key | 配置 + key_meta 表（sha256 索引） | 长期 | 仅哈希 |
| 请求/响应正文 | **不落盘** | — | 否 |
| payload 哈希 | meter 行（`duplicateInWindow` 用） | 保留期 | 仅 sha256 |
| system prompt 哈希 | 内存短窗口（5 分钟） | 进程内 | 仅 HMAC 前缀 16 字符 |
| 度量明细 | `meter` 表 | `retentionDays`（默认 30 天） | 否 |
| 轨迹 | 内存环 + `trace` 表 | 保留期 | 步骤摘要（含上游错误 message 片段） |
| 熔断状态 | `breaker_state` 表 | 长期 | 否 |
| 限流计数 | 内存（每实例） | 分钟级 | 否 |

**控制面 / 数据面分离**：数据面（转发）不依赖数据库；数据库故障 → 自动降级为纯内存并记 `degradedEvents`，
服务继续可用但重启后丢历史。这是刻意的：**中转站不能因为看板数据库挂了就不能转发**。

---

## 5. 上游路由

### 5.1 候选筛选（按顺序）

1. 不在 `exclude`（fatal）中
2. 声明支持目标模型（经 `modelAliases` 与 `provider.modelMap` 解析）
3. 未 `disabled`
4. 未处于熔断打开状态（到期的半开）

### 5.2 排序键（优先级从高到低）

1. 本次请求是否试过（未试过优先）
2. 是否刚失败（刚失败排最后）
3. 静态 `priority`（大者优先）
4. 成本（`cost.inputPerMTok + outputPerMTok`，无 cost 视为 ∞）
5. 权重
6. ewma 延迟

`smartRouting`（仅 pro 层）在**任务判定为 simple** 时，把候选裁剪为"配了 cost 的上游"再排序。
`assessComplexity` 刻意保守：只有明确证据（无工具、短消息、非推理模型……）才判 simple，
因为"把难任务路由到弱模型"比多花钱严重得多。

### 5.3 熔断

| 事件 | 动作 |
|---|---|
| 致命归因（auth/permission/quota） | 立即打开熔断，冷却 `breakerCooldownMs` |
| 瞬态失败 | `consecutiveFailures++`，达到 `breakerThreshold` 打开 |
| 任一次成功 | 连续失败清零、熔断关闭 |
| 冷却到期 | 半开：允许一次试探 |

熔断状态持久化到 `breaker_state`，**进程重启后不会立刻重新打爆一个坏上游**。

### 5.4 多 key 池（`KeyRotator`）

- **轮换**：round-robin，起点为上次位置的下一格（公平分摊限流）。
- **瞬态失败**（429/5xx/超时）：该 key 短冷却（递增上限 10 分钟），不影响其他 key。
- **永久失败**（401/403/余额不足）：该 key 报废，直到人工 `reset()`。
- 全部 key 不可用 → 返回可归因的 503，交由**上游级**故障转移（两层故障转移正交）。

---

## 6. 扩展点（想加功能时改哪里）

| 想加什么 | 改哪里 | 注意 |
|---|---|---|
| 新上游协议（Anthropic / Gemini） | `upstream/client.ts` 新增 `UpstreamClient` 实现 + `createUpstreamClient` 分支 | 契约已冻结（`UpstreamOutcome`），上层无感 |
| 新归因规则 | `loss/attribution.ts` 的 `RULES` 数组 | 必须带 `confidence`；`recoverable=false` 才进熔断致命路径；有测试 |
| 新预检规则 | `loss/precheck.ts` 的检查函数 + `PRECHECK_CODES` | 只做"上游必然拒绝"的；`warn` 级永不拦截 |
| 新度量指标 | `core/types.ts` 的 `MeterRecord` → `store` 的 schema 与 INSERT → `MeterSummary` | 改 schema 要写迁移；正文一律不落 |
| 新分层 | `core/config.ts` 的 `DEFAULT_TIERS` + `TierPolicy` | 三层的键名在 `RelayConfig.tiers` 里是强类型 |
| 分布式限流 | 实现一个新的 `Store`（Redis），`incrRate`/`quotaSnapshot`/`record` | 接口已隔离；主路径要保证 fail-open |
| 新管理接口 | `admin/api.ts` 的 switch | 必须走 `authorize()`；写操作必须 `store.logEvent()` 留痕 |
| 新面板页签 | `admin/dashboard.ts` 的 `tabs` 数组 + `loadTab` 分支 | 只读页会参与 15s 自动刷新，表单页（keys/config）刻意不自动刷新 |
| key 的新字段 | `ClientKeyConfig` → `KeyRecord` → `key_meta` 表 → `KeyView` | 四处都要改；面板创建的 key 必须能从 DB 恢复（只靠哈希） |
| 看板换皮 | 放 `overrides/dashboard.html` | `loadCustomDashboard()` 会优先读它 |

---

## 7. 性能特征

| 环节 | 开销量级 | 说明 |
|---|---|---|
| 预检 | 数十微秒（合法请求） / 数百微秒（含工具调用） | 有 3 ms 预算上限，超了立即放行 |
| 归因 | 数十微秒 | 规则命中即返回；高置信结果记忆化（有界 LRU） |
| 指纹 | 数微秒 | 单请求 + O(1) 窗口计数 |
| 度量 | 内存入队（纳秒级）+ 后台批量 flush | 主路径不碰磁盘 |
| 轨迹 | 内存环 + 异步落库 | 上限 64 步，摘要截断 240 字符 |
| 流式转发 | 零拷贝（无别名时）；有别名时逐帧只改 `model` | tee 的度量分支不 backpressure |

**"降损层开销占比"**（看板 KPI）目标 < 0.1%。它本身就是 P8 的一部分：
一张耗时的治理层和没有治理层一样糟。

---

## 8. 可观测性

- **日志**：JSON Lines 到 stdout，直接接 Loki/ELK。敏感字段自动脱敏（`redact()`）。
- **指标**：看板 + `GET /admin/api/overview|series|report`；命名参考 OTel `gen_ai.*`（研究中已对齐）。
- **轨迹**：`GET /admin/api/traces`，单条 `GET /admin/api/traces/:id?diff=:otherId` 可对比两次请求定位分歧点。
- **健康检查**：`GET /healthz` 返回存储状态、上游数量、熔断数量、降损计数器。有上游熔断或存储降级时返回 `degraded`。
- **请求级关联**：每个响应都带 `x-request-id`；用户报障时给这个 ID 即可定位到轨迹。
