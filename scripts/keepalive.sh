#!/usr/bin/env bash
# api-relay 守护进程：健康检查驱动（不是"进程在不在"那么简单）+ 每日备份账务库。
#
# 为什么需要：2026-09-13 那次机器重启后，本网关没有被拉起，静默失联 14 小时。
# 只靠"手动 start"或"只有进程存在性检查"都不够——进程活着但卡死同样是不服务。
#
# 用法： setsid nohup bash scripts/keepalive.sh >/dev/null 2>&1 &   （在项目根目录执行）
# 停止： kill "$(cat logs/.keepalive.pid)"
#   ⚠️ **不要**用 `pkill -f keepalive`：本机姊妹项目（二转moa模型）的守护叫
#      rg-keepalive.sh，同样含 keepalive.sh，实测第一个命中的就是别人家的。
set -uo pipefail
# 本脚本住在 scripts/ 下，但所有相对路径（logs/、.relay-net.pid、relay-net.yaml、
# ./start-net.sh、scripts/db_backup.sh）都是相对**项目根**的 —— 所以 cd 到上一级。
# 搬家时漏掉这个 /.. 会让 keeper 在 init 阶段就找不到配置文件而静默失败。
cd "$(dirname "$0")/.."

# cron / 开机环境的 PATH 极简（通常只有 /usr/bin:/bin），而本机 /usr/bin/node 是 v12，
# 本网关要求 Node 22。不把 nvm 的 bin 放到最前，开机自启会捡到 v12 静默失败。
NODE22_BIN=/home/ctyun/.nvm/versions/node/v22.23.2/bin
case ":$PATH:" in *":$NODE22_BIN:"*) ;; *) export PATH="$NODE22_BIN:$PATH" ;; esac

LOG=logs/keepalive.log
PIDFILE=.relay-net.pid
CFG="${RELAY_CFG:-relay-net.yaml}"   # 允许 RELAY_CFG=xxx.yaml 覆盖
HEALTH=http://127.0.0.1:8787/healthz
mkdir -p logs

# 单实例锁：开机自启和手动启动撞在一起时，不要让两个 keeper 互相抢着重启网关
exec 9>logs/.keepalive.lock
if ! flock -n 9; then
  echo "[$(date '+%F %T')] 已有 keeper 在运行，本次退出" | tee -a "$LOG"
  exit 0
fi

# 写下自己的 pid —— **判断"我们的 keeper 在不在"只能靠它**。
# 为什么不能用 `pgrep -f keepalive`：本机还跑着姊妹项目（二转moa模型）的守护，
# 名字叫 `rg-keepalive.sh`，同样含 "keepalive.sh"。2026-09-14 实测：
# `pgrep -f '[k]eepalive\.sh'` 的第一个命中就是**别人家的**守护，
# 照它去 kill 就会把另一套系统的守护杀掉。
echo $$ > logs/.keepalive.pid

# 版本不对就大声失败，不要带着 v12 去跑、然后让日志里一堆看不懂的错
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  echo "[$(date '+%F %T')] 致命：需要 Node >= 22，实际是 $(node --version 2>/dev/null || echo '找不到 node')" >>"$LOG"
  exit 1
fi

BAD=0            # 连续健康检查失败次数
# 上次备份时间：**从已有的最新备份反推**，不要写死 0。
# 写死 0 会让 keeper 每次重启都强制备一份 —— 2026-09-14 连着重启三次，
# 硬是把 14 份的历史挤掉了两份（备份目录只留 14 份）。没有备份时才立刻备。
LAST_BACKUP=$(ls -t data/backups/*.db 2>/dev/null | head -1 | xargs -r stat -c %Y 2>/dev/null)
LAST_BACKUP=${LAST_BACKUP:-0}
TUN_LAST_TRY=0   # 上次尝试拉起公网隧道的时刻（限频用）
FUNNEL_LAST_TRY=0  # 主入口（Funnel）限频
FUNNEL_COUNT=0     # 巡检轮数（每 6 轮做一次 URL 探测，即 ~60s）
WATCH_LAST_TRY=0   # watch.sh 限频

# 收到停止信号要**立刻**退出，不能等当前那一轮 sleep 跑完。
# 否则维护时 `kill <keeper>` 之后它会继续占着单实例锁最多 10 秒，
# 新起的 keeper 会被锁挡在门外 → 留下"网关在跑但没人守护"的裸奔窗口（已实际踩到）。
trap 'echo "[$(date "+%F %T")] keeper 收到停止信号，退出" >>"$LOG"; rm -f logs/.keepalive.pid; exit 0' TERM INT

healthy() { [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$HEALTH" 2>/dev/null)" = "200" ]; }
alive()   { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }

restart() {
  # -9：卡死的进程收不到 TERM（挂起状态必须强杀），和 Python 那套 keeper 同一个教训
  [ -f "$PIDFILE" ] && kill -9 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null
  rm -f "$PIDFILE"
  sleep 1
  # 跟着 keeper 启动时用的配置走，避免"用非默认配置启动、被守护拉回默认配置"。
  # 9>&- 必须带上：否则 node 会继承单实例锁的 fd 并一直持有，
  # 导致 keeper 一旦重启就再也抢不到锁（自己把自己锁在门外）。
  ./start-net.sh start "$CFG" >>"$LOG" 2>&1 9>&-
}

echo "[$(date '+%F %T')] keeper 启动 (pid $$)" >>"$LOG"

while true; do
  if ! alive; then
    echo "[$(date '+%F %T')] 网关进程不在，拉起" >>"$LOG"
    restart
    BAD=0
  elif ! healthy; then
    BAD=$((BAD + 1))
    echo "[$(date '+%F %T')] 健康检查失败 第 ${BAD} 次" >>"$LOG"
    if [ "$BAD" -ge 2 ]; then
      echo "[$(date '+%F %T')] 连续 2 次不健康，判定卡死，强杀重启" >>"$LOG"
      restart
      BAD=0
    fi
  else
    BAD=0
  fi

  # ── 公网隧道（RELAY_TUNNEL=0 可关掉）──
  # 两个要点：
  #   ① 必须用 cloudflared，**不能**用 cloudflared-relaygate —— 本机还跑着另一套
  #      Python 网关，它的守护靠 `pgrep -f "cloudflared-relaygate tunnel"` 判断自己的
  #      隧道在不在。我们若用同名二进制，它会把它当成自己的隧道，从此永不重启。
  #   ② 尝试要放后台 + 限频：start-tunnel.sh 要等最多 40s 才拿到地址，放在前台会把
  #      守护循环堵住，网关反而不受监督了。失败时 60s 内不重复尝试，避免反复白等。
  if [ "${RELAY_TUNNEL:-1}" = "1" ] && [ -f .relay-tunnel-url ]; then
    TUN_PID=$(cat .relay-tunnel.pid 2>/dev/null)
    if [ -z "$TUN_PID" ] || ! kill -0 "$TUN_PID" 2>/dev/null; then
      NOW_T=$(date +%s)
      if [ $((NOW_T - TUN_LAST_TRY)) -ge 60 ]; then
        TUN_LAST_TRY=$NOW_T
        echo "[$(date '+%F %T')] 公网隧道不在，拉起" >>"$LOG"
        CLOUDFLARED="${RELAY_CLOUDFLARED:-$HOME/.local/bin/cloudflared}" \
          ./scripts/start-tunnel.sh start >>"$LOG" 2>&1 9>&- &
      fi
    fi
  fi

  # ── 主入口（Tailscale Funnel）守护（2026-09-14 审计 P1-6）──────────
  # 之前 keeper 只管网关/快隧道/备份，主入口挂了没人拉起 —— 客户手里的**固定地址**
  # 直接连不上，而兜底隧道换名后更没人知道。这里补上：
  #   ① 每轮（10s）看 tailscaled 在不在（便宜）
  #   ② 每 6 轮（60s）探一次 .relay-funnel-url 的 /healthz（慢，限频）
  # 拉起放后台 + 限频 60s，绝不堵 10s 巡检循环。
  FURL=$(cat .relay-funnel-url 2>/dev/null | tr -d '\n')
  if [ -n "$FURL" ]; then
    FUNNEL_OK=1
    pgrep -x tailscaled >/dev/null 2>&1 || FUNNEL_OK=0
    FUNNEL_COUNT=$((FUNNEL_COUNT + 1))
    if [ "$FUNNEL_OK" = "1" ] && [ $((FUNNEL_COUNT % 6)) -eq 0 ]; then
      # 本机解析器可能"否定缓存"该域名，用 Tailscale 中继 IP 直连校验（同 watch.sh 的做法）
      FC=$(curl -s -m 10 -o /dev/null -w '%{http_code}' \
        --resolve "$(printf '%s' "$FURL" | sed 's|https://||'):443:208.111.34.11" \
        "$FURL/healthz" 2>/dev/null)
      [ "$FC" = "200" ] || FUNNEL_OK=0
    fi
    if [ "$FUNNEL_OK" = "0" ]; then
      NOW_F=$(date +%s)
      if [ $((NOW_F - FUNNEL_LAST_TRY)) -ge 60 ]; then
        FUNNEL_LAST_TRY=$NOW_F
        echo "[$(date '+%F %T')] 主入口异常（tailscaled 不在或 /healthz 不通），拉起" >>"$LOG"
        bash scripts/start-funnel.sh >>"$LOG" 2>&1 9>&- &
      fi
    fi
  fi

  # ── watch.sh 守护（审计 P1-4）──────────────────────────────────────
  # crontab 只在 @reboot 拉一次；它因令牌缺失/异常退出后没人拉起 → 监控静默全灭。
  # 用精确 pattern（bash scripts/watch.sh），不会误伤别的进程。
  if ! pgrep -f 'bash scripts/watch\.sh' >/dev/null 2>&1; then
    NOW_W=$(date +%s)
    if [ $((NOW_W - WATCH_LAST_TRY)) -ge 60 ]; then
      WATCH_LAST_TRY=$NOW_W
      echo "[$(date '+%F %T')] watch.sh 不在，拉起" >>"$LOG"
      setsid nohup bash scripts/watch.sh >/dev/null 2>&1 9>&- &
    fi
  fi

  # ── 每日备份账务库 ──
  NOW=$(date +%s)
  if [ $((NOW - LAST_BACKUP)) -gt 86400 ]; then
    if bash scripts/db_backup.sh >>"$LOG" 2>&1 9>&-; then
      LAST_BACKUP=$NOW
      # 顺带导出一份"可恢复的机密包"（厂商 key + 客户 key 库）。
      # 注意：它和原始机密在同一块盘上，**防不了磁盘坏** ——
      # 真正防灾的是把它拷到本机之外，所以 ops-check 会盯着导出时间。
      bash scripts/export-secrets.sh >>"$LOG" 2>&1 9>&- || echo "[$(date '+%F %T')] 机密包导出失败" >>"$LOG"
    else
      # 备份失败：**不能**记成"今天备过了"（那会 24 小时不再试），
      # 也**不能**每 10 秒重试（复核实测：那会变成每 10 秒一次 checkpoint+整库 cp 的风暴，
      # 而且 export-secrets 只在成功分支里 → 机密包会永远不导出）。
      # 折中：把上次备份时间往前挪到"1 小时前"，即 1 小时后再试。
      LAST_BACKUP=$((NOW - 82800))
      echo "[$(date '+%F %T')] 数据库备份失败，1 小时后再试" >>"$LOG"
    fi
  fi

  # ── keeper 自己的日志超 10MB 就轮转 ──
  if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 10485760 ]; then
    mv -f "$LOG" "$LOG.1"
  fi

  # 用 sleep & + wait 而不是裸 sleep：裸 sleep 期间 bash 不会处理信号，
  # 上面的 trap 就形同虚设（TERM 要等 sleep 结束才生效）。
  # 9>&- 同理：不给这个子进程继承单实例锁的 fd，否则 keeper 退出后
  # 锁还要被这个 sleep 多攥住最多 10 秒，重新拉起 keeper 会被挡在门外。
  sleep 10 9>&- &
  wait $!
done
