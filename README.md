# api-relay — 模型 API 聚合中转站（内嵌传话层工程降损）

> **一句话**：一个 OpenAI 兼容的多上游聚合网关，把「传话层工程降损」（P2 调用前预检 / P3 失败归因 / P8 损耗量化基线）
> 从第一天就建在核心链路里，而不是事后插进去。
>
> **它卖的不是 token，是"错误对 Agent 可执行"。** 成功响应逐字节透传，一点不碰。

| 项 | 值 |
|---|---|
| 运行时 | Node.js ≥ 22.5（用到 `node:sqlite`） |
| 语言 | TypeScript 5.6（strict），编译到 ESM |
| **运行时依赖** | **0 个**（仅 `node:http` / `node:crypto` / `node:sqlite` 等内置模块） |
| 开发依赖 | typescript、@types/node、tsx |
| 源码规模 | 42 个文件 / 19,966 行（不含测试） |
| 测试规模 | `node --test` 实测 **269 项通过 / 0 失败** |
| 存储 | SQLite（WAL，控制面） / 内存（可切换） |
| 核心模块 | `loss/` 降损层 2,073 行 · `gateway/` 网关 3,383 行 · `upstream/` 上游池 · `store/` 度量库 |

---

## 1. 一条命令跑起来

```bash
cd api-relay

bash demo.sh          # 或者： npm run demo
```

它会在这**一个进程**里同时起好 mock 上游 + 网关 + 看板，自动避开被占用的端口，
启动后立刻跑 5 项自检并打印结果，然后告诉你下一步点哪里。

**不需要任何密钥、不需要配置文件、不需要 `npm install`。** 看到这样的输出就成功了：

```
  api-relay 体验模式已启动（mock 上游 + 网关 + 看板，全部在这个进程里）

  ① 打开看板   http://127.0.0.1:8787/admin
  ...
  自检结果
    ✓ 健康检查                         HTTP 200
    ✓ 正常请求（Pro 层）                  HTTP 200
    ✓ P3 失败归因（注入 429）              归因卡片 + 可执行动作 ✓
    ✓ P2 预检拦截（畸形 tool_calls）       拦截于上游之前 ✓
    ✓ 免费层纯管道（无归因）                  错误体零附加 ✓

  正在运行，按 Ctrl+C 退出…
```

然后照它打印的提示做就行：打开看板看疗效，把 `model` 换成 `mock-429` / `mock-balance` /
`mock-filter` 看"错误被翻译成可执行动作"长什么样，换 key 看三层的行为差异。

> 体验模式监听 `127.0.0.1` 且管理接口免令牌，仅供本机体验，**不要用于生产**。
> 生产部署见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

---

## 2. 接第一个真实厂商（起步就走这条）

```bash
cd api-relay

node dist/cli.js vendors                          # 看有哪些内置厂商模板
node dist/cli.js starter --vendor deepseek        # 生成 starter.yaml（单厂商单模型）
export DEEPSEEK_API_KEY=sk-你的key
node dist/cli.js check --config starter.yaml      # 不导出密钥也能跑，会告诉你还缺什么
node dist/cli.js serve --config starter.yaml      # 启动 → 打开 http://127.0.0.1:8787/admin
```

生成的 `starter.yaml` 只有**一个上游、一行 models、两个 key 槽**——刻意的，别一上来就面对选项森林。
换厂商只是换个 flag，换模型只是改 `models` 那一行：

```bash
node dist/cli.js starter --vendor dashscope --out starter.yaml   # 阿里云百炼
node dist/cli.js starter --vendor siliconflow --out starter.yaml # 硅基流动
node dist/cli.js starter --vendor mock --out starter.yaml        # 本地 mock，零密钥离线跑
```

**第一次接真实上游会看到什么**（这才是重点，不是配置能不能生成）：

- 正常调用：`/v1/chat/completions` 直接通
- 上游限流：拿到 `rate_limited → retry_with_backoff + retryAfterMs`，而不是一句 `429`
- 上游余额不足：拿到 **HTTP 402** + `top_up_balance`（明确不让你重试）
- 上游挂了：`/admin` 的上游页会显示熔断，请求自动切到下一个可用上游（只有一个上游时是重试同一个）

内置模板：`deepseek` `dashscope` `siliconflow` `moonshot` `zhipu` `ark` `openrouter` `agnes` `mock`。

### 遇到不守 OpenAI 标准的厂商怎么办

有些厂商的 HTTP 约定和 OpenAI 不一样，**这类差异必须靠配置表达，不能让代码去猜**（猜错会静默鉴权失败）。
目前已知一例：

| 厂商 | 差异 | 配置写法 |
|---|---|---|
| **Agnes**（apihub.agnes-ai.com） | `Authorization` **不带 `Bearer` 前缀**，裸 token 才行；带上反而 401 | `auth: { format: bearerless }` |

`starter --vendor agnes` 生成的配置里已经写好了这个字段。可选的 `format`：
`bearer`（默认）/ `bearerless` / `api-key-header`（可配 `headerName`）/ `x-api-key`。

> Agnes 的 `/models` 是**公开接口**（带任意 Authorization 头即返回 200，不校验），
> 所以**不能用它来判断密钥是否有效**——必须真的发一次 `/chat/completions`。
> 同一账号下还有 `agnes-video-*` / `agnes-image-*`，那些端点语义与计费不同（视频按秒），
> 不在本网关覆盖范围内，因此起步配置只列 chat 模型。

> 模型名与价格会变。模板只保证**格式正确**，不保证**当下最优**——接好之后用
> `GET /v1/models` 核实你账号实际可用的模型，再改 `models` 一行。

## 3. 档位阶梯：让客户的任务自动跑完

**竖向**沿能力阶梯换模型，**横向**换同模型的别的供应商。客户只写一个名字，剩下的交给你。

```yaml
modelLadders:
  旗舰: [agnes-3.0-flash, agnes-2.5-flash, agnes-2.0-flash]  # 旗舰挂了 → 往下推
  fast:     [agnes-2.0-flash, agnes-2.5-flash, agnes-3.0-flash]  # 极速挂了 → 往上推
  平衡: [agnes-2.5-flash, agnes-2.0-flash, agnes-3.0-flash]  # 同层先切，再向外
```

阶梯名会进对外模型清单，所以客户直接写 `"model": "旗舰"` 就能用（2026-09-14 起档位名改中文，旧英文名 flagship/balanced/fast 不再保留）。

**阶梯只用一家厂商自家的型号**：`旗舰 / 平衡 / 极速` 是 Agnes 自家三档，
`mimo-旗舰 / mimo-极速` 是 MiMo 自家两档；跨厂商兜底的另起名字
（`旗舰-any / 极速-any`，Agnes 整条不可用时落到 MiMo）——混在一起会让
"往下推一档"变成"换一家厂商"，那是另一个决策，不该藏在同一串名字里。

**上游超时必须显式设**（对外配置的教训）：内置默认是 TTFB **120 秒** / 整体 **600 秒**，
对阶梯来说太长——上游一卡，请求就一直吊着，阶梯根本没机会往下走
（实测：免费档的 Agnes 卡了 31.6 秒，客户端只能自己断开）。对外配置里写死
`upstreamTtfbTimeoutMs: 90000`（首字节 90 秒内没来就判这阶失败，2026-09-14 从 60s 上调——客户发 14.5 万+ token 超长轨迹，上游首字节本来就要 15~53 秒）+ `upstreamTimeoutMs: 300000`。

**实测的一次真实阶梯**（第一阶的模型该 key 没权限，返回 403）：

```
+4ms    ok   route            档位阶梯共 3 阶：agnes-2.5-pro → agnes-3.0-flash → agnes-2.5-flash
+4ms    ok   route            → agnes（smart_routing）model=agnes-2.5-pro
+852ms  FAIL classify         permission_denied
+852ms  ok   retry            阶梯推进：agnes-2.5-pro → agnes-3.0-flash（因 permission_denied）
+1870ms ok   upstream_response HTTP 200
+1870ms ok   respond          HTTP 200
```

**换了模型一定会告诉你**（否则就是"静默降级"）：

```
x-relay-model-requested: 旗舰（响应头只允许 ASCII，中文名按 UTF-8 百分号编码，如 %E6%97%97%E8%88%B0）        ← 你请求的
x-relay-model-served: agnes-3.0-flash   ← 实际答的
x-relay-ladder: 2/3                     ← 走在第几阶
x-relay-switched: 旗舰->agnes-3.0-flash（同上百分号编码）
```

### 安全前提：能力表

换模型**不是等价操作**——带 `tool_calls` 的请求切到不支持 function calling 的模型，
整个任务直接废掉，比返回错误还糟。所以切之前要能判断"换过去还成立吗"：

```yaml
modelCapabilities:
  agnes-3.0-flash: { tools: true }
  agnes-2.5-flash: { tools: true }
  agnes-2.0-flash: { tools: true, contextWindow: 32000 }
```

- `tools: false` 的模型，带工具的请求会**跳过**它
- `contextWindow` 填了之后，超长请求会自动跳过放不下的模型
- **未声明的字段视为"未知，允许"**——宁可试，也不要因为漏配而拒绝服务

### 哪些失败才换模型

判据是**换一个模型有可能成功吗**：

| 换 | 不换（换谁都会同样失败） |
|---|---|
| 限流、过载、超时、网络、上游 5xx、流中断 | 内容过滤（`rewrite_input`） |
| 模型无权限（403）、模型不存在 | 请求参数非法、`tool_calls` 结构错 |
| 密钥/余额问题（换个模型可能落在别的供应商上） | 治理层自身错误 |
| 上下文超限（换个上下文更大的就成立） | |

请求级错误**直接返回让客户改请求**，而不是拿他的请求去试遍所有模型。

### 一键拉取模型

```bash
node dist/cli.js pull-models --config agnes-ladder.yaml            # 拉取并写回配置
node dist/cli.js pull-models --config agnes-ladder.yaml --dry-run  # 只看差异
```

它会自动**排除视频/图片/向量等非对话模型**——那些端点语义与计费都不同，
拉进配置只会让客户拿它们打 `chat/completions` 然后失败：

```
【agnes】拉取 https://apihub.agnes-ai.com/v1/models
  上游共 12 个模型
  可作对话模型  6 个: agnes-2.0-flash, agnes-2.5-flash, ...
  已排除非对话  6 个: agnes-image-2.0-flash, agnes-video-2.5, ...
  新增 3: agnes-2.0-flash, agnes-2.5-pro-alpha, agnes-2.5-pro-beta
```

> 注意：`/models` 列出 ≠ 你 key 有权限。实测 Agnes 的 pro 系列在清单里但调用返回 403。
> 拉完配置后建议逐个真调一次确认。

## 4. 加到第二个上游（进阶）

等第一个厂商跑顺了、也看清了自己的真实失败率和成本结构，再考虑加第二个。
配置里所有密钥都用 `{ENV:NAME}` 插值，**不允许明文写在文件里**。

```bash
node dist/cli.js init        # 生成 config/relay.yaml（三上游完整示例）
$EDITOR config/relay.yaml    # 填上游 baseUrl / models / cost，写客户端 key

node dist/cli.js check       # 校验配置，并告诉你还缺哪些环境变量（这一步不用导出密钥）
export DEEPSEEK_API_KEY=sk-...
export RELAY_ADMIN_TOKEN=$(openssl rand -hex 24)   # 48 位十六进制，与 docs/DEPLOYMENT.md 一致

node dist/cli.js serve       # 启动
node dist/cli.js report      # 打印度量报告（P8）
```

`config/relay.example.yaml` 是可运行的三上游示例（DeepSeek + 硅基流动 + mock），
含 cost 配置与三层客户端 key，可以直接照抄改造。

前置要求只有一条：**Node.js ≥ 22.5**（用到内置 `node:sqlite`）。运行时**零依赖**，
所以生产环境不需要 `npm install --production`。

---

## 5. 验证它真的在工作

```bash
npm test                 # 单测数量以实际输出为准（当前 216 项）
bash scripts/smoke.sh    # 30 项真实进程冒烟：流式、故障注入、限流、优雅退出、重启后度量
```

冒烟脚本会自己起 mock 上游与网关，跑完自动清理，不需要预先准备任何环境。

---

## 6. 它到底是什么（以及刻意不是什么）

### 6.1 是

- **OpenAI 兼容网关**：`/v1/chat/completions`（含 SSE 流式）、`/v1/embeddings`、`/v1/completions`、`/v1/models`。
  客户端把 `base_url` 指过来就能用，不改一行业务代码。
- **多上游聚合**：一个 key 聚合多上游；按优先级 / 成本 / 权重 / 延迟路由；可恢复错误自动故障转移；熔断与半开。
- **多 key 池**：同一上游可挂多个 key，轮换分摊限流；被拒的 key 自动报废或短冷却，用户无感。
- **分层商业模式**：`free` / `standard` / `pro` 三层，降损能力按层开关（见 §4）。
- **降损层（核心差异）**：
  - **P2 调用前预检**：畸形 `tool_calls`、非法参数、越界采样、模型名拼错……在上游之前拦下，省一次往返。
  - **P3 失败归因**：raw error → `{failure_reason, suggested_next.action, recoverable}`，让 Agent 直接知道下一步做什么。
  - **P8 损耗量化基线**：归因投递率、自动恢复数、无效重试数、预检拦截数、**降损层自身开销占比**。
  - **P5 请求级轨迹**：一次请求内 `auth→precheck→route→upstream→classify→retry→stream→meter` 的完整时间线，排障不再靠猜。
  - **P4-lite 无状态指纹**：只从单个请求的结构特征识别 Agent 客户，不存会话正文。
- **可验证的透明性**：`X-Relay-Verify-Nonce` → 响应头返回内容 HMAC，客户端可自行证明字节未被篡改。
- **运营看板**：内嵌单页 HTML，零 CDN 依赖，内网可用。

### 6.2 刻意不是

| 不做 | 原因 |
|---|---|
| **P1 服务端改写成功响应** | 动摇"我只是管道"的信任假设；且有损 bug 会变成客户事故。降损只做错误路径。 |
| **P6 响应缓存** | 命中即零 token 零收入，且 LLM 非确定性下返回陈旧结果是信任灾难。只缓存纯函数产物（规则表、正则）。 |
| **P7 同轮去重** | 没有"轮"的概念，也不该替用户返回旧结果。降级为**重复观测**（`duplicateInWindow`），只统计不干预。 |
| **P4 跨请求意图栈** | 要求 Redis 有状态架构与会话内容留存。降级为 P4-lite 无状态指纹。 |
| **Agent 平台能力** | 中转站只看得到单请求。一旦开始"帮用户编排"，就不是中转站了。见 `docs/research/03` 的边界论证。 |
| **fork OneAPI / NewAPI** | NewAPI 已迁至 `QuantumNous/new-api`，许可为 **AGPL-3.0 + Section 7**，闭源商用路径被否决；OneAPI 是 MIT 但其 `Channel.Key` 是单个字符串、错误处理器只保留一个字符串（语义全丢），且没有我们需要的降损插槽。见 `docs/research/01`。 |

---

## 7. 降损层做了什么（可验证清单）

每条都对应一个通过的测试，不是宣传语。

### 7.1 P2 调用前预检

| 能检（会在上游之前拦下） | 不能检（也不该假装能） |
|---|---|
| `model` 缺失 / 不在清单（带编辑距离推荐最接近的模型） | 用户环境里的 DOM 元素是否存在 |
| `messages` 非数组 / 为空 / 超上限 | 图片 URL 是否可达（要外网探测，引入 SSRF 面） |
| `role` 非法、`content` 类型错误 | 语义级"这个工具调用有没有意义" |
| `assistant.tool_calls[].function.arguments` **不是 JSON 字符串**（最高频的 Agent 框架 bug） | 上游是否"心情不好" |
| `tool_call_id` 回引不存在的声明 / 重复回填 | — |
| `tool_choice` 指向未声明的工具、工具名重复 | — |
| `temperature/top_p/penalty` 越界、`max_tokens` 非法 | — |
| `json_object` 模式但消息里没有 JSON 指令（warn 级，不拦） | — |
| shell 类工具参数命中危险命令黑名单（可配置） | — |

三条工程铁律（都有测试）：

1. **fail-open，但安全项例外**：预检内部异常或超出预算（默认 3 ms）一律放行，并如实记 `precheckDegraded`。
   "治理层不能成为主流程的单点故障"不是口号，是 `_degraded` 计数器。
   **唯一的例外是危险命令扫描**：它排在预算守卫之前、自己不看预算，成本用"最多扫 1024 条工具调用"
   这种结构性上限保证有界。原因见 [`DECISIONS.md`](DECISIONS.md) ADR-014 ——
   "CPU 一忙危险命令拦截就自动关闭"是安全级的静默失效，不能用性能取舍来解释；
   分界线是**失效后果**：漏拦危险命令会删用户机器，漏拦 `tool_choice` 只是少一次提前提示。
2. **只拦"上游必然拒绝"的**：`temperature` 上限各上游不同，用一套边界拦所有上游就是自我 DDoS。因此只拦协议级硬边界（OpenAI 规范明确写死的范围）。
3. **误拦逃生舱**：客户端加 `X-Relay-Precheck: off` 即绕过拦截（请求照常放行并留痕）。用户不该被治理层的误判锁死。

### 7.2 P3 失败归因

15 类 `failure_reason` × 11 种 `quick_action`，覆盖：

- **限流 vs 余额不足的区分**（关键）：`429 + insufficient balance` 必须判为 `quota_exhausted`（不可重试），
  否则 Agent 框架会对 `RateLimitError` 疯狂重试。同理**余额不足返回 402 而不是 429**。
- **六种上游错误体形态**都能解析（有测试）：标准 OpenAI / 智谱 GLM（缺 type/param）/ Kimi（缺 code）/ 
  **SiliconFlow（无 `error` 包裹层）** / **OpenRouter（code 是数字 HTTP 状态码）** / HTML 错误页。
- **输出永远补齐 OpenAI error schema 的必填字段**（`type`/`param`/`code`），否则严格解码器会直接崩。
- **绝不改写上游原文**：`message` 与 `code` 以上游为准，归因只作为附加字段/响应头。
- **HTTP 200 里的过滤信号**也覆盖（`finish_reason=content_filter`）——这类不走 `APIStatusError`，是最容易漏的一类失败。
- **"没有可用上游"分四种说法，禁止混淆**（[`DECISIONS.md`](DECISIONS.md) ADR-013）：
  模型真没人支持 → `404 model_not_found`；上游全熔断 / 被人工摘除 / 被本请求排除 → `503 upstream_error`
  并附 `relay_details.root_cause`（如 `rate_limited`）与标准 `Retry-After`。
  不变量：只要**有**上游声明支持该模型，就绝不说成"模型不存在" ——
  否则人会去改模型名，那是在唯一正确的动作之外做了唯一错误的动作。
- **"模型名写错了"与"这个 key 没开通"必须分开**：前者是**改名字**的事，后者是**去开通**的事。
  模型名不在网关清单里 → `404 model_not_found`，并附**拼写建议**与这把 key 的可用清单；
  模型存在但白名单没有 → `403 model_not_allowed`。混着说会把人引向完全错误的方向
  （实测有人把 `agnes` 写成 `agens`，网关却告诉他"你的 key 未开通模型 agens"）。
- **"客户端 key 不对"与"上游拒绝密钥"分开算，且都要留下证据**（[`DECISIONS.md`](DECISIONS.md) ADR-016）：
  前者是网关自己回的 401（`failure_reason=auth_invalid` 且没有上游参与），后者才归因到上游。
  混在一个计数里，面板横幅必然指错方向 —— 一个要用户换 key，一个要运维换上游密钥。
  401 文案带 **key 指纹**（`sha256` 前 8 位）并指向面板自检入口；被拒的 key 记入台账
  （只记指纹/提交形态/长度，**永不记明文**）。
- **失败归因与维度聚合一律读持久层**，重启后不许失真；**未鉴权流量单独成桶 `(未鉴权)`**，
  不得冒充 `free` 层或空模型名。这条是被真实事故逼出来的：评测时客户端用了旧 key，
  网关连回 202 次 401，而当时 `byModel` 走 SQL 报 202 条、`byFailureReason` 走内存只报 1 条，
  同一个看板自相矛盾，"上游拒绝密钥"的横幅因此永不触发 —— 用户看到的是"API 掉线了"。

投递通道按分层降级：

| 层 | `precheck` | `attribution` | 效果 |
|---|---|---|---|
| free | off | **off** | 纯管道：错误体一个字节都不加（守住"同价"承诺与信任假设） |
| standard | observe | **header** | 错误体保持原样，归因只进 `X-Relay-Attribution` 响应头 |
| pro | enforce | **full** | 错误体 `error.relay_attribution` 内附完整卡片 |

### 7.3 P8 损耗量化基线

看板与 `relay report` 给出的口径（每个都对着一个可行动的结论）：

| 指标 | 为什么它决定下一步 |
|---|---|
| **归因投递率** | < 80% 说明有失败模式没被规则覆盖 → 该补规则了 |
| **自动恢复数** | 重试后成功 = 用户少一次人工介入 = 留存价值 |
| **无效重试数（60s 窗口同 payload）** | 高 → 该引导用户加同轮去重，或在客户端加幂等键 |
| **预检拦截数** | 每条都是一次省下来的上游往返与 token |
| **预检降级放行数** | 应恒为 0；不为 0 说明治理层在 fail-open，是 bug 信号 |
| **降损层开销占比** | 预检+归因耗时 / 总耗时。**治理层不该超过千分之一** |
| prompt cache 命中 token | 唯一"不改内容就降本"的路径（DeepSeek `prompt_cache_hit_tokens` / OpenAI `cached_tokens`） |

### 7.4 P5 请求级轨迹

```
trace tr_xxx  request req_xxx
outcome=upstream_error duration=1043ms failed_at=upstream_response
  +     0ms ok   auth              key=pro tier=pro
  +     1ms ok   precheck          通过（0 条提示，耗时 62µs）
  +     2ms ok   route             → mock（priority）model=mock-small
  +     3ms ok   upstream_request  POST /chat/completions
  +   180ms FAIL upstream_response HTTP 429
  +   181ms FAIL classify          rate_limited → retry_with_backoff
  +   182ms ok   retry             第 2 次尝试将在 20ms 后发起
  +   205ms ok   route             → mock（failover）model=mock-small
  +   412ms FAIL upstream_response HTTP 429
  +   413ms FAIL classify          rate_limited → retry_with_backoff
  +   414ms ok   respond           HTTP 429
```

---

## 8. 管理面板

打开 `http://127.0.0.1:8787/admin`。八个页签（总览/指标/客户 Key/对账/账本/排障/运维/信任） + 登录门 + 右侧详情抽屉：

| 视图 | 回答什么问题 | 可写操作 |
|---|---|---|
| **总览** | 现在健康吗？降损层在起作用吗？下一步优化什么？ | — |
| **指标** | 这个数**为什么**是这个值（计数器 + n/avg/min/max 分布 + 派生比率） | — |
| **客户 Key** | 每个客户用多少、额度还剩多少、哪些快到期；**"我手上这个 key 到底能不能用"** | 新建、编辑层/模型白名单/额度、轮换、禁用/启用、**重置额度**、**粘贴自检** |
| **上游** | 渠道健康、熔断、key 池可用数、模型可达性 | 摘除/恢复、清熔断（不重启即时生效） |
| **请求账本** | 某次请求卡在哪一步（按结果筛选，点击看步骤时间线） | — |
| **信任** | 凭什么信你（四条设计红线 + 它对应哪组测试 + 客户自助核对方法） | — |

界面约定：

- **页签进 URL**：`/admin#users` 可直接打开某一页（刷新/收藏/分享都停在原处）。
- **客户 Key 页默认只看「生效中」**，并可按 id / 备注 / 指纹搜索 —— 历史停用的 key 是噪音，默认收起来。
- **不可逆的动作集中在「更多…」抽屉里**（轮换 / 停用），并把后果写在按钮前面；
  行内只留「编辑」和「重置」。轮换会让旧 key 立即失效，挂在每行上容易误点（真实发生过一次）。
- **数字列右对齐 + 等宽数字**（`tabular-nums`）：金额/token/耗时能成列对齐，扫读快很多。
- **载入时有明确反馈**（整页淡化 + 屏蔽点击），避免"点了没反应"被当成卡死。
- **登录门**：未鉴权时拦住整个界面，令牌只存本浏览器 `localStorage`，401 自动登出。
  > **看板外壳（`/admin` 的 HTML）与 `panel-info` 本身不需要令牌**，其余 `/admin/api/*` 一律需要。
  > 原因很实在：浏览器顶层导航带不了 `X-Admin-Token`，而登录门就在那张 HTML 里——
  > 外壳一旦也走鉴权，配了 `adminToken` 的网关在浏览器里就永远是一页 401 JSON，面板等于不存在
  > （[`DECISIONS.md`](DECISIONS.md) ADR-017）。外壳是纯静态的、不含任何数据；
  > 要连外壳都藏起来请用前置反代，而不是把登录门锁死。
- **详情用右侧抽屉**：列表是主视图，详情按需展开，不占常驻空间。Esc 或点遮罩关闭。
- **只读页 15 秒自动刷新**；客户 Key 与表单页**刻意不自动刷新**，免得打字时被重置。
- **每次写操作都进事件流**（`relay_event` 表），可审计、可回溯。
- **明文 key 只显示一次**（服务端只有 sha256，接口永不回显明文，有测试断言），忘了只能轮换。
- **每个 key 都显示指纹**（sha256 前 8 位）：这是"用户手上的 key"与"网关签发的 key"之间
  唯一安全的对照物 —— 既不泄露明文，又能一眼判断是不是同一个 key。
- **额度有两个口径，各自独立判断**：`额度(token)` 适合"给多少量"；
  `预算(元)`（`quotaCny`）适合"给多少预算"。钱必须按钱算 —— 输入 ¥3/M、输出 ¥6/M 时，
  同样 ¥10 折成 token 数完全取决于输入输出比例，用 token 额度冒充只能猜，客户对不上账。
  超预算返回 **402**（不是 429），避免客户端把"没钱了"当成"被限流"而无效重试。
  预算也落库，进程重启后仍在（老库靠 `ALTER TABLE` 轻量迁移补列）。

**"API 全 401" 的最短排查路径**（[`DECISIONS.md`](DECISIONS.md) ADR-016）：

1. 总览横幅会直接说 **"客户端提交的 key 不对（N 次 401）"**，并说明这不是上游故障；
   它与"上游拒绝了你配置的密钥"是两条不同的横幅——修复动作完全不同，所以不能合并。
2. 到「客户 Key」页**粘贴你手上的 key**，服务端换算指纹后回答四种结论之一：
   **有效 / 已禁用 / 已过期 / 不是本网关当前签发的**。用不着懂哈希，也不用把 key 发到别处。
3. 同一页的「最近被拒的 key」按指纹聚合，显示次数、最后时间、提交形态
   （`Bearer` / 裸 key / **没带 key**），并标注该指纹**是否命中已签发的 key**
   —— "key 存在但被禁用"和"根本不是这里签发的"必须分开，否则人会去查错方向。
4. 服务端日志同时落一条 `auth.rejected`（含指纹与端点的 `warn`），**每种新的错 key 记一次**，
   同一种刷屏时按 100 次折一条，不会把日志写爆。

> 轮换 key 会让旧 key **立即失效**。这是有意的（旧 key 泄露时必须能马上止血），
> 但也正是"用户以为 API 挂了"的常见来源——所以面板现在必须能自己说出这件事。

三条产品原则：

1. **把承诺摆在明面上。** 「信任」页不是文案，是四条不变量 + 每条后面写着它在哪组测试里被钉住，
   外加客户自己就能跑的对拍命令（`x-relay-verify-nonce` → `x-relay-content-hmac`）。
2. **区分"业务结论"与"原始读数"。** 总览回答业务，指标页回答"这个数怎么来的"——
   排查异常时你要的是后者（计数器的原始值、延迟的 min/max、治理层开销占比）。
3. **可逆。** 关掉某个降损模式即回滚；误摘的上游一键恢复；熔断计数可清。
   热更新的值重启后回到配置文件——面板是应急出口，不是配置漂移的来源。

管理 API（全部需要 `X-Admin-Token`，未配置时仅接受 127.0.0.1）：

```bash
GET  /admin/api/overview?window=24h | metrics | series | providers | keys | traces | traces/:id
GET  /admin/api/config | events | report | auth-policy | auth-failures | loss-reduction | attribution/catalog | panel-info
POST /admin/api/keys/create | keys/update | keys/revoke | keys/rotate | keys/reset-quota | keys/whoami
POST /admin/api/providers/toggle | providers/reset | loss-reduction/update
```

`POST /admin/api/keys/whoami` 就是上面那个"粘贴自检"接口：明文只在这一次调用里参与
哈希计算，**不写日志、不落盘、不进台账**。

免鉴权端点只有两个：`GET /admin`（静态外壳）与 `GET /admin/api/panel-info`（只回答"要不要令牌"）。

面板创建的 key 会持久化，**进程重启后仍然可用**（哈希落库，明文不可恢复）。

> ⚠ **它是落在 `storage.path` 那个库里的**，所以「换一份配置」= 「换一个钥匙串」：
> 另一份配置如果指向别的库，同一台机器上也会认不出这个 key（表现为 401 `invalid_key`），
> 而面板创建的东西不会有任何报错。**一个部署用一个 `storage.path`**（[`DECISIONS.md`](DECISIONS.md) ADR-018）。
> 真要并存多套配置，就让它们共用同一个库。
> 反过来，如果 key 是在别的库里创建的，**哈希可以直接迁过来**——用户客户端里已配好的 key 原样继续可用。

---

## 9. 分层商业模式（代码已实现，不是 PPT）

| 层 | 计费 | 降损 | rpm | 并发 | 周期额度 |
|---|---|---|---|---|---|
| free | 无 | **全关**（纯转发） | 20 | 4 | 200K token |
| standard | 按 token | 预检 observe + 归因 header | 300 | 32 | 无限 |
| pro | 订阅 | 预检 enforce + 归因 full + smart routing | 1200 | 128 | 5M token |

额度用尽返回 **402**（而非 429）；`X-Relay-Mode` 响应头始终回显本次请求被哪一层、哪套开关处理——这就是"透明"的实现。

更完整的商业化推演（含财务模型、冷启动、以及研究后修正的 Pro 定价建议）见 `docs/research/01`、`docs/research/03` §对评估文档的修订建议。

### 9.1 把一套模型"打包出售"的组成（三根轴 + 一条闸）

一个可卖的套餐就是**三件事的组合**，每件各管一种故障：

| 轴 | 解决的问题 | 怎么配 |
|---|---|---|
| **竖向**（档位阶梯） | 这个模型本身挂了 → 换同厂更低/更高的档 | `modelLadders`：`mimo-flagship: [mimo-v2.5-pro, mimo-v2.5]`、`mimo-fast: [mimo-v2.5, mimo-v2.5-pro]` |
| **横向**（同模型多供应商） | 这家供应商挂了 → 同一个模型名换另一家 | 两个 provider **声明同名模型**（`mimo-v2.5-pro` 同时由原厂与聚合站提供）；`priority` 大者优先 |
| **闸**（预算） | 客户花超了 → 这个 key 就结束 | key 上设 `预算(元)`（`quotaCny`），花完返 **402**，面板状态显示「已用完」 |

三者的关系要分清：**竖向换的是"模型"，横向换的是"供应商"**，混在同一串阶梯里会让
"往下推一档"偷偷变成"换一家厂"——那是两个不同的决策，所以跨厂商的那条另起名字（`*-any`）。

套餐边界用 key 的 `allowedModels` 圈定：圈内全通、圈外一律 **403 `model_not_allowed`**，
所以"客户拿哪把 key"就等于"他买了哪个套餐"。

**在售的一套（MiMo 套餐）**：`mimo-v2.5-pro`（**原厂主用**，宕机时自动落到聚合站兜底）
+ `mimo-v2.5`（仅原厂）+ 两条竖向阶梯，圈在一把带 **¥10 预算**的 key 里。

**恢复是自动的，而且是三段式的**（每一段都有测试钉住）：

1. **同一次请求内**：主用失败 → 重试时把失败的那家降权 → 当次就换兜底 → **客户仍拿到 200**。
2. **连续失败到阈值**（`breakerThreshold: 5`）→ 熔断该上游 `breakerCooldownMs`；
   这期间请求直接走兜底，**不拿客户请求去反复撞一个已经坏掉的上游**。
3. **冷却到期 → 半开试探一次**：成功就清零计数、立刻切回主用；
   失败就立刻再熔断一轮。所以"原厂修好了"最长一个冷却周期就被发现。

关键前提：两家声明的是**同一个模型名**，所以切换期间 `x-relay-model-served` 不变
（实测三态都是 `mimo-v2.5-pro`，客户端 200），Agent 问到的模型与回答语义完全一致 ——
这正是"同模型才敢兜底"的原因。

---

## 10. 文档地图

| 文档 | 内容 |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 架构、模块边界、请求生命周期、扩展点、性能特征 |
| [`docs/DESIGN.md`](docs/DESIGN.md) | 设计契约与红线：零改写、fail-open、纯函数审查、归因通道、合规 |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | 部署、配置项全表、运维手册、容量与安全、故障排查 |
| [`DECISIONS.md`](DECISIONS.md) | 决策记录（含 ADR-011 分两个系统的边界、ADR-012 起步只做单厂商） |
| [`docs/research/01-竞品与生态矩阵.md`](docs/research/01-竞品与生态矩阵.md) | OneAPI / NewAPI / LiteLLM / Portkey / Helicone / OpenRouter 逐项对比（含源码行号证据） |
| [`docs/research/02-上游协议与错误契约.md`](docs/research/02-上游协议与错误契约.md) | 实现者速用区：字段表、错误码映射、归因规则素材（21 个 URL 实证） |
| [`docs/research/03-降损层在网关层的落点裁决.md`](docs/research/03-降损层在网关层的落点裁决.md) | 把 P1~P8 逐条落到 HTTP 语义上，含 fail-open 分阶段、合规方案、反方压力测试 |
| [`DECISIONS.md`](DECISIONS.md) | 决策记录（为什么自研、为什么零依赖、为什么只做错误路径） |

---

## 11. 当前状态与下一步

**已完成（本仓库可运行、可测试）**：调研 → 架构 → 自研实现 → 108 单测 + 30 项冒烟 → 管理看板 → 运维文档。

**已知边界（诚实清单）**：

- Anthropic / Gemini 原生协议只留了实现位，当前按 OpenAI 兼容处理；非 OpenAI 兼容上游会返回可归因错误而不是静默出错。
- 流式响应不做内容校验证明（HMAC 证明仅对可缓冲响应生效）；流式内容的 mid-stream 错误目前只记录在 transcript 里，尚未注入 SSE `error` 帧回传客户端。
- 未做分布式限流（多实例部署时限流/额度是每实例独立的）。需要时把 `Store.incrRate` / `quotaSnapshot` 换成 Redis 实现即可，接口已隔离。
- 模型路由的成本优化依赖 `providers[].cost` 配置；未配置时自动退化为优先级路由。
- 火山方舟的错误码口径未实证（研究 02 已列为已知空洞），归因走兜底规则。

**下一步优先级建议**：

1. 用真实上游跑 2~4 周，先把 P8 基线跑出来，再定 Pro 定价（研究 03 指出"降损省 40%"是高估）。
2. 补 Anthropic / Gemini 原生适配（若有客户确实需要）。
3. 客户端 SDK 薄封装：把 `retry_with_backoff` + `retryAfterMs` 变成一行 `autoRetry()`。
4. 误拦率实测：用 Dify / LangChain / openai-python 做"注入 400"对照实验（研究 03 的最不确定项）。
