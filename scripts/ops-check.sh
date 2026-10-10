#!/usr/bin/env bash
# 运维自检：一条命令回答"这套东西现在是不是真的都在岗"。
#
# 为什么需要它：2026-09-13 的重启静默失联 14 小时、2026-09-14 搬家改 cron 路径 ——
# 这类故障的共同点是**没有报错**：进程不在了、脚本路径变了、源码改了没重建，
# 表面上一切正常，直到有人来问"怎么不通了"。
#
# 用法： bash scripts/ops-check.sh
# 退出码：0 = 全部正常；1 = 有失败项（告警项不影响退出码）
# cron： 0 9 * * * … bash scripts/ops-check.sh >>logs/ops-check.log 2>&1

set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

FAIL=0
WARN=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; WARN=$((WARN + 1)); }

# 问外部解析器要记录。
#   $1=类型 $2=域名 → stdout 打印记录（可能多行）；返回 0 = 解析器作答了（记录可能为空），1 = 所有解析器都没答上
# ⚠ 必须分清"没有这条记录"和"根本问不到"。本机访问 dns.google / cloudflare-dns.com 的 DoH
#   **不通**（实测 http=000 超时，2026-09-14 踩过），拿 DoH 当唯一手段会天天误报。
#   所以：只直连外部解析器，并用应答里的 `status:` 字段判断"到底答没答上"。
RESOLVERS="8.8.8.8 1.1.1.1 223.5.5.5"
dig_ext() {
  local type=$1 name=$2 out status r
  for r in $RESOLVERS; do
    out=$(timeout 8 dig "@$r" "$type" "$name" 2>/dev/null)
    status=$(printf '%s' "$out" | grep -oE 'status: [A-Z]+' | head -1)
    if [ -n "$status" ]; then
      printf '%s' "$out" | awk '/^;; ANSWER SECTION:/{f=1;next} f&&/^$/{f=0} f&&NF>=5{print $5}'
      return 0
    fi
  done
  return 1
}

echo "[$(date '+%F %T')] ops-check @ $ROOT"

# ── 1) cron 指向的脚本必须都存在 ───────────────────────────────────────────
# 搬家/改名后最容易静默断掉的一环：cron 不会告诉你"文件没了"，它只是那一条永远不执行。
CRON_MISSING=0
CRON_TOTAL=0
while read -r f; do
  [ -z "$f" ] && continue
  CRON_TOTAL=$((CRON_TOTAL + 1))
  if [ ! -f "$ROOT/$f" ]; then
    bad "cron 引用的脚本不存在: $f（自启会静默失效）"
    CRON_MISSING=$((CRON_MISSING + 1))
  fi
done < <(crontab -l 2>/dev/null | grep -oE 'bash [a-zA-Z0-9_/.-]+\.sh' | awk '{print $2}' | sort -u)
if [ "$CRON_TOTAL" -eq 0 ]; then
  # 老逻辑在这里会打印"✓ cron 引用的 0 个脚本都在" —— 开机自启全丢了反而变绿，
  # 而"重启后服务起不来"正是本项存在的理由（审计 P1-5）。
  bad "crontab 里没有任何本项目脚本 —— 开机自启全丢了"
elif [ "$CRON_MISSING" -eq 0 ]; then
  ok "cron 引用的 $CRON_TOTAL 个脚本都在"
fi

# ── 2) 源码改了但没重建 = 跑的是旧代码 ─────────────────────────────────────
# 这是最阴的一种"没生效"：你改了 src，重启了进程，但进程加载的是旧 dist。
if [ -d dist ] && [ -d src ]; then
  NEWEST_SRC=$(find src -name '*.ts' -printf '%T@\n' 2>/dev/null | sort -rn | head -1 | cut -d. -f1)
  NEWEST_DIST=$(find dist -name '*.js' -printf '%T@\n' 2>/dev/null | sort -rn | head -1 | cut -d. -f1)
  if [ -n "$NEWEST_SRC" ] && [ -n "$NEWEST_DIST" ] && [ "$NEWEST_SRC" -gt "$NEWEST_DIST" ]; then
    bad "src 比 dist 新 —— 改了源码没重建，进程跑的是旧代码（跑 npx tsc -p tsconfig.json）"
  else
    ok "dist 不比 src 旧"
  fi
fi

# ── 2.5) 重建了但没重启 = 线上跑的还是旧代码 ───────────────────────────────
# 比第 2 项更阴的一层：src/dist 都齐了，但进程是重启之前启动的，
# 它加载的仍是旧 dist。今天每一批修复都踩过这个状态（进程 23:13 起、dist 23:49 重建）。
GW_PID=$(cat .relay-net.pid 2>/dev/null)
if [ -n "$GW_PID" ] && kill -0 "$GW_PID" 2>/dev/null; then
  START_EPOCH=$(ps -o lstart= -p "$GW_PID" 2>/dev/null | head -1 | xargs -I{} date -d '{}' +%s 2>/dev/null || echo 0)
  NEWEST_DIST_FILE=$(find dist -name '*.js' -printf '%T@ %p
' 2>/dev/null | sort -rn | head -1 | awk '{print $2}')
  DIST_EPOCH=$(stat -c %Y "$NEWEST_DIST_FILE" 2>/dev/null || echo 0)
  if [ "$START_EPOCH" -gt 0 ] && [ "$DIST_EPOCH" -gt "$START_EPOCH" ]; then
    bad "代码已重建但网关没重启：dist 最新 $(date -d "@$DIST_EPOCH" '+%F %T')，进程启动于 $(date -d "@$START_EPOCH" '+%F %T') —— 线上跑的是旧代码，重启才生效"
  else
    ok "网关进程不旧于 dist（启动于 $(date -d "@$START_EPOCH" '+%F %T')）"
  fi
else
  warn "没有在跑的网关进程（pid 文件缺失或已死）—— 重启后本项才有意义"
fi

# ── 3) 网关健康 ────────────────────────────────────────────────────────────
PORT=$(grep -oE '^\s*port:\s*[0-9]+' relay-net.yaml 2>/dev/null | head -1 | grep -oE '[0-9]+')
PORT=${PORT:-8787}
HEALTH_BODY=$(curl -s -m 5 "http://127.0.0.1:$PORT/healthz" 2>/dev/null)
if printf '%s' "$HEALTH_BODY" | grep -q '"status":"ok"'; then
  REQS=$(printf '%s' "$HEALTH_BODY" | grep -oE '"requestCount":[0-9]+' | grep -oE '[0-9]+')
  ok "网关健康 :$PORT（已服务 ${REQS:-?} 个请求）"
else
  bad "网关无响应或状态异常 :$PORT"
fi

# ── 4) keeper 在岗且真的握着单例锁 ─────────────────────────────────────────
# 只认 keeper 自己写的 pidfile。`pgrep -f keepalive` 会把**姊妹项目**（二转moa模型）的
# `rg-keepalive.sh` 一起匹配上 —— 2026-09-14 实测第一个命中就是别人家的守护，
# 照它判断会得出"我们的 keeper 在岗"这种错误结论。
KPID=$(cat logs/.keepalive.pid 2>/dev/null)
if [ -n "$KPID" ] && kill -0 "$KPID" 2>/dev/null; then
  ok "keeper 在岗 (pid $KPID)"
else
  bad "keeper 不在 —— 网关挂了没人拉起来（logs/.keepalive.pid ${KPID:+指向 $KPID，但该进程不在}）"
fi
# 锁能被抢到 = 没有 keeper 握着它 = 守护链断了（这比"进程在不在"更难发现）
if [ -f logs/.keepalive.lock ]; then
  if ( exec 9>logs/.keepalive.lock; flock -n 9 ) 2>/dev/null; then
    bad "keeper 单例锁是空的 —— 守护链断了（进程可能在，但没在守）"
  else
    ok "keeper 单例锁被持有"
  fi
fi

# ── 5) 公网入口（主入口 = Tailscale Funnel）────────────────────────────────
FUNNEL_URL=$(cat .relay-funnel-url 2>/dev/null | tr -d '\n')
if [ -n "$FUNNEL_URL" ]; then
  # 网络检查**必须重试**：一次抖动就报红的话，人很快就不看告警了。
  # （这行是 2026-09-14 实跑遇过一次瞬时失败之后加的）
  CODE=""
  for attempt in 1 2 3; do
    CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$FUNNEL_URL/healthz" 2>/dev/null)
    [ "$CODE" = "200" ] && break
    [ "$attempt" -lt 3 ] && sleep 3
  done
  if [ "$CODE" = "200" ]; then
    ok "公网入口可达 $FUNNEL_URL"
  else
    # 主入口断了 = 客户真的连不上（固定地址就在这一个域名上），必须红。
    # 审计 P1-5：原来只 warn，退出码仍 0，汇总只说"有 N 项告警"，没人会注意。
    bad "公网入口无响应（HTTP ${CODE:-超时}）$FUNNEL_URL —— 客户此时连不上"
  fi
else
  bad "没有 .relay-funnel-url，公网入口未配置"
fi

# ── 6) 兜底隧道（快隧道）仍在跑 ────────────────────────────────────────────
TPID=$(cat .relay-tunnel.pid 2>/dev/null)
if [ -n "$TPID" ] && kill -0 "$TPID" 2>/dev/null; then
  ok "兜底隧道在跑 (pid $TPID)"
else
  warn "兜底隧道不在（主入口还活着时不影响客户，但少了退路）"
fi

# ── 6.5) watch.sh 在岗（监控，静默失效最阴 —— 审计 P1-4）──────────────
# watch 没在跑 = 熔断/换路/入口异常全都不再有人盯，而 ops-check 自己照样全绿。
# keeper 现在会在 60s 内拉起它；这里报红是提示"曾经死过"。
if pgrep -f 'bash scripts/watch\.sh' >/dev/null 2>&1; then
  ok "watch.sh 在岗 (pid $(pgrep -f 'bash scripts/watch\.sh' | head -1))"
else
  bad "watch.sh 没在跑 —— 监控静默失效（keeper 会在 60s 内拉起；若 keeper 也没在跑，查 crontab）"
fi

# ── 7) 每日备份新鲜度（账务数据，丢不起）───────────────────────────────────
NEWEST_BAK=$(ls -t data/backups/*.db 2>/dev/null | head -1)
BAK_COUNT=$(ls data/backups/*.db 2>/dev/null | wc -l)
if [ -n "$NEWEST_BAK" ]; then
  AGE_H=$(( ($(date +%s) - $(stat -c %Y "$NEWEST_BAK")) / 3600 ))
  if [ "$AGE_H" -gt 48 ]; then
    bad "备份过期：最新一份是 ${AGE_H} 小时前（$NEWEST_BAK）"
  else
    ok "备份新鲜（$(basename "$NEWEST_BAK")，${AGE_H}h 前，共 $BAK_COUNT 份）"
  fi
else
  bad "没有找到任何备份（data/backups/ 为空）"
fi

# ── 7.5) 机密包**导出到本机之外**了没有 ────────────────────────────────────
# 厂商 key 与客户 key 库只有本机一份，本机导出再多也挡不住磁盘坏。
# 这里只看"最近一次导出是多久以前"，导出后有没有真拷出去脚本管不到，
# 所以文案要求明确：看到这条变红就去拷一份。
EXP="$(ls -1t data/export/relay-secrets-*.tar.gz 2>/dev/null | head -1)"
if [ -z "$EXP" ]; then
  warn "还没有导出过机密包（跑 bash scripts/export-secrets.sh）"
else
  AGE_D=$(( ( $(date +%s) - $(stat -c %Y "$EXP") ) / 86400 ))
  if [ "$AGE_D" -gt 7 ]; then
    warn "机密包已 $AGE_D 天没导出（$(basename "$EXP")）—— 磁盘坏就全没了"
  else
    ok "机密包 $AGE_D 天前导出过（$(basename "$EXP")）"
  fi
fi

# ── 8) DDNS 记录要与本机地址一致（不一致 = 拿这个域名的人连到死地址）───────
DDNS_ENV=.relay-dynv6.env
if [ -f "$DDNS_ENV" ]; then
  HOSTNAME_D=$(grep -oP '(?<=^DYNV6_HOSTNAME=).*' "$DDNS_ENV" 2>/dev/null | tr -d '"' | tr -d '\n')
  LOCAL6=$(ip -6 addr show dev ens3 scope global 2>/dev/null | grep -oP 'inet6 \K[0-9a-f:]+' | head -1)
  LOCAL4=$(ip -4 addr show dev ens3 2>/dev/null | grep -oP 'inet \K[0-9.]+' | head -1)
  if [ -n "$HOSTNAME_D" ]; then
    if ! REC6=$(dig_ext AAAA "$HOSTNAME_D"); then
      # 问不到 ≠ 记录没了。这两件事必须分开说，否则检查会天天乱叫（今天误报过一次）。
      warn "DDNS 外部解析器全都问不到，无法判断 $HOSTNAME_D 的记录是否有效"
    elif [ -z "$REC6" ]; then
      warn "DDNS $HOSTNAME_D 没有 AAAA 记录（本机是 ${LOCAL6:-未知}）"
    elif [ -n "$LOCAL6" ] && printf '%s' "$REC6" | grep -q "$LOCAL6"; then
      ok "DDNS 记录与本机一致（$HOSTNAME_D → $LOCAL6）"
    else
      warn "DDNS AAAA 与本机不一致：记录 $REC6 / 本机 ${LOCAL6:-未知}"
    fi
    if REC4=$(dig_ext A "$HOSTNAME_D") && [ -n "$REC4" ] && [ -n "$LOCAL4" ]; then
      printf '%s' "$REC4" | grep -q "$LOCAL4" || warn "DDNS A 与本机不一致：记录 $REC4 / 本机 $LOCAL4"
    fi
  fi
fi

# ── 9) 磁盘水位 ────────────────────────────────────────────────────────────
DISK=$(df -h / | awk 'NR==2{gsub(/%/,"",$5); print $5}')
if [ -n "$DISK" ] && [ "$DISK" -gt 85 ]; then
  warn "根分区已用 ${DISK}%（日志与数据库都在这个盘）"
else
  ok "磁盘 ${DISK}%"
fi

# ── 汇总 ───────────────────────────────────────────────────────────────────
if [ "$FAIL" -eq 0 ] && [ "$WARN" -eq 0 ]; then
  echo "结果：全部正常"
elif [ "$FAIL" -eq 0 ]; then
  echo "结果：正常，但有 $WARN 项告警"
else
  echo "结果：$FAIL 项失败 / $WARN 项告警"
fi
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
