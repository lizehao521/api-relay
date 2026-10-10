# 部署与运维手册

> 面向把这套东西跑在生产上的人。包含：部署方式、配置全表、容量与安全、日常运维、故障排查。

---

## 1. 依赖与运行环境

| 项 | 要求 |
|---|---|
| Node.js | **≥ 22.5.0**（`node:sqlite` 需要；`--disable-warning=ExperimentalWarning` 用于抑制该模块的实验性告警） |
| 操作系统 | Linux / macOS（Windows 未验证；`node:sqlite` 与信号处理行为可能有差异） |
| 运行时依赖 | **无**。不需要 `npm install --production` |
| 构建依赖 | typescript、@types/node（仅构建期） |
| 磁盘 | SQLite 数据文件 + WAL；按度量明细量估算（约 300 B/请求） |
| 网络出站 | 到各上游 API 的 HTTPS |

---

## 2. 部署

### 2.1 直接跑（最简单）

```bash
git clone <repo> && cd api-relay
npm install          # 只装编译器
npm run build
node dist/cli.js init                 # 生成 config/relay.yaml
$EDITOR config/relay.yaml             # 填上游与客户端 key
export DEEPSEEK_API_KEY=sk-...
export RELAY_ADMIN_TOKEN=$(openssl rand -hex 24)
node dist/cli.js check                # 部署前必跑：校验配置 + 列出缺失的 env
node dist/cli.js serve
```

### 2.2 systemd

```ini
# /etc/systemd/system/api-relay.service
[Unit]
Description=api-relay (OpenAI-compatible LLM gateway with transmission-loss-reduction)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=relay
WorkingDirectory=/opt/api-relay
EnvironmentFile=/etc/api-relay/env          # 存放所有密钥，权限 600
ExecStartPre=/usr/bin/node dist/cli.js check
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning dist/cli.js serve
Restart=always
RestartSec=2
# 优雅退出：引擎会 flush 度量、关闭数据库
KillSignal=SIGTERM
TimeoutStopSec=15
# 安全加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/api-relay/data
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

### 2.3 容器

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY config ./config
ENV NODE_ENV=production RELAY_CONFIG=/app/config/relay.yaml RELAY_DB_PATH=/data/relay.db
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=20s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
USER node
CMD ["node","--disable-warning=ExperimentalWarning","dist/cli.js","serve"]
```

> 镜像里没有 `node_modules`——运行时零依赖是这套架构的一个实际收益（更小的攻击面、更少的供应链风险）。

### 2.4 反向代理要点

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    # 流式响应必须关闭缓冲，否则 SSE 会被攒成一坨
    proxy_buffering off;
    proxy_cache off;
    proxy_set_header Connection "";
    proxy_read_timeout 900s;        # 长推理
    proxy_send_timeout 900s;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

配套设置 `server.trustProxy: true`（或 `RELAY_TRUST_PROXY=1`），否则所有请求的 IP 都会是代理 IP。

### 2.5 让外部网络的用户能用（按当前这台机器的实情）

先说清楚一件事：**面板能生成 key，但"外部网络可达"是网络与部署的事，不是 key 能决定的。**
key 只解决"你是谁"，可达性解决"能不能连上"。两者都要有，外网用户才真的能用。

这台机器现在的情况（实测）：

| 项 | 现状 |
|---|---|
| 局域网地址 | `192.168.2.116`（网关 `192.168.0.1`，即位于 NAT 之后） |
| 公网 IP | 无 |
| 内网穿透工具 | `tailscale`（主入口 Funnel）+ `cloudflared`（兜底快隧道）在跑；frpc/ngrok 未用 |
| 出网 | 通（能访问公网 HTTPS） |
| 监听 | `:::8787`（双栈；**别写 0.0.0.0** —— 那是纯 IPv4，公网 IPv6 连不进来，2026-09-14 实测踩过） |

**实测更新（已按这条路打通）**：`server.host` 改成 `"::"`（双栈）后，本机同时接受
IPv4（`192.168.2.116`）与公网 IPv6（`240e:974:1e00:307:6a::36`），公网 IPv6 上
`/healthz` 与真实调用都通。但**从互联网能不能进来还没证实**：本机在 NAT 之后，
入站受云安全组管辖（机器内部看不到、也改不了），而常用的外部探测服务
（check-host.net / hackertarget）**都不支持 IPv6 目标**，所以无法自查。
要用 IPv6 的话，需要你在云控制台放通 `8787/tcp`，然后**用手机流量**（蜂窝网络有 IPv6）
打开 `http://[240e:974:1e00:307:6a::36]:8787/healthz` 验证一次。

因此当前**真正可用的外网入口是隧道**（出站连接，绕过 NAT 与安全组，自带 HTTPS）。
**主入口是 Tailscale Funnel（固定地址，客户零配置）**，快隧道只作兜底：

```bash
bash scripts/start-funnel.sh status   # 主入口：打印固定地址（也在 .relay-funnel-url）
bash scripts/start-tunnel.sh start    # 兜底：打印公网地址，地址存在 .relay-tunnel-url
bash scripts/start-tunnel.sh status   # 兜底自检（含"从公网地址回连一次"）
```

quick tunnel 的地址是**随机的、随进程存活**，Cloudflare 不保证可用率；
要固定域名请用 named tunnel（`cloudflared tunnel login` + `tunnel create`）。
所以长期方案仍是下面三条里挑一条：

1. **隧道（最省事，推荐先走这条）**：出网是通的，所以不用碰路由器、也不需要公网 IP。
   ```bash
   cloudflared tunnel --url http://127.0.0.1:8787    # 立刻得到一个公网 https 地址
   ```
   缺点：随机域名、随进程存活；要固定域名需要 Cloudflare 账号里建 named tunnel。
2. **端口映射 + 反向代理**：需要运营商给到公网 IP + 在 `192.168.0.1` 上做映射 + nginx 上证书（见 §2.4）。
   国内家宽多数没有公网 IPv4，这条路常常走不通。
3. **部署到公网 VPS**：最可控，但要迁移部署与数据。

**上线前必须做的三件事**（少一件都会出事）：

- **必须 TLS。** 客户端 key 是放在 `Authorization` 头里传的，明文 HTTP 等于把 key 公开发布。
  用隧道时 HTTPS 是自动的；自己反代就得上证书。
- **必须设 `server.adminToken`。** 没有它，管理接口只认本机来源——这既是保护也是限制：
  你在别的机器上就打不开面板（见 ADR-017 对"看板外壳免鉴权"的说明）。
- **别打开 `publicQuotaRemote`。** `/v1/quota` 与 `/v1/panel` 会暴露用量与轨迹，默认只允许本机读。

发布后按这个清单验一遍（都是"外网用户视角"能做到的请求）：

```bash
BASE=https://<你的对外地址>
curl -s -o /dev/null -w '%{http_code}\n' $BASE/healthz                     # 200
curl -s -o /dev/null -w '%{http_code}\n' $BASE/admin                       # 200（登录门外壳）
curl -s -o /dev/null -w '%{http_code}\n' $BASE/admin/api/overview          # 401（数据必须挡住）
curl -s -o /dev/null -w '%{http_code}\n' $BASE/v1/chat/completions         # 401（没 key 必须挡住）
curl -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $RELAY_EXTERNAL_KEY" -H 'content-type: application/json' \
  -d '{"model":"mimo-v2.5","messages":[{"role":"user","content":"你好"}],"max_tokens":32}'   # 200
```

给外部用户的凭据用面板生成（「客户 Key」→「+ 新建 Key」），**明文只显示一次**；
生成后建议单独落一个 `chmod 600` 的文件（本仓库用 `.relay-external-key.txt`，已 gitignore），
丢了就在面板里「轮换」。

---

## 3. 配置全表

配置文件是 **YAML 子集**（自研解析器，零依赖；支持注释、嵌套、序列、行内 map/array、块标量，**不支持 Tab 缩进与锚点**）。
所有密钥必须用 `{ENV:NAME}` 或 `{ENV:NAME:-默认值}` 插值；缺失的必需变量会导致启动失败（除了 `relay check` 的宽松模式）。

### 3.1 server

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 监听地址。对外服务用 `::`（双栈，见 §对外入口现状 —— 本机没有公网入站路径，对外全靠出站隧道，TLS 由隧道层终结） |
| `port` | `8787` | 端口 |
| `adminToken` | 无 | 未设置时管理接口仅接受本机（127.0.0.1/::1）请求。**生产必须设置**，建议 ≥ 24 字符随机 |
| `trustProxy` | `false` | 是否信任 `X-Forwarded-For`。仅在确有可信反代时开启 |
| `maxBodyBytes` | 8 MiB | 请求体上限，超出返回 413 |
| `upstreamTimeoutMs` | 600000 | 上游总超时 |
| `upstreamTtfbTimeoutMs` | 120000 | 上游**首字节**超时（"接了但不吐字"是最常见的恶性故障） |
| `shutdownGraceMs` | 8000 | SIGTERM 后的优雅退出等待 |

### 3.2 storage

| 字段 | 默认 | 说明 |
|---|---|---|
| `driver` | `sqlite` | `sqlite` 或 `memory`（memory 重启丢历史，适合测试） |
| `path` | `data/relay.db` | SQLite 路径；WAL 模式；`dir` 会自动创建 |

### 3.3 lossReduction（降损层）

| 字段 | 默认 | 说明 |
|---|---|---|
| `precheck.enabled` | `true` | 总开关 |
| `precheck.onBlock` | `reject` | `reject` 返回 400；`observe` 只记录（灰度期建议 observe） |
| `precheck.budgetUs` | `3000` | 单次预检耗时上限（微秒），超出立即放行。`0` = 不限制 |
| `precheck.maxMessages` | `4096` | messages 条数上限（2026-09-14 从 512 放宽，见 ADR-022） |
| `precheck.maxTools` | `128` | 工具声明数上限（超出为 warn） |
| `precheck.dangerousCommandPatterns` | 8 条 | 危险命令正则（**只**对 shell 类工具的 arguments 生效） |
| `attribution.enabled` | `true` | 总开关 |
| `attribution.includeEvidence` | `false` | 是否在归因卡片里返回 `evidence`（含上游 message 片段）。对外建议保持 false |
| `attribution.autoRetry` | `1` | 可恢复错误的自动重试次数 |
| `attribution.backoffBaseMs` / `backoffMaxMs` | 400 / 8000 | 指数退避基数与上限（带抖动） |
| `attribution.retryableReasons` | 6 类 | 允许自动重试的归因（限流/超时/5xx/网络/过载/流中断） |
| `attribution.breakerThreshold` | `5` | 连续失败多少次熔断上游 |
| `attribution.breakerCooldownMs` | `30000` | 熔断冷却时长（到期半开试探） |
| `meter.enabled` | `true` | 度量开关 |
| `meter.batchSize` / `flushIntervalMs` | 200 / 2000 | 批量落库参数 |
| `meter.retentionDays` | `30` | 明细保留天数（`relay prune` 或定时任务清理） |
| `meter.hashPayloads` | `true` | 是否计算 payload 哈希（用于重复检测）。关闭可减少 CPU |
| `meter.hashSalt` | 自动派生 | HMAC 盐。**多实例必须配同一个 `RELAY_HASH_SALT`**，否则指纹不可比 |
| `trace.enabled` / `ringSize` / `persist` / `maxSteps` | true / 500 / true / 64 | 轨迹 |

### 3.4 tiers（分层策略）

每层字段：`precheck`（off/observe/enforce）、`attribution`（off/header/full）、`meterDetail`、
`smartRouting`、`rpm`、`maxConcurrency`、`billing`、`periodQuotaTokens`、`priority`。

默认值见 `README.md` §7。**建议**：先把 `standard` 与 `pro` 都设为 `observe`，跑一周看误拦率，再切 `enforce`。

### 3.5 providers

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识（出现在度量与看板里） |
| `protocol` | `openai`（默认）/ `anthropic` / `gemini`（后两者当前回落 OpenAI 兼容行为） |
| `baseUrl` | 例如 `https://api.deepseek.com/v1` |
| `apiKey` | 单 key（`{ENV:...}`） |
| `apiKeys` | 多 key 池，轮换使用。与 `apiKey` 并用时取并集 |
| `models` | 该上游支持的模型名列表（决定可达性；预检按此校验） |
| `modelMap` | 模型别名 → 上游真实名 |
| `cost` | `{inputPerMTok, outputPerMTok, cachedInputPerMTok?}`，人民币元/百万 token。用于成本统计与 smart routing |
| `weight` / `priority` | 路由排序权重与优先级 |
| `timeoutMs` / `concurrency` | 单上游超时与并发上限 |
| `tags` | 自由标签（`cn`、`cheap`、`official`…），供路由约束与看板分组 |
| `disabled` | 静态摘除 |
| `headers` | 该上游需要的额外请求头 |

### 3.6 clients

| 字段 | 说明 |
|---|---|
| `id` / `label` | 标识与展示名 |
| `key` | 客户端 key 明文（`{ENV:...}`）。进程内只保留 sha256 索引 |
| `tier` | `free` / `standard` / `pro` |
| `tenantId` | 租户归属（用于聚合与对账） |
| `enabled` | 开关 |
| `allowedModels` | 允许的模型白名单（空 = 全部） |
| `quotaOverride` | 覆盖分层默认额度（token/周期） |
| `expiresAt` | 到期时间戳（ms） |

### 3.7 环境变量（覆盖配置文件）

| 变量 | 作用 |
|---|---|
| `RELAY_CONFIG` | 配置文件路径 |
| `RELAY_HOST` / `RELAY_PORT` | 监听地址/端口 |
| `RELAY_ADMIN_TOKEN` | 管理令牌 |
| `RELAY_DB_PATH` / `RELAY_STORAGE_DRIVER` | 存储 |
| `RELAY_LOG_LEVEL` | `debug`/`info`/`warn`/`error` |
| `RELAY_TRUST_PROXY` | `1` 开启 |
| `RELAY_PRECHECK_ENABLED` / `RELAY_ATTRIBUTION_ENABLED` / `RELAY_METER_ENABLED` / `RELAY_TRACE_ENABLED` | 降损层各模式的紧急开关 |
| `RELAY_HASH_SALT` | HMAC 盐（多实例必须一致） |
| 各上游密钥 | 例如 `DEEPSEEK_API_KEY`、`SILICONFLOW_API_KEY`（名字由配置里的 `{ENV:...}` 决定） |

---

## 4. 容量与性能

### 4.1 单实例容量参考

| 负载 | 说明 |
|---|---|
| 非流式短请求 | 网关自身开销 ~1 ms（含预检+归因+度量入队） |
| 流式长响应 | 网关只做字节日转发，开销近零；连接数才是瓶颈 |
| 并发上限 | 由 `tiers.*.maxConcurrency` 与 `providers[].concurrency` 双重约束 |
| 数据库写入 | 批量 200 条 / 2 秒一次；10k QPS 下写入压力约 5k 行/秒（SQLite 可承受，但建议 `retentionDays ≤ 30`） |
| 内存 | 度量内存镜像最多保留 5 万条；轨迹环默认 500 条；滑窗计数有上限键数 |

### 4.2 水平扩展

- **无状态部分**（转发、预检、归因、路由）可以随意多实例 —— 前提是降损层不引入会话状态（本设计正是如此）。
- **有状态部分**：限流计数、额度、熔断状态目前是**每实例独立**的。
  影响：多实例时限流不够精确（N 个实例 ≈ N 倍 rpm），额度可能被小幅超用。
  需要精确控制时：把 `Store` 换成 Redis 实现（接口 `incrRate`/`quotaSnapshot`/`record` 已隔离）。
- **数据库**：多实例共享同一个 SQLite 文件是**不推荐**的（WAL 支持并发读但写会串行化）。
  多实例请各自独立 DB，或换 PostgreSQL/ClickHouse 实现 `Store`。

### 4.3 压测建议

```bash
# 先起 mock 上游再压，避免烧真实额度
npm run mock &
# 用 oha / wrk / k6 打 /v1/chat/completions
oha -z 30s -c 50 -m POST \
  -H 'authorization: Bearer sk-relay-pro-demo' -H 'content-type: application/json' \
  -d '{"model":"mock-small","messages":[{"role":"user","content":"hi"}]}' \
  http://127.0.0.1:8787/v1/chat/completions
# 然后看看板的"降损层开销占比"，应 < 0.1%
```

---

## 5. 日常运维

| 任务 | 命令/接口 |
|---|---|
| 健康检查 | `curl /healthz`（有熔断或存储降级时 `status=degraded`） |
| 看疗效 | `node dist/cli.js report --window 24h` 或看板 |
| 看某个模型的通达性 | `node dist/cli.js catalog` |
| 排障某次请求 | 拿响应头 `x-request-id` → 看板"最近请求轨迹"，或 `node dist/cli.js trace <traceId>` |
| 对比两次失败 | `GET /admin/api/traces/<id>?diff=<otherId>` |
| 摘除坏上游 | `POST /admin/api/providers/toggle {"id":"x","disabled":true}` |
| 恢复熔断 | `POST /admin/api/providers/reset {"id":"x"}` |
| 清理过期明细 | `node dist/cli.js report` 之后按需调用 `Store.prune(retentionDays)`（建议配 cron） |
| 轮换上游密钥 | 改环境变量 → 重启（配置在启动时装载） |
| 紧急关闭降损层 | `RELAY_PRECHECK_ENABLED=0 RELAY_ATTRIBUTION_ENABLED=0` 重启；或把某层的 `precheck/attribution` 设为 `off` |

### 5.1 面板应急操作（不用登机器）

生产环境把面板挂在 `https://<域名>/admin`（记得设 `adminToken`），以下操作都能点出来：

| 场景 | 面板操作 |
|---|---|
| 某上游开始大批 401（密钥被上游吊销） | 上游页 → 该上游「摘除」；流量立刻切走 |
| 误拦率突然升高，怀疑预检误判 | 配置与事件页 → 关掉「P2 调用前预检」；即时生效 |
| 给客户加一个试用 key | 客户 Key 页 → 新建 Key → 选层/限额 → 复制明文（只显示一次） |
| 客户 key 疑似泄露 | 客户 Key 页 → 「轮换」（旧 key 立即失效）或「禁用」 |
| 客户额度用完但要走完今天的活动 | 客户 Key 页 → 「重置额度」（历史度量保留，可审计） |
| 上游抖动导致熔断，但确认已恢复 | 上游页 → 「清熔断」 |
| 想知道"昨晚谁把上游摘了" | 配置与事件页 → 运维事件流 |

面板的写操作全部落 `relay_event` 表，因此**事后审计不需要额外的日志系统**。

### 5.2 灰度上线的推荐顺序

1. `storage.driver=sqlite`，`free/standard/pro` 全部 `attribution=off`，先当**纯转发**跑通业务。
2. 打开 `meter`，观察 1~2 周，建立 P8 基线（失败分布、重复请求、p95）。
3. `standard` 开 `attribution=header`、`precheck=observe`（只记录不拦），观察误拦率。
4. 误拦率 < 1% 后，`pro` 开 `precheck=enforce` + `attribution=full`。
5. 有真实收益数据后，再评估 `smartRouting`。

---

## 6. 安全

| 面 | 措施 |
|---|---|
| 客户端 key | 只存 sha256；进程内明文 key 只短暂存在于请求头 |
| 上游 key | 仅存于配置/环境变量与内存；日志经 `redact()` 脱敏；管理接口返回时打码 |
| 管理接口 | `adminToken` + 常数时间比较；未设置时仅本机。**看板外壳与 `/v1/panel` 免鉴权**（ADR-017），数据接口需令牌 |
| 请求体 | 上限 `maxBodyBytes`；解析失败即 400，不做任何"尽力猜" |
| 危险命令 | 预检黑名单（可配置），**只对 shell 类工具**，且默认只拦不动手 |
| 上游身份泄露 | 不透传上游 baseUrl/密钥；只透传白名单响应头 |
| 内容安全 | **不做**服务端内容审查（避免"我审你内容"的信任与合规问题）；免费层靠限速与模型白名单控制滥用 |
| 数据合规 | 不落正文（红线 6）；可设保留期；提供删除能力（`Store.prune`）；轨迹含错误摘要需在用户协议中告知 |
| DoS 面 | 每层 rpm/并发、每上游并发、每 key 并发、请求体上限、预检预算上限 |
| 时序侧信道 | 管理令牌与 key 比较用常数时间 |

**未做但需要时该做**：TLS 终止在反代（应用内不实现 TLS）；IP 级全局限流；WAF/内容风控；审计日志外部留存。

---

## 7. 故障排查

| 现象 | 可能原因 | 检查 |
|---|---|---|
| 启动即失败 | 配置错误 / 缺环境变量 | `node dist/cli.js check`（会列出缺失变量）；看 stderr |
| `503 no_route` | 所有上游都被禁用/熔断/未声明该模型 | `GET /admin/api/providers` 看 `reachability` 与 `disabled` |
| 用户说"模型不存在"但上游明明有 | 上游 `models` 列表没加该模型 → 预检拦了 | `relay catalog`；把模型加进 `providers[].models` |
| 大量 `401` 归因 | 上游密钥失效 | 看板 `byFailureReason` 里 `auth_invalid` 的 provider |
| 大量 `quota_exhausted` | 上游余额不足或触发 402 | 上游后台充值；或把该上游 `disabled` |
| 流式响应"卡住不吐字" | 上游 TTFB 超时（引擎会按 `upstream_timeout` 归因） | 调大 `upstreamTtfbTimeoutMs`；或换上游 |
| 看板数据为 0 但请求在跑 | 存储降级为内存 / flush 失败 | `GET /healthz` 看 `store.ok` 与 `degradedEvents`；查日志 `store.sqlite.flush_failed` |
| `precheckDegraded` 不为 0 | 预检在 fail-open（可能预算太小或代码 bug） | 调大 `precheck.budgetUs`；查日志 |
| 归因投递率低 | 有失败模式没被规则覆盖 | 看板 `byFailureReason` 里 `unknown` 的占比 → 补 `RULES` |
| 单实例限流不准 | 多实例部署，计数是每实例的 | 见 §4.2，换 Redis Store |
| 重启后 trace 查不到 | 轨迹落库失败或超过保留期 | `lossReduction.trace.persist`；`retentionDays` |
| SSE 被攒成一坨才返回 | 反代开了缓冲 | `proxy_buffering off`；确认 `x-accel-buffering: no` 已透传 |

**排障的三个入口**（按代价从低到高）：
1. `GET /healthz` —— 30 秒判断是"整体病了"还是"某个上游病了"。
2. 看板 `byFailureReason` + `byProvider` —— 定位到具体上游/具体失败模式。
3. `traceId` 时间线 —— 定位到具体请求卡在哪一步。
