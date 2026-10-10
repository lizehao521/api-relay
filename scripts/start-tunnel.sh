#!/usr/bin/env bash
# 对外隧道（cloudflared quick tunnel）：让公网用户能访问本机网关
#
#   bash scripts/start-tunnel.sh start    启动（并打印公网地址）
#   bash scripts/start-tunnel.sh stop     停止
#   bash scripts/start-tunnel.sh restart  重启（会换一个新地址）
#   bash scripts/start-tunnel.sh status   状态
#   bash scripts/start-tunnel.sh url      只打印当前公网地址
#
# ⚠ 这是**兜底**通道。主入口是 Tailscale Funnel（scripts/start-funnel.sh），
#   固定地址、客户零配置。这里只保证"Funnel 万一挂了还有一条路"。
#
# 为什么需要它：本机在 NAT 之后、没有公网 IPv4，且有云安全组拦着，
# 所以"外网可达"不能靠监听 0.0.0.0 解决。隧道是**出站**连接，绕过 NAT 与安全组，
# 而且自带 HTTPS（客户端 key 走 Authorization 头，明文 HTTP 等于公开发布 key）。
#
# ⚠ quick tunnel 的性质：地址是随机的、随进程存活、Cloudflare 不保证可用率。
#   要固定域名与可用率，用 named tunnel：
#     cloudflared tunnel login && cloudflared tunnel create relay
#   然后把这个服务的 config.yml 指到 http://127.0.0.1:8787。
set -uo pipefail
# 住在 scripts/ 下，但 PID/URL 落盘文件按约定在**项目根**（keeper 也要读它们）。
cd "$(dirname "$0")/.."

PIDFILE=.relay-tunnel.pid
URLFILE=.relay-tunnel-url
LOG=/tmp/relay-tunnel.log
BIN="${CLOUDFLARED:-$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")}"
UPSTREAM="${RELAY_UPSTREAM:-http://127.0.0.1:8787}"

[ -x "$BIN" ] || { echo "找不到 cloudflared（可 export CLOUDFLARED=/path/to/cloudflared）" >&2; exit 1; }

wait_url() {
  for _ in $(seq 1 40); do
    U=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1)
    [ -n "$U" ] && printf '%s\n' "$U" > "$URLFILE" && return 0
    sleep 1
  done
  return 1
}

case "${1:-status}" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
      echo "已在运行 PID $(cat $PIDFILE)"; echo "  地址: $(cat $URLFILE 2>/dev/null || echo '(未知)')"; exit 0
    fi
    : > "$LOG"
    setsid nohup "$BIN" tunnel --url "$UPSTREAM" --no-autoupdate > "$LOG" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"
    if wait_url; then
      echo "隧道已启动 PID $(cat $PIDFILE)"
      echo "  公网地址: $(cat $URLFILE)"
      echo "  上游:     $UPSTREAM"
      echo "  日志:     $LOG"
      echo "  提示: 地址随进程存活，重启会变；重启后请重新通知外部用户。"
    else
      echo "启动失败或超时，日志尾部:" >&2; tail -15 "$LOG" >&2; rm -f "$PIDFILE"; exit 1
    fi ;;
  stop)
    if [ -f "$PIDFILE" ]; then
      kill "$(cat $PIDFILE)" 2>/dev/null; sleep 0.6; rm -f "$PIDFILE"; echo "隧道已停"
    else echo "未运行"; fi ;;
  restart) "$0" stop; sleep 0.5; "$0" start ;;
  url) [ -f "$URLFILE" ] && cat "$URLFILE" || { echo "（还没有地址，先 start）" >&2; exit 1; } ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
      U=$(cat "$URLFILE" 2>/dev/null)
      echo "运行中 PID $(cat $PIDFILE)"
      echo "  地址: $U"
      # 真的从公网地址回连一次，而不是只看进程在不在
      printf '  自检: '
      CODE=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$U/healthz" 2>/dev/null) || CODE="(连接失败)"
      echo "GET $U/healthz -> $CODE"
    else echo "未运行"; fi ;;
  *) echo "用法: bash scripts/start-tunnel.sh {start|stop|restart|status|url}"; exit 2 ;;
esac
