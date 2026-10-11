# 贡献指南（CONTRIBUTING）

感谢你考虑为 api-relay 贡献代码。本项目对「工程纪律」的要求高于对「功能数量」的要求——
下面几条是仓库里已经写进代码与测试的约定，提 PR 前请先对齐。

## 开发环境

- Node.js **≥ 22.5**（用到 `node:sqlite`，见 `package.json` 的 `engines`）
- 零运行时依赖：只用 `node:http` / `node:crypto` / `node:sqlite` 等内置模块。
  **新增第三方运行时依赖需要先在 issue 里说明理由**——这是本项目的核心卖点之一。

## 本地工作流

```bash
npm install
npm run build        # tsc 编译到 dist/
npm test            # 编译后跑 node --test（269 项，要求全绿）
npm run verify:frontend  # 校验前端 min 产物未过期（见下）
npm run typecheck   # strict 模式下 0 错误
```

提交前请保证 `typecheck`、`verify:frontend`、`test` 全过。CI（`.github/workflows/ci.yml`）会自动跑同样流程。

## 改了管理面板后必须做的事

`src/admin/dashboard.ts` 里的 `APP_SRC` 是内联的浏览器端脚本，
另有 `src/admin/dashboard-app-min.ts` 是它的压缩版，由 `src/admin/gen-app-min.mjs` 生成，
并用 sha256 做新鲜度校验（`appJs()`：不匹配时自动回落源码，永不服务过期页面）。

> ⚠ **改完 `dashboard.ts` 的 `APP_SRC` 必须重跑：**
> ```bash
> npm run build && node src/admin/gen-app-min.mjs
> ```
> 否则 `dashboard-app-min.ts` 过期，压缩收益静默失效（本项目真实发生过，已用 `verify:frontend` 门禁堵住）。

## 代码风格约定（仓库已有，请延续）

- TypeScript **strict** + `noUncheckedIndexedAccess` + `noImplicitOverride` 全开；
  **禁止 `@ts-ignore` / `@ts-expect-error`**（当前 0 处），类型问题请改类型而不是压制。
- **fail-open 与 fail-closed 分清边界**：日志、非安全路径可 fail-open；
  鉴权、密钥相关必须 fail-closed（见 `src/admin/auth.ts`、`src/gateway/keys.ts`）。
- 错误语义要可执行：上游 429 → `retry_with_backoff + retryAfterMs`；
  余额不足 → **402 而不是 429**（避免 SDK 自动重试风暴）。见 `src/gateway/engine.ts` 的 `ERROR_STATUS`。
- 日志敏感字段自动脱敏（`src/core/logger.ts` 的 `redact()`），新增日志字段时别绕过它。

## 提 PR

- 分支基于 `main`，PR 标题说明「做了什么 / 为什么」而非「改了什么文件」。
- 测试是硬要求：新增逻辑请带测试，尤其是失败路径与「修复顺手改坏正常路径」的回归用例。

## 报告安全问题时请看 [SECURITY.md](SECURITY.md)，不要开公开 issue。

---

> 本项目起源于个人「模型 API 二转」实践，许多设计来自真实踩坑（见 `docs/research/`）。
> 欢迎把你的上游适配经验也以 issue 形式回馈。
