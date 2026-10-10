# 维护手册（api-relay）

> 这份文档只讲**日常怎么维护**。设计取舍见 `ARCHITECTURE.md` / `DESIGN.md`，
> 每个决策的来龙去脉见根目录 `DECISIONS.md`，对外怎么交付见 `DEPLOYMENT.md`。

---

## 0. 这套系统由什么组成（"我管着什么"清单）

**先跑这一条** —— 它自检下面清单里的每一项，并且会指出哪一环静默失效了：

```bash
cd "/home/ctyun/文档/二转厂商单模型/api-relay"
bash scripts/ops-check.sh          # 退出码 0 = 全部正常
```

### 目录约定（2026-09-14 整理）

```
项目根/      ← 只放"人敲的门"
  start-net.sh      启停网关（start|stop|restart|status）
  demo.sh           一行体验（mock 上游 + 网关，不需要密钥）

scripts/     ← 机器跑的 / 专项工具
  keepalive.sh     守护：健康检查驱动 + 每日备份 + 兜底隧道（cron @reboot 拉起）
  start-tunnel.sh  兜底快隧道（cloudflared quick tunnel，由 keeper 调）
  start-funnel.sh  **主入口**：Tailscale Funnel 固定地址（cron @reboot 拉起）
  watch.sh         监控：每 30s 看阶梯换路与公网入口，异常才记日志
  ddns-dynv6.sh    维护 dynv6 的 A / AAAA 记录（cron 每 5 分钟）
  db_backup.sh     SQLite 一致性备份 + integrity_check（keeper 每 24h 调）
  smoke.sh         冒烟：30 项真实进程端到端（用 18787 端口，不碰线上）
  ops-check.sh     运维自检（cron 每天 09:00，也可随时手跑）
  setup-v6-tls.sh  备用方案：nginx + Let's Encrypt IP 证书（当前未启用）
```

### 组件一览

| 组件 | 谁拉起它 | 它挂了会怎样 | 怎么查 |
|---|---|---|---|
| 网关进程 | `start-net.sh` ← keeper | 全部请求失败 | `./start-net.sh status` |
| keeper 守护 | cron `@reboot` | **挂了没人自愈**（最危险） | `cat logs/.keepalive.pid`；`ops-check` |
| 主入口 Funnel | cron `@reboot`（`start-funnel.sh`） | 客户连不上 | `bash scripts/start-funnel.sh status` |
| 兜底快隧道 | keeper（`start-tunnel.sh`） | 少一条退路（主入口还在就没事） | `cat .relay-tunnel.pid` |
| 监控 watch | cron `@reboot` | 出问题没人记日志 | `tail logs/watch.log` |
| DDNS dynv6 | cron 每 5 分钟 | 用该域名的人连到旧地址 | `bash scripts/ddns-dynv6.sh --force` |
| 账务备份 | keeper 每 24h | 数据丢了无法恢复 billing | `ls -lt data/backups/ \| head` |

**⚠ 认进程只认 pidfile，别用 `pgrep -f keepalive`**：本机还有姊妹项目
（`/home/ctyun/文档/二转moa模型`）的守护叫 **`rg-keepalive.sh`**，名字里同样含
`keepalive.sh` —— `pgrep`/`pkill -f keepalive` 会把它一起匹配上，**照它去 kill 就会
杀掉另一套系统的守护**。2026-09-14 实测过：第一个命中就是别人家的。
本项目 keeper 会写 `logs/.keepalive.pid`，用它。

---

## 1. 它是怎么活的

```
cron @reboot ──► scripts/keepalive.sh（守护，每 10s 一轮）
                   ├─ 进程不在 / 健康检查连续 2 次不过 ──► ./start-net.sh start
                   ├─ 兜底隧道不在 ──► scripts/start-tunnel.sh start（后台 + 限频 60s）
                   ├─ 每 24h ──► scripts/db_backup.sh（账务库一致性备份）
                   └─ 自己日志超 10MB ──► 轮转

cron @reboot ──► scripts/start-funnel.sh   ← 主入口（固定地址，客户零配置）
cron @reboot ──► scripts/watch.sh          ← 监控
cron 每 5 分钟 ─► scripts/ddns-dynv6.sh
cron 每天 09:00 ► scripts/ops-check.sh
```

```
start-net.sh ──► node dist/cli.js serve --config relay-net.yaml  (监听 *:8787)
```

**2026-09-13 的教训**：那天机器重启，本网关因为**没有开机自启**而静默失联 14 小时；
同时日志写在 `/tmp`，重启后被清空，事后无从定位。这两点都已修掉。

---

## 2. 日常巡检（30 秒）

```bash
cd "/home/ctyun/文档/二转厂商单模型/api-relay"
bash scripts/ops-check.sh             # 一条命令覆盖下面全部
```

想看细节时：

```bash
./start-net.sh status                 # 进程 + 健康
tail -20 logs/keepalive.log           # 守护最近做了什么（有没有频繁重启）
ls -lt data/backups/ | head -3        # 备份是否新鲜
```

管理面板：<http://127.0.0.1:8787/admin>

| 页签 | 什么时候看 |
|---|---|
| 总览 / 指标 | 健康吗、降损层在起作用吗 |
| 客户 Key | 发 key、改额度、轮换、吊销 |
| 上游 | 熔断状态、模型 × 上游可达性 |
| 请求账本 | 某一次请求到底卡在哪一步（步骤时间线） |
| **排障** | **出事第一站**：事件日志 / 鉴权失败指纹 / 归因目录 |
| **运维** | **"现在到底按什么参数在跑"**：生效配置 / 降损开关 / 分层策略 / 文本报告 |
| 信任 | 对客户的设计承诺与自证方式 |

- 令牌：持久来源是 `.relay-net.env` 里的 `RELAY_ADMIN_TOKEN`。
  `/tmp/admin-token.txt` **不是重启就没了** —— `start-net.sh` 每次启动都会用
  `$RELAY_ADMIN_TOKEN` 重写它（见脚本里 `printf ... > "$TOKENFILE"`），
  所以重启后两者始终一致；改令牌只需改 `.relay-net.env` 再重启。
  轮换实录（2026-10-02）：改 `.relay-net.env` → `./start-net.sh restart` →
  旧令牌立即 401、新令牌 200（X-Admin-Token 与 Bearer 两种形式都验过）。
- **「运维」页的「生效配置」是排查参数类问题的第一现场** ——
  2026-09-14 两次误杀（首字节超时、消息条数上限）都是因为生效值只能去翻配置文件才看得见。

---

## 3. 常用操作

| 目的 | 命令 |
|---|---|
| 启停网关 | `./start-net.sh {start\|stop\|restart\|status}` |
| 运维自检 | `bash scripts/ops-check.sh` |
| 起守护 | `setsid nohup bash scripts/keepalive.sh >/dev/null 2>&1 &` |
| 停守护 | `kill "$(cat logs/.keepalive.pid)"`（**别用 `pkill -f keepalive`**，会打到姊妹项目） |
| 立即备份 | `bash scripts/db_backup.sh` |
| 跑测试 | `npx tsc -p tsconfig.json && node --disable-warning=ExperimentalWarning --test "dist/test/*.test.js"` |
| 跑冒烟 | `bash scripts/smoke.sh`（18787 端口 + 临时配置，**不碰线上**） |
| 改完代码 | `npx tsc -p tsconfig.json` 然后 `./start-net.sh restart` |
| 看主入口 | `bash scripts/start-funnel.sh status`（地址也在 `.relay-funnel-url`） |

**守护和手动启停的关系**：守护每 10s 会把网关拉起来。想让它停着，
必须先停守护，否则你 stop 完 10 秒内它又回来了。

守护有单实例锁（`logs/.keepalive.lock`），重复启动会自己退出，不会出现两个守护抢着重启。

**手动重启的正确顺序**（踩过坑）——先停守护 → 等它真的退出 → 再 `restart` → 最后起守护：

```bash
kill "$(cat logs/.keepalive.pid)"; sleep 2.5   # keeper 收到 TERM 后 ~1.5s 内退出并释放锁
./start-net.sh restart
setsid nohup bash scripts/keepalive.sh >/dev/null 2>&1 &
```

原因：`restart` 有个几秒的空档。如果守护还活着，它会在空档里判定"网关不在了"而抢先拉起
一个实例，与 `restart` 启动的那个抢 8787。若守护还没退干净就去起新的，新 keeper 会被
单实例锁挡在门外（表现为"网关在跑但没人守护"）。

> **改配置要重启**：`relay-net.yaml` 只在进程启动时读入。
> 重启前先看 `healthz` 的 `inflight` —— 不为 0 就等一等，别打断客户在途请求。
> （2026-09-14 吃过一次：inflight=1 时重启，打断了客户一个请求。）

---

## 4. 故障处置

| 症状 | 先查 | 处置 |
|---|---|---|
| 面板打不开 | `./start-net.sh status` | 若守护在跑会自愈，等 10~20s；不恢复看 `logs/keepalive.log` |
| 客户报 401 | 面板「排障 → 鉴权失败」 | 看指纹是否命中已签发 key：**命中=key 被禁用/过期；不命中=客户端抄错或用了旧 key** |
| 客户报"参数/上下文"类 400 | 面板「运维 → 生效配置」 | 看 `消息条数上限` / `首字节超时` 是不是卡在正常区间（2026-09-14 两个误杀都是这么找出来的） |
| 客户报"慢/超时" | 面板「请求账本」 | 看步骤时间线卡在哪一阶段；`client_aborted` = 客户端自己先放弃，不是上游故障 |
| 503「上游熔断冷却中」 | 面板上游页 | 等冷却（默认 30s）；若某厂商长期如此，考虑降优先级或停用 |
| 额度用完 | 面板 keys 页 | 是 `402` 不是 `429`；续额度或换 key |
| 启动报「缺少环境变量 X」 | `.relay-net.env` | 补上 `X=...`。启动脚本会按配置自动核对所有 `{ENV:...}` |
| 启动报「需要 Node >= 22」 | `node --version` | 本机 `/usr/bin/node` 是 v12，脚本已自动把 nvm 的 Node 22 放到 PATH 最前 |
| 改了代码没生效 | `bash scripts/ops-check.sh` | 它会比对 `src` 与 `dist` 的时间戳，抓"改了源码没重建" |

---

## 5. 备份与恢复

### 5.1 三样东西，缺一样都起不来（接手先看这个）

| 东西 | 里面是什么 | 丢了会怎样 |
|---|---|---|
| `.relay-net.env` | 4 个厂商 key + 管理令牌（**唯一副本**） | 网关**根本起不来**（`start-net.sh` 缺环境变量直接退出） |
| `data/relay.db` | 全部客户 key（哈希）、额度、账本 | 所有客户立刻 401，额度无法恢复 |
| `.relay-vendor-keys.txt` / `.relay-sale-key.txt` | 发给客户的**明文** key | 只能给客户重发（库里只有哈希，还原不出明文） |

这三样都在本机、都不入库（见 `.gitignore`）—— **所以必须有一份在本机之外**。
2026-09-14 交叉审计把它列为唯一的 P0：审计当时全 home 目录深度 5 内只有 1 份 `.relay-net.env`。

### 5.2 日常：自动（都在本机）

- keeper 每 24h 跑 `scripts/db_backup.sh` → `data/backups/relay-<时间戳>.db`（保留 14 份）
  - 每份都过 `integrity_check`；**校验失败会删掉半成品**，不会留一个坏文件冒充"最新备份"
    （审计 P1-3：老版本留着它，而恢复命令 `ls -t | head -1` 正好会挑中它）
  - 没有 `sqlite3` 时先 `wal_checkpoint(TRUNCATE)` 再 `cp` —— 直接拷会漏掉 WAL 里最近的事务
- 紧接着 `scripts/export-secrets.sh` → `data/export/relay-secrets-<时间戳>.tar.gz`（保留 14 份）
  —— 一个包 = 环境变量 + 库 + 明文交付物 + `RESTORE.md`，换机时照着做就行
- keeper 启动时若发现最新备份已过 24h 才补一次（2026-09-14 改：原先每次重启都强制备一份，
  重启三次就把历史挤掉两份）

### 5.3 防灾：拷到本机之外（**这一步只能人做**）

```bash
bash scripts/export-secrets.sh                                   # 打包
scp data/export/relay-secrets-<时间戳>.tar.gz 你的电脑:~/         # ← 关键在这一条
```

`scripts/ops-check.sh` 会检查最近一次导出的时间，**超过 7 天报红**；
但它管不到"你到底有没有真拷出去" —— 所以这条要人自觉。

### 5.4 恢复（换机 / 磁盘坏）

```bash
# ① 先停守护，再停网关。顺序反了：keeper 每 10 秒一轮，会在 10 秒内把网关拉回来，
#    然后你 cp 的是一个"活进程正在写"的库（审计 P1-7）
kill "$(cat logs/.keepalive.pid)"
./start-net.sh stop

# ② 环境变量 —— 缺它网关起不来，换机时最容易漏的就是这步
tar -xzf relay-secrets-<时间戳>.tar.gz -C /tmp/restore
install -m 600 /tmp/restore/relay-net.env .relay-net.env

# ③ 数据库
cp data/relay.db data/relay.db.broken          # 留现场
cp /tmp/restore/relay.db data/relay.db
rm -f data/relay.db-wal data/relay.db-shm      # 清掉旧的预写日志，避免不一致

# ④ 起服务并自检
./start-net.sh start && bash scripts/ops-check.sh
```

⚠️ **回滚数据库会丢掉"备份之后新签发的客户 key"**：那些 key 的明文不在库里（只有哈希），
恢复后它们全部 401，额度也一起回退。要么先把这些 key 记下来重发，要么改用更新的包。

---

## 6. 开机自启（用户 crontab 全量）

```cron
@reboot sleep 20 && cd "<项目根>" && setsid nohup bash scripts/keepalive.sh >/dev/null 2>&1 &
*/5 * * * * cd "<项目根>" && bash scripts/ddns-dynv6.sh >/dev/null 2>&1
@reboot sleep 45 && cd "<项目根>" && bash scripts/start-funnel.sh >/dev/null 2>&1
@reboot sleep 60 && cd "<项目根>" && setsid nohup bash scripts/watch.sh >/dev/null 2>&1 &
0 9 * * * cd "<项目根>" && bash scripts/ops-check.sh >>logs/ops-check.log 2>&1
```

- `sleep N` 分别等网络/磁盘就绪、网关先起来。
- 之所以能跑通：`keepalive.sh` 内部**把 Node 22 的路径钉在 PATH 最前**。
  cron 的默认 PATH 只有 `/usr/bin:/bin`，而那里的 `node` 是 v12，不钉就会静默失败。
- **改过脚本路径必须一起改这里**，否则那一条会永远不执行且**不报错**。
  `bash scripts/ops-check.sh` 的第一项检查就是"cron 引用的脚本是否都存在"。
- 卸载：`crontab -e` 删掉对应行。

---

## 7. 已知边界（维护时别踩）

1. **主入口是 Tailscale Funnel，兜底是快隧道。** 主入口地址固定
   （见 `.relay-funnel-url`），客户零配置；兜底快隧道换进程就换名，**地址会失效**，
   只适合"主入口挂了临时救急"。
   - **真正关闭兜底隧道**：`bash scripts/start-tunnel.sh stop`（或 kill 那个 cloudflared 进程）。
     ⚠️ `RELAY_TUNNEL=0` / 删掉 `.relay-tunnel-url` 只是"不再重启它"—— **已经在跑的隧道不会停**，
     公网地址照样通，而且 keeper 从此不再监管它（审计 P1-8 实测：删了文件进程仍在跑）
   - 它只在**曾经起过隧道**时才管：没起过的部署不会因此凭空对外暴露
   - ⚠ **绝对不要**换用 `cloudflared-relaygate` 那个二进制（见下条）
2. **同一台机器上还有另一套 Python 版网关**（`/home/ctyun/文档/二转moa模型`，端口 8765/8767）。
   - **隧道二进制会撞**：它的守护用 `pgrep -f "cloudflared-relaygate tunnel"` 判断自己的隧道。
     所以本项目固定用 `~/.local/bin/cloudflared`（名字里没有 `-relaygate`）。
   - **⚠ 脚本名也会撞（2026-09-14 更正）**：本手册曾写"两套的脚本名不重叠，互不干扰"——
     **这是错的**。对方的守护叫 `rg-keepalive.sh`，`pgrep -f keepalive` 会命中它。
     本项目已改为只认 `logs/.keepalive.pid`，**操作时务必用 pidfile，不要用 `pkill -f`**。
3. **本机没有可入站的公网 IP**（IPv4/IPv6 都在 NAT 之后），所以"对外"只能靠隧道；
   云控制台的安全组/弹性IP 管不到这台机器。完整证据见 `docs/对外入口现状.md`。
4. **成本可以按厂商配，也可以按型号覆盖**（2026-09-14 起）：
   `cost` 是厂商级兜底，`modelCosts[型号]` 优先级更高；`listCost` / `modelListCosts`
   是"按刊例价折算"的第二个口径，只用于对外对比、不参与额度判断。
   例：`relay-net.yaml` 里 Agnes 两条线把 `agnes-3.0-flash / agnes-2.5-flash` 的实付覆盖成 0
   （官方现价 $0），而面板上仍要能看到刊例价。
5. **测试不碰线上**：单测走内存/临时库，冒烟固定 18787 端口 + 临时配置。
   规模以 `npm test` / `bash scripts/smoke.sh` 的**实际输出**为准（写死的数字一定会过期）。
