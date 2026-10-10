# api-relay-final 只读代码质量审查报告

未修改任何文件。

## 硬读数（可执行面实测，非估算）

- `npm test` → exitCode 0，261 tests 全绿（16 文件），935 条断言
- `npm run typecheck` → exitCode 0（strict + noUncheckedIndexedAccess + noImplicitOverride 全开）
- `code-audit dup`(src 全量) → duplicateFileCount: 0，零重复文件
- `@ts-ignore` / `@ts-expect-error` / `eslint-disable` → 0 处
- production 代码 `any` → 0 处（51 处 any 全在 src/test/）

---

## 1. 上帝文件：逐个实测拆分建议

### [中] src/admin/dashboard.ts:31-3017（APP_SRC）+ 3031-3263（dashboardHtml）

**实测**：这不是职责混杂，是两个大字符串字面量被算进了行数。

- 31-3017 是一个 `export const APP_SRC = ...` 模板字面量（内嵌浏览器端 JS）
- 3031 起是 dashboardHtml() 返回的 HTML 模板（含 style CSS，约 2000 行）
- 真正的 TS 逻辑只有 appJs()(3020-3029) 一个函数 + 1 个 import

**结论**：行数虚高，但可维护性风险是真的——CSS/HTML/JS 三语挤在 .ts 里，任何改动都触发 TS 重编译，IDE 无法对模板内 JS 做类型检查/lint。

**建议**：APP_SRC → src/admin/app.src.js（真 .js 文件，构建期内联，可 lint 可类型检查）；CSS → src/admin/dashboard.css。dashboard.ts 降到约 200 行真 TS。**收益最大的一次拆分。**

### [中] src/gateway/engine.ts:130-1948

实测职责分层（按注释段，边界已经很清楚）：

- 173-840 handle() 主流程（auth → 度量 → 预检 → 阶梯重试 → 成功/失败）—— 660 行确实一个函数做太多事
- 841-931 档位阶梯 resolveLadder —— 独立纯逻辑，应抽 ladder.ts
- 932-1458 内部工具（parseBody / upstreamPath / rewriteBody / fingerprint / usage / verify）
- 1459-1807 响应构造（finishJson / applyAttribution / 错误响应 / aborted / noRoute）
- 1808-1948 模块级纯函数（authStatus / authReason / authRecoverable / isFatal / sleepUnlessAborted / headerSafe / rewriteJsonModel）

**建议**：先抽 1808-1948（纯函数零依赖最安全）→ engine/responses.ts；再抽 841-931 → ladder.ts；最后把 handle() 的 695-742 三个重试分支合成 decideNext()。engine.ts 可降到约 900 行。

**注意**：不要为拆而拆——932-1458 的工具函数与 handle() 共享大量 ctx 状态，强行抽离会变成传 8 个参数的坏抽象。

### [轻] src/store/index.ts:1564

**实测已按 Store 接口分层，不是混杂**：17-168 类型/SCHEMA；199-506 MemoryStore；507-580 内存事件；713-1114 SqliteStore（extends MemoryStore，复用内存实现做降级）；1115-1331 离线 SQL 聚合；1332-1530 key 元数据持久化。

这是一个类 + 一个子类 + 一段 SQL 的教科书结构。行数是 SQLite 建表/迁移/聚合 SQL 撑起来的。

**建议（可选）**：1115-1331 的 SQL 聚合块抽成 sqlite-stats.ts，用组合而非继承注入。优先级低。

### [轻] src/admin/api.ts:1326 —— 已经拆过了，不该算上帝文件

实测 204-213：buildRoutes() 已经把 28 条路由按业务域拆成 opsRoutes / providerRoutes / keyRoutes / configRoutes / evolutionRoutes / kbRoutes 六张小表（注释明确写原先是 handle 里 421 行的 switch）。1037 起是统一错误响应。

这是本次审查里最好的一处已完成的重构，不要动它。剩下的行数来自 28 个 handler 闭包体，属于天然体积。

---

## 2. 重复代码

### [中] src/gateway/engine.ts:695-742 —— 三处重试分支结构同构

699-707 / 719-727 / 733-741：三个分支都是「算 delay → trace.step('retry') → sleepUnlessAborted → if(aborted) break; continue」，只在 delay 上限（700 行多一个 ttfbTimeoutMs）、是否清 tried、trace 文案上差一行。

**建议**：抽 decideNext(failure, state) → {kind:'retry-same'|'ladder'|'retry-last'|'return', delayMs, traceMsg}，三个分支变成 switch。

### [中] src/admin/dashboard.ts:1061 / 1589 / 2561 —— CSV cell() 逐字重复 3 次

三处 const cell = (c) => {...} **字节级完全相同**（含 String.fromCharCode(10/13) 写法），且紧跟的「建 Blob → createObjectURL → a.click → revokeObjectURL → toast」导出流程也是同构复制，仅文件名与表头不同。

**建议**：抽 csvEscape(s) + downloadCsv(filename, head, rows) 两个顶层工具，三处各剩 3 行。

### [中] src/admin/dashboard.ts:2430 vs 2621 —— soft / opsSoft 近乎同构

soft(p,dflt,label) 与 opsSoft(p,dflt,label) 实现逐字相同，唯一区别是错误收集数组（diagFail vs opsFail）。

**建议**：抽 soft(p, dflt, label, failList) 一个函数，两处各传自己的数组。

### [轻] src/store/index.ts:944 / 1042 / 1084 / 1096 / 1109 / 1167 —— 六处降级三连

重复模式：catch(err) → this.lastError = err instanceof Error ? err.message : String(err) → return super.xxx(...)

**建议**：抽 private degrade(err, fallback) 包装器，每处剩 1 行。收益中等（6 处）。

---

## 3. 错误处理一致性

### 裸 catch 吞异常 —— 未发现

全库 124 个 catch 块逐个过目，没有一个是空的。每一处都有注释说明为什么吞：

- 「fail-open：归因层自身异常不得影响主流程」(loss/attribution.ts:496)
- 「fail-open：数据库不可用则退回纯内存，网关必须继续服务」(store/index.ts:758)
- 「列已存在」(store/index.ts:742 —— 迁移幂等)
- 「日志绝不能拖垮主流程」(core/logger.ts:68)

更难得的是有边界自觉：gateway/keys.ts:652 注释明确写「鉴权是安全边界，异常时 fail-closed 拒绝并归因 relay_internal_error」——区分了哪些层能 fail-open、哪些不能。这是专业级判断。

### 错误码不统一 —— 未发现

src/gateway/engine.ts:110-124 有唯一真源 ERROR_STATUS: Record<EngineErrorCode, number>，类型键约束保证新增错误码必须登记状态码。

且 119 行注释解释了「余额不足必须 402 而非 429，否则 SDK / Agent 框架自动重试会引发重试风暴」——这是踩过坑才写得出的注释。

**唯一小瑕疵 [轻]**：insufficient_quota 的命名未带 _error 后缀（其余均为 xxx_error），属命名风格，不影响正确性。

---

## 4. 类型安全

### any 滥用 / 类型断言逃逸 —— 未发现

- **production 代码 any = 0 处**。51 处 any 全部在 src/test/，且用途正当（43 处在 e2e.test.ts 里标注 JSON 响应的 .find((x: any) => ...) 回调参数，因响应体是运行时 JSON）
- @ts-ignore / @ts-expect-error / eslint-disable = **0 处** —— 这条比「没有 any」更难，说明作者没用过逃逸舱口
- tsconfig 开了 strict + noUncheckedIndexedAccess（最严那档），还能 typecheck 干净

**[轻] 建议**：src/store/index.ts:1128 的列名是字符串插值进 SQL 的——**已核验安全**（MeterDimension = model|provider_id|tier|client_kind 闭集联合类型，store/index.ts:21），非用户可控。但建议把列名改成 Record<MeterDimension,string> 查表，让「安全」从类型推导变成显式证据，未来加维度时不会有人塞进别的东西。

**[轻]** 120 处非空断言 !：分布合理（测试 55 处、yaml.ts 15、client.ts 10），多为 noUncheckedIndexedAccess 下的数组索引。不是逃逸，是该严格模式的正常代价。

---

## 5. 测试质量

### 空心断言 / 永远为真 —— 未发现（仅 1 处偏弱）

261 tests / 935 assertions，assert API 分布健康（equal 586 / ok 260 / deepEqual 53 / match 19 / throws 6 / notEqual 9）。

逐行扫过全部断言，只有 1 处偏弱：src/test/e2e.test.ts:854

  assert.ok(typeof t0.traceId === 'string' && Array.isArray(t0.steps) && t0.steps.length > 0);

只验形状不验内容，建议补一条 steps[0].stage === 'auth'。

反过来说，测试里能看到很强的判据意识（以实测用例名为证）：

- 「RingBuffer 未满时不会把空槽当成数据返回」
- 「模型名走原型链键：必须是 4xx + 报文干净，而不是 500 或泄漏 JS 内部结构」
- 「未知厂商返回 undefined」
- 「开关关闭：退回单阶阶梯（证明修复可逆）」
- 「真实模型名与别名不受影响（防止修复顺手改坏正常路径）」

这批用例名说明作者在防「自己改坏了」和「修复顺手改坏正常路径」，不是刷覆盖率。

**[轻]** 测试文件本身偏大：src/test/engine.test.ts 1418 行 / e2e.test.ts 1128 行。建议按被测特性再分文件，但这是组织问题不是质量问题。

---

## 6. 顺带发现（不在委派五类里，但值得知道）

### [中·性能] src/store/index.ts:1147-1153 —— N+1 查询

dimensionStats() 在 for 循环里对每个分组 key 单独 prepare + get 一次 p95 子查询。窗口内若有 N 个模型就是 N+1 次 SQL 往返，且每次都要全表 COUNT(*)*0.95。

**建议**：用窗口函数（NTILE / ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY duration_ms)）一次查出全部分组 p95；或接受分组内近似 p95 用单次查询。SQLite 3.25+ 支持窗口函数。

### [轻·仓库卫生]

仓库根目录散落 17 个 .db、14 个 .gz、多份 .bak-2026xxxx 备份文件与 3 个 .pid。开源前建议：

- .gitignore 加 *.db *.db-shm *.db-wal *.pid *.gz *.bak-*
- 清理已入库的历史备份
- **扫一遍 .env / .conf / .key 是否入过库**（仓库里确实有 .crt/.key 各 1 份与 2 个 .env）——开源前这一步不能省

---

## 已知未覆盖的面

- 未逐函数通读 upstream/client.ts(1093) / gateway/keys.ts(946) / loss/precheck.ts(778)，只对它们做了 catch 块与类型面的机械扫描
- 未做安全渗透测试（不属本次委派范围；仅核验了 SQL 列名插值的闭集安全性）
- 未做性能压测，N+1 结论来自代码静态阅读，未实测验证耗时

---

## 总体质量评价

这是作者第一个开源作品的话，我的诚实评价是：它的**工程纪律明显强于它的代码组织**——错误处理有明确的 fail-open/fail-closed 边界自觉、错误码有类型保障的唯一真源、261 个测试全绿且几乎没有空心断言、strict + noUncheckedIndexedAccess 下零 any 零 ts-ignore，这四点很多开源三五年的项目都做不到；真正的短板只有「文件太大」这一件事，而其中 dashboard.ts 的 3263 行里绝大部分是内嵌的 HTML/CSS/JS 字符串而非逻辑——把这三个字符串拆成真文件，这个仓库的第一印象会立刻从「新手堆代码」变成「老手写得急」。