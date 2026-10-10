#!/usr/bin/env bash
# dynv6 DDNS：把本机当前公网 IPv6 同步到 lizehao.dynv6.net 的 AAAA 记录。
#
# 为什么需要：本机 IPv6 是 dynamic 的，宽带重拨号就会变。变了不更新，
# 客户配好的域名就指向一个不存在的地址 —— 而这一次是静默失效，没有任何报错。
#
# 用法： bash scripts/ddns-dynv6.sh          # 平时由 cron 每 5 分钟跑
#       bash scripts/ddns-dynv6.sh --force  # 忽略缓存强制更新一次
#
# 配置（chmod 600、gitignore）：.relay-dynv6.env
#   DYNV6_HOSTNAME=lizehao.dynv6.net
#   DYNV6_TOKEN=<zone 页 Instructions 标签里那个 token>
set -uo pipefail
cd "$(dirname "$0")/.."

ENVFILE=.relay-dynv6.env
LOG=logs/ddns.log
CACHE=logs/.ddns-last
mkdir -p logs

[ -f "$ENVFILE" ] || { echo "[$(date '+%F %T')] 缺 $ENVFILE，跳过" >>"$LOG"; exit 0; }
# shellcheck disable=SC1090
. "./$ENVFILE"
: "${DYNV6_HOSTNAME:?$ENVFILE 里缺 DYNV6_HOSTNAME}"
: "${DYNV6_TOKEN:?$ENVFILE 里缺 DYNV6_TOKEN}"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# 取网卡上的**全局** IPv6。
# ⚠ 不能用更新接口的 ipv6=auto：本机出站看到的 v6 和网卡上的不是同一个
#   （实测出站 240e:...:305::4b9 / 网卡 240e:...:307:6a::36），auto 会把记录写错。
V6=$(ip -6 addr show scope global 2>/dev/null | grep -oP 'inet6 \K[0-9a-f:]+' | grep -v '^fe80' | head -1)
# 同时维护 A 记录 = 内网 IPv4。必要性：对方（测评虚拟机）**没有 IPv6**，
# 而本机**没有公网 IPv4** —— 所以同网段里唯一能连的路径就是这个内网 v4。
V4=$(ip -4 addr show scope global 2>/dev/null | grep -oP 'inet \K[\d.]+' | head -1)
if [ -z "$V6" ] && [ -z "$V4" ]; then
  echo "[$(date '+%F %T')] 拿不到任何全局地址，跳过" >>"$LOG"
  exit 0
fi

LAST=$(cat "$CACHE" 2>/dev/null || echo "")
NOW="${V4:-}-${V6:-}"
if [ "$NOW" = "$LAST" ] && [ "$FORCE" = "0" ]; then
  exit 0   # 没变就不打扰 dynv6（也省得被当成滥用）
fi

Q="hostname=${DYNV6_HOSTNAME}&token=${DYNV6_TOKEN}"
[ -n "$V4" ] && Q="$Q&ipv4=${V4}"
[ -n "$V6" ] && Q="$Q&ipv6=${V6}"

# 重试：这个脚本由 cron 跑、输出被丢弃，一次瞬时抖动就静默失效；
# 而它失败意味着"客户配的域名指向一个不存在的地址"—— 必须尽量成功。
RESP=""
for attempt in 1 2 3; do
  RESP=$(curl -s -m 20 "https://dynv6.com/api/update?${Q}" 2>/dev/null)
  printf '%s' "$RESP" | grep -qi 'updated\|nochange' && break
  [ "$attempt" -lt 3 ] && sleep 5
done

if printf '%s' "$RESP" | grep -qi 'updated\|nochange'; then
  printf '%s' "$NOW" > "$CACHE"
  echo "[$(date '+%F %T')] 已更新 A=${V4:-（无）} AAAA=${V6:-（无）}（$RESP）" >>"$LOG"
else
  echo "[$(date '+%F %T')] 更新失败（已重试 3 次）：A=${V4:-无} AAAA=${V6:-无} 响应=${RESP:-（空/超时）}" >>"$LOG"
  exit 1
fi
