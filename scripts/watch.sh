#!/usr/bin/env bash
# 测评期间的看护：每 30 秒采一轮，只记**有信息量**的东西。
#
# 重点盯三件事：
#   ① 竖向阶梯有没有真的往下推（档位名 → 换型号）
#   ② 横向兜底有没有在切（同型号 → 换线路）
#   ③ 熔断 / 失败归因有没有异常堆积
#
# 用法： setsid nohup bash scripts/watch.sh >/dev/null 2>&1 &
#       tail -f logs/watch.log
set -uo pipefail
cd "$(dirname "$0")/.."

LOG=logs/watch.log
ADM=http://127.0.0.1:8787/admin/api
mkdir -p logs

# 令牌来源（2026-09-14 审计 P1-4）：
#   ① 优先 .relay-net.env 里的 RELAY_ADMIN_TOKEN —— 持久、轮换即生效
#   ② 兜底 /tmp/admin-token.txt —— 只是兼容旧启动方式；/tmp 会被 systemd-tmpfiles 清掉
TOKEN_SOURCE=''
if [ -f .relay-net.env ]; then
  TOKEN_SOURCE=$(grep -oP '(?<=^RELAY_ADMIN_TOKEN=).*' .relay-net.env 2>/dev/null | head -1)
fi
if [ -z "$TOKEN_SOURCE" ] && [ -f /tmp/admin-token.txt ]; then
  TOKEN_SOURCE=$(cat /tmp/admin-token.txt)
fi
if [ -z "$TOKEN_SOURCE" ]; then
  echo "[$(date '+%F %T')] 找不到管理令牌（.relay-net.env 的 RELAY_ADMIN_TOKEN 或 /tmp/admin-token.txt），退出" >>"$LOG"
  exit 1
fi
TOK="$TOKEN_SOURCE"
AUTH="Authorization: Bearer $TOK"

LAST_TRACE=''
echo "[$(date '+%F %T')] watch 启动" >>"$LOG"

while true; do
  # 每轮重读令牌：管理令牌轮换后不重启 watch 也能跟上（审计 P1-4）
  if [ -f .relay-net.env ]; then
    NEWTOK=$(grep -oP '(?<=^RELAY_ADMIN_TOKEN=).*' .relay-net.env 2>/dev/null | head -1)
    [ -n "$NEWTOK" ] && { [ "$NEWTOK" != "$TOK" ] && TOK="$NEWTOK" && AUTH="Authorization: Bearer $TOK"; }
  fi
  # ── 滚动窗口概览 ──
  curl -s -m 8 -H "$AUTH" "$ADM/overview?window=5m" 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{
    const j=JSON.parse(s);const o=j.summary.overall;
    const fr=(j.summary.byFailureReason||[]).map(r=>r.reason+"×"+r.count).join(",")||"无";
    const bm=(j.summary.byModel||[]).map(m=>m.key+"×"+m.requests).join(" ")||"-";
    console.log("[5m] 请求"+o.requests+" 错"+o.errors+" p95 "+o.p95Ms+"ms 均TTFB "+o.avgTtfbMs+"ms | "+bm+" | 失败:"+fr);
  }catch(e){}
})' >>"$LOG"

  # ── 公网入口（Tailscale Funnel）──
  # 这是客户实际用的入口，它挂了比上游挂了更严重（客户连门都找不到）。
  # 只报"异常"，正常时不刷屏。
  FURL=$(cat .relay-funnel-url 2>/dev/null)
  if pgrep -x tailscaled >/dev/null 2>&1; then
    if [ -n "$FURL" ]; then
      # 本机解析器可能因"否定缓存"查不到该域名，所以用 Tailscale 中继 IP 直连校验
      FC=$(curl -s -m 15 -o /dev/null -w '%{http_code}' \
        --resolve "$(printf '%s' "$FURL" | sed 's|https://||'):443:208.111.34.11" \
        "$FURL/healthz" 2>/dev/null)
      [ "$FC" != "200" ] && echo "  [入口] ⚠ 公网入口异常 $FURL/healthz → ${FC:-000}" >>"$LOG"
    fi
  else
    echo "  [入口] ⚠ tailscaled 不在（公网入口已断）" >>"$LOG"
  fi

  # ── 上游熔断状态（只在有变化时才值得记）──
  curl -s -m 8 -H "$AUTH" "$ADM/providers" 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{
    const j=JSON.parse(s);const bits=(j.providers||[]).map(p=>{
      const h=p.health||{};const open=h.openUntil>Date.now();
      return p.id+(open?"[熔断]":"")+(h.consecutiveFailures?"(连败"+h.consecutiveFailures+")":"")+" ewma"+Math.round(h.ewmaLatencyMs||0);
    });
    console.log("  [上游] "+bits.join(" | "));
  }catch(e){}
})' >>"$LOG"

  # ── 阶梯感知：新轨迹里出现 retry / 多阶 route 的，单独记一条 ──
  # 用"已见到的最大 startedAt"去重：否则同一条换路事件会被每个采样周期重复记一遍，
  # 日志很快就全是同一条（实测踩到）。
  SINCE=$(cat logs/.watch-since 2>/dev/null || echo 0)
  NEW_SINCE=$(curl -s -m 8 -H "$AUTH" "$ADM/traces?limit=15" 2>/dev/null | SINCE="$SINCE" node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const since=Number(process.env.SINCE||0);
  let maxSeen=since;
  try{
    const j=JSON.parse(s);const ts=j.traces||[];
    for(const t of ts){
      if(t.startedAt>maxSeen) maxSeen=t.startedAt;
      if(t.startedAt<=since) continue;           // 上一轮已经记过
      const routes=(t.steps||[]).filter(x=>x.stage==="route");
      const retries=(t.steps||[]).filter(x=>x.stage==="retry");
      if(routes.length<2 && retries.length===0) continue;
      const d=new Date(t.startedAt).toLocaleTimeString("zh-CN");
      // 换了型号 = 竖向阶梯；同型号换了上游 = 横向兜底
      const models=routes.map(r=>r.summary.match(/model=(\S+)/)?.[1]).filter(Boolean);
      const kind=new Set(models).size>1 ? "竖向阶梯(换型号)" : "横向兜底(同型号换线路)";
      const chain=routes.map(r=>{
        const prov=r.summary.match(/→\s*(\S+?)[（(]/)?.[1] ?? "?";
        const mdl=r.summary.match(/model=(\S+)/)?.[1] ?? "?";
        return prov+"@"+mdl;
      }).join(" → ");
      console.log("  [换路] "+d+" "+kind+" "+t.durationMs+"ms "+t.outcome+" :: "+chain);
    }
  }catch(e){}
  if(maxSeen>since) console.log("__SINCE__"+maxSeen);
})')
  # 拆出日志行与游标（游标不走日志）
  printf '%s\n' "$NEW_SINCE" | grep -v '^__SINCE__' >>"$LOG"
  CUR=$(printf '%s\n' "$NEW_SINCE" | grep '^__SINCE__' | tail -1 | sed 's/^__SINCE__//')
  [ -n "$CUR" ] && printf '%s' "$CUR" > logs/.watch-since

  # 只保留最近 5000 行，别把盘写满
  if [ -f "$LOG" ] && [ "$(wc -l <"$LOG")" -gt 5000 ]; then
    tail -n 2500 "$LOG" > "$LOG.tmp" && mv -f "$LOG.tmp" "$LOG"
  fi

  sleep 30 9>&- &
  wait $!
done
