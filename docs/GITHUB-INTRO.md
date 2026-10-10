## GitHub 仓库 About（填在仓库页面右上角 ⚙）

| 字段 | 内容 |
|---|---|
| Description | 模型 API 聚合中转网关：OpenAI 兼容 + 多上游自动降级，把上游错误翻译成 Agent 可执行的动作。零运行时依赖，269 测试全通过。 |
| Website | 留空，或填你的部署地址 |
| Topics | `openai` `api-gateway` `llm` `proxy` `typescript` `nodejs` `llmops` `zero-dependency` `model-router` `agent` |

---

## 给仓库的一句话介绍（README 开头用）

> **api-relay** 是一个 OpenAI 兼容的模型 API 聚合网关。它不卖 token，卖的是「错误对 Agent 可执行」——
> 成功响应逐字节透传，失败响应翻译成 `rate_limited → retry_with_backoff + retryAfterMs` 这样的可执行动作。
> 零运行时依赖（只用 Node 内置模块），19,966 行 TypeScript，269 项测试全通过。

---

## 发朋友圈/推文的版本

**短版（140 字内）**：

把我的第一个项目开源了：api-relay，一个 OpenAI 兼容的 LLM API 聚合网关。
核心不是转发，是「错误翻译」——上游 429 不再是 429，而是带 retryAfterMs 的可执行动作；
余额不足直接给 402 + top_up_balance，明确告诉你别重试。
零运行时依赖，269 个测试全通过。MIT。

**长版（技术社区）**：

**api-relay：一个把「传话层降损」建在核心链路里的 LLM 网关**

做二转的时候踩过一个坑：上游返回 429，你原样丢给客户，客户只能瞎重试。
所以这个项目的定位是——成功响应一个字节都不碰，失败响应必须翻译成可执行的下一步。

三个设计点：
1. **分层降级**：免费层纯管道（错误体零附加），Pro 层开预检+归因。不是所有客户都要为降损付费。
2. **档位阶梯**：竖向沿能力阶梯换模型、横向换供应商。客户只写一个名字，被限流了自动往下推。
3. **零运行时依赖**：只用 node:http / node:crypto / node:sqlite。供应链风险≈0，audit 干净。

踩过的真坑也写进文档了（比如某厂商 Authorization 不带 Bearer 前缀，带上反而 401）。

269 项测试，MIT 许可。

