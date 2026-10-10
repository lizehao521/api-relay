#!/usr/bin/env bash
# 对外服务的启动脚本（密钥只在这里注入，不写进配置文件）
#
#   ./start-net.sh start     启动
#   ./start-net.sh stop      停止
#   ./start-net.sh restart   重启
#   ./start-net.sh status    状态
#
# 密钥来源（按优先级）：
#   1. 环境变量（AGNES_API_KEY / MIMO_API_KEY / RELAY_ADMIN_TOKEN / RELAY_KEY_*）
#   2. 本目录 .relay-net.env（chmod 600，由本脚本自动创建，勿提交到 git）
# 客户端 key（RELAY_KEY_FREE/STANDARD/PRO）没配时会自动生成一次并写入 .relay-net.env，
# 保证"一条命令启动"的同时，不出现任何猜得到的明文兜底 key。
set -uo pipefail
cd "$(dirname "$0")"

# 本机 /usr/bin/node 是 v12，而本项目要求 Node 22。
# 先钉 PATH，再校验：不然会拿 v12 去跑，报一堆看不懂的语法/API 错。
NODE22_BIN=/home/ctyun/.nvm/versions/node/v22.23.2/bin
case ":$PATH:" in *":$NODE22_BIN:"*) ;; *) export PATH="$NODE22_BIN:$PATH" ;; esac
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  echo "需要 Node >= 22，实际是 $(node --version 2>/dev/null || echo '找不到 node')" >&2
  echo "  当前 PATH 里的 node: $(command -v node)" >&2
  exit 1
fi

CFG="${2:-relay-net.yaml}"
PIDFILE=.relay-net.pid
# 日志落盘：以前写 /tmp，机器一重启日志就没了，事后无法定位（已实际踩过）。
LOGDIR=logs
LOG="$LOGDIR/relay-net.log"
mkdir -p "$LOGDIR"
TOKENFILE=/tmp/admin-token.txt
ENVFILE=.relay-net.env
umask 077

# 允许用户预置的 .relay-net.env（chmod 600 属主可读写）
[ -f "$ENVFILE" ] && . "./$ENVFILE"

: "${AGNES_API_KEY:?请先 export AGNES_API_KEY（或写入 $ENVFILE）}"
: "${MIMO_API_KEY:?请先 export MIMO_API_KEY（或写入 $ENVFILE）}"
: "${RELAY_ADMIN_TOKEN:=$(cat "$TOKENFILE" 2>/dev/null)}"
: "${RELAY_ADMIN_TOKEN:?找不到管理令牌，请 export RELAY_ADMIN_TOKEN 或写入 $TOKENFILE}"

# 客户端 key：没配就生成一次，并持久化到 .relay-net.env（这样重启不换 key）
gen_key() { node -e "process.stdout.write(require('crypto').randomBytes(18).toString('base64url'))"; }
CHANGED=0
for name in RELAY_KEY_FREE RELAY_KEY_STANDARD RELAY_KEY_PRO; do
  if [ -z "${!name:-}" ]; then
    eval "$name=sk-relay-$(gen_key)"
    printf '%s=%s\n' "$name" "${!name}" >> "$ENVFILE"
    CHANGED=1
  fi
done
[ -f "$ENVFILE" ] && chmod 600 "$ENVFILE"

# 按配置自动同步：凡是 $CFG 里写到的 {ENV:XXX}，都必须有值并导出给子进程。
# 这里刻意不再手写 export 白名单 —— 之前就漏了 TOKENRHYTHM_API_KEY，
# 配置引用了它却在 export 列表外，冷启动直接报"配置装载失败"起不来。
for name in $(grep -oE '\{ENV:[A-Z_][A-Z0-9_]*\}' "$CFG" | sed 's/{ENV:\(.*\)}/\1/' | sort -u); do
  if [ -z "${!name:-}" ]; then
    echo "缺少环境变量 $name：配置 $CFG 引用了 {ENV:$name}，但没有值。" >&2
    echo "  解决： export $name=...   或写入 $ENVFILE" >&2
    exit 1
  fi
  export "$name"
done

if [ "$CHANGED" = "1" ]; then
  echo "首次启动：已生成三个客户端 key，写入 $ENVFILE（chmod 600）"
  echo "  RELAY_KEY_FREE=$RELAY_KEY_FREE"
  echo "  RELAY_KEY_STANDARD=$RELAY_KEY_STANDARD"
  echo "  RELAY_KEY_PRO=$RELAY_KEY_PRO"
fi

case "${1:-status}" in
  start)
    [ -f "$PIDFILE" ] && kill -0 "$(cat $PIDFILE)" 2>/dev/null && { echo "已在运行 PID $(cat $PIDFILE)"; exit 0; }
    # 追加而不是截断：保留上一次崩溃前的现场，否则重启会把证据冲掉。
    # 超过 10MB 就轮转一份，避免长期跑撑爆磁盘。
    if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 10485760 ]; then
      mv -f "$LOG" "$LOG.1"
    fi
    # 记下当前行数：日志是追加的，不记住就会把**历史上所有**启动横幅都打出来
    BEFORE_LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
    setsid nohup node --disable-warning=ExperimentalWarning dist/cli.js serve --config "$CFG" >> "$LOG" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"
    # 令牌留一份到你习惯的 /tmp 位置（真正持久的来源是 $ENVFILE）
    printf '%s\n' "$RELAY_ADMIN_TOKEN" > "$TOKENFILE" 2>/dev/null && chmod 600 "$TOKENFILE" 2>/dev/null
    sleep 2.5
    if kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
      echo "已启动 PID $(cat $PIDFILE)"
      tail -n +$((BEFORE_LINES + 1)) "$LOG" | grep -E "api-relay 已启动|网关:|管理看板:|上游:" | sed 's/^/  /'
      echo "  监听地址:"; ss -ltn 2>/dev/null | grep 8787 | awk '{print "    "$4}'
    else echo "启动失败:"; tail -12 "$LOG"; rm -f "$PIDFILE"; exit 1; fi ;;
  stop)
    [ -f "$PIDFILE" ] && { kill "$(cat $PIDFILE)" 2>/dev/null; sleep 0.6; rm -f "$PIDFILE"; echo "已停"; } || echo "未运行" ;;
  restart) "$0" stop; sleep 0.5; "$0" start "$CFG" ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
      echo "运行中 PID $(cat $PIDFILE)"; curl -s -m 3 http://127.0.0.1:8787/healthz | head -c 220; echo
    else echo "未运行"; fi ;;
  *) echo "用法: ./start-net.sh {start|stop|restart|status} [配置文件]"; exit 2 ;;
esac
