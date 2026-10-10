#!/usr/bin/env bash
# 拉起 Tailscale Funnel，把本网关以**固定公网 HTTPS 地址**暴露出去。
#
#   https://api-relay.tail62168c.ts.net/v1
#
# 为什么用它（而不是 quick tunnel）：
#   · 地址固定，不随进程重启/宽带重拨号变化
#   · **不需要本机有公网 IPv4**（隧道是出站发起的）
#   · **不需要开任何入站端口**（云安全组不用动）
#   · 不需要域名
#   · 客户侧零配置，也不用装 Tailscale（Funnel 是公开的）
#
# 为什么用 userspace 模式：**不需要 root**。整份东西都在用户目录里，
# 没装系统包、没改系统配置，卸载就是删目录。
#
# 用法： bash scripts/start-funnel.sh          （平时由 cron @reboot 调）
#       bash scripts/start-funnel.sh status
set -uo pipefail
cd "$(dirname "$0")/.."

BIN="$HOME/.local/bin"
STATE="$HOME/.local/share/ts-relay"
SOCK="$STATE/tailscaled.sock"
LOG="logs/funnel.log"
PORT=8787
HOSTNAME_TS=api-relay

mkdir -p logs "$STATE"
TS="$BIN/tailscale"
TSD="$BIN/tailscaled"

[ -x "$TS" ] && [ -x "$TSD" ] || { echo "[$(date '+%F %T')] 缺 tailscale 二进制（$BIN）" >>"$LOG"; exit 1; }

ts() { "$TS" --socket="$SOCK" "$@"; }

if [ "${1:-start}" = "status" ]; then
  ts status 2>&1 | head -5
  echo "--- funnel ---"
  ts funnel status 2>&1 | head -8
  exit 0
fi

# ── 1) tailscaled（userspace，免 root）──
if ! pgrep -x tailscaled >/dev/null 2>&1; then
  echo "[$(date '+%F %T')] 拉起 tailscaled" >>"$LOG"
  setsid nohup "$TSD" \
    --tun=userspace-networking \
    --socket="$SOCK" \
    --statedir="$STATE" \
    --port=41641 >>"$LOG" 2>&1 < /dev/null &
fi

# 等它就绪（最多 30 秒）
for _ in $(seq 1 30); do
  ts status >/dev/null 2>&1 && break
  sleep 1
done
if ! ts status >/dev/null 2>&1; then
  echo "[$(date '+%F %T')] tailscaled 未就绪，放弃" >>"$LOG"
  exit 1
fi

# 没登录就别硬来（登录是人做的，脚本只能报告）
if ts status 2>&1 | grep -q 'Logged out'; then
  echo "[$(date '+%F %T')] 未登录！需要人工点： $(ts status 2>&1 | grep -o 'https://login.tailscale.com/[^ ]*' | head -1)" >>"$LOG"
  exit 1
fi

# ── 2) Funnel ──
# --bg 让它常驻；重复执行是幂等的
if ts funnel status 2>&1 | grep -qE "^https://${HOSTNAME_TS}\..*\(Funnel on\)"; then
  echo "[$(date '+%F %T')] Funnel 已在运行" >>"$LOG"
else
  echo "[$(date '+%F %T')] 开启 Funnel :$PORT" >>"$LOG"
  ts funnel --bg "$PORT" >>"$LOG" 2>&1
fi

URL=$(ts funnel status 2>&1 | grep -oE 'https://[a-z0-9-]+\.[a-z0-9]+\.ts\.net' | head -1)
echo "[$(date '+%F %T')] 公网地址: ${URL:-（未知，查 $LOG）}" >>"$LOG"
printf '%s\n' "$URL" > .relay-funnel-url 2>/dev/null || true
