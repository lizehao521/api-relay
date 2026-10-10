#!/usr/bin/env bash
#
# 冒烟测试：用真实进程把「网关 + 降损层 + 管理看板」跑一遍。
#
# 与 `npm test` 的区别：测试套件在进程内直接驱动引擎（快、可断言细节）；
# 这个脚本启动**两个真实进程**（mock 上游 + 网关）并用 curl 打真实 HTTP，
# 覆盖"部署后是否真的能跑"这一类问题（端口、环境变量、CLI、信号、看板）。
#
# 用法：bash scripts/smoke.sh
set -uo pipefail
cd "$(dirname "$0")/.."

RELAY_PORT=${RELAY_PORT:-18787}
MOCK_PORT=${MOCK_PORT:-18899}
ADMIN_TOKEN="smoke-admin-token-0123456789"
TMPDIR_SMOKE=$(mktemp -d)
PASS=0
FAIL=0

cleanup() {
  [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null
  [[ -n "${RELAY_PID:-}" ]] && kill "$RELAY_PID" 2>/dev/null
  wait 2>/dev/null
  rm -rf "$TMPDIR_SMOKE"
}
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
check() { # check <描述> <实际> <期望>
  if [[ "$2" == "$3" ]]; then ok "$1（$2）"; else bad "$1：期望 $3，实际 $2"; fi
}

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

printf '== 构建 ==\n'
npm run build --silent || { echo "构建失败"; exit 1; }

section "1. 启动 mock 上游（含故障注入能力）"
node --disable-warning=ExperimentalWarning dist/cli.js mock --port "$MOCK_PORT" >"$TMPDIR_SMOKE/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$MOCK_PORT/v1/models" -o /dev/null && break
  sleep 0.15
done
if curl -sf "http://127.0.0.1:$MOCK_PORT/v1/models" -o /dev/null; then ok "mock 上游就绪 :$MOCK_PORT"; else bad "mock 上游未就绪"; cat "$TMPDIR_SMOKE/mock.log"; exit 1; fi

section "2. 生成配置并启动网关"
cat >"$TMPDIR_SMOKE/relay.yaml" <<YAML
server:
  host: 127.0.0.1
  port: $RELAY_PORT
  adminToken: "$ADMIN_TOKEN"
storage:
  driver: sqlite
  path: "$TMPDIR_SMOKE/relay.db"
logLevel: warn
providers:
  - id: mock
    label: mock 上游
    protocol: openai
    baseUrl: "http://127.0.0.1:$MOCK_PORT/v1"
    apiKey: "smoke-key"
    models: [mock-small, mock-large, mock-429, mock-500, mock-401, mock-404, mock-400, mock-502, mock-503, mock-drop, mock-timeout, mock-filter, mock-context, mock-balance]
    priority: 10
    cost: { inputPerMTok: 1, outputPerMTok: 2 }
modelAliases:
  fast: mock-small
clients:
  - id: free
    label: 免费层
    key: "sk-smoke-free"
    tier: free
    tenantId: smoke
    enabled: true
  - id: standard
    label: 标准层
    key: "sk-smoke-standard"
    tier: standard
    tenantId: smoke
    enabled: true
  - id: pro
    label: Pro 层
    key: "sk-smoke-pro"
    tier: pro
    tenantId: smoke
    enabled: true
lossReduction:
  attribution:
    autoRetry: 1
    backoffBaseMs: 20
    backoffMaxMs: 60
  meter:
    batchSize: 1
    flushIntervalMs: 50
YAML

RELAY_ADMIN_TOKEN="$ADMIN_TOKEN" node --disable-warning=ExperimentalWarning dist/cli.js check --config "$TMPDIR_SMOKE/relay.yaml" >"$TMPDIR_SMOKE/check.log" 2>&1
check "relay check 退出码" "$?" "0"

RELAY_ADMIN_TOKEN="$ADMIN_TOKEN" node --disable-warning=ExperimentalWarning dist/cli.js serve --config "$TMPDIR_SMOKE/relay.yaml" >"$TMPDIR_SMOKE/relay.log" 2>&1 &
RELAY_PID=$!
BASE="http://127.0.0.1:$RELAY_PORT"
for _ in $(seq 1 60); do
  curl -sf "$BASE/healthz" -o /dev/null && break
  sleep 0.15
done

section "3. 基础可用性"
check "GET /healthz" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")" "200"
check "GET /v1/models" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/models")" "200"
check "GET / (根说明)" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")" "200"
check "GET /v1/attribution/catalog" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/attribution/catalog")" "200"
check "GET /v1/nope（未知端点）" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/nope")" "404"
check "无 key 调用" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -d '{}')" "401"

section "4. 非流式成功 + 模型别名 + 透明度头"
RESP=$(curl -s -D "$TMPDIR_SMOKE/h1" -X POST "$BASE/v1/chat/completions" \
  -H 'authorization: Bearer sk-smoke-pro' -H 'content-type: application/json' \
  -d '{"model":"fast","messages":[{"role":"user","content":"你好"}]}')
echo "$RESP" | grep -q '"model":"fast"' && ok "别名回显被修正为 fast" || bad "别名回显未修正：$RESP"
echo "$RESP" | grep -q 'relay_attribution' && bad "成功响应不应含归因字段" || ok "成功响应零改写（无归因字段）"
grep -qi '^x-relay-mode: tier=pro' "$TMPDIR_SMOKE/h1" && ok "X-Relay-Mode 正确回显分层" || bad "X-Relay-Mode 缺失或错误"

section "5. 流式 SSE 线路格式"
STREAM=$(curl -s -N -X POST "$BASE/v1/chat/completions" \
  -H 'authorization: Bearer sk-smoke-pro' -H 'content-type: application/json' \
  -d '{"model":"mock-small","messages":[{"role":"user","content":"hi"}],"stream":true}')
echo "$STREAM" | head -1 | grep -q '^data: ' && ok "SSE 帧以 data: 开头" || bad "SSE 帧格式错误"
echo "$STREAM" | grep -q 'data: \[DONE\]' && ok "以 [DONE] 结束" || bad "缺少 [DONE]"
echo "$STREAM" | grep -q '"object":"chat.completion.chunk"' && ok "chunk 结构为 chat.completion.chunk" || bad "chunk 结构错误"

section "6. P3 失败归因（mock 注入 429）"
curl -s -X POST "$BASE/v1/chat/completions" -H 'authorization: Bearer sk-smoke-pro' -H 'content-type: application/json' \
  -d '{"model":"mock-429","messages":[{"role":"user","content":"x"}]}' >"$TMPDIR_SMOKE/err.json"
grep -q 'relay_attribution' "$TMPDIR_SMOKE/err.json" && ok "错误响应带回归因卡片" || bad "归因卡片缺失：$(cat "$TMPDIR_SMOKE/err.json")"
grep -q 'retry_with_backoff' "$TMPDIR_SMOKE/err.json" && ok "归因给出可执行动作 retry_with_backoff" || bad "建议动作不对"

section "7. P2 预检（畸形 tool_calls 必须在到达上游之前被拦）"
BEFORE=$(curl -s "$BASE/admin/api/overview?window=1h" -H "X-Admin-Token: $ADMIN_TOKEN" | grep -o '"requests": [0-9]*' | head -1)
curl -s -X POST "$BASE/v1/chat/completions" -H 'authorization: Bearer sk-smoke-pro' -H 'content-type: application/json' \
  -d '{"model":"mock-small","messages":[{"role":"user","content":"x"},{"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"f","arguments":{"a":1}}}]}]}' >"$TMPDIR_SMOKE/precheck.json"
grep -q 'tool_call_arguments_invalid_json' "$TMPDIR_SMOKE/precheck.json" && ok "预检命中 tool_calls 结构错误" || bad "预检未命中：$(cat "$TMPDIR_SMOKE/precheck.json")"
grep -q '"fix"' "$TMPDIR_SMOKE/precheck.json" && ok "违规项带可执行修复建议" || bad "缺少修复建议"
echo "$BEFORE" >/dev/null

section "8. 分层差异（免费层 attribution=off）"
FREE=$(curl -s -X POST "$BASE/v1/chat/completions" -H 'authorization: Bearer sk-smoke-free' -H 'content-type: application/json' \
  -d '{"model":"mock-429","messages":[{"role":"user","content":"x"}]}')
echo "$FREE" | grep -q 'relay_attribution' && bad "免费层不应投递归因（破坏纯管道承诺）" || ok "免费层保持纯管道语义"

section "9. P8 度量与管理看板"
sleep 0.4
curl -s "$BASE/admin/api/overview?window=1h" -H "X-Admin-Token: $ADMIN_TOKEN" >"$TMPDIR_SMOKE/overview.json"
grep -q '"lossReduction"' "$TMPDIR_SMOKE/overview.json" && ok "overview 含降损收益口径" || bad "overview 缺少降损口径"
grep -q '"byFailureReason"' "$TMPDIR_SMOKE/overview.json" && ok "overview 含失败归因分布" || bad "缺少归因分布"
# 轨迹是**异步批量落库**的（store 的 flushIntervalMs 定时 flush），请求刚结束就查，
# 可能还没写进去 → 返回空列表 → 断言假失败（实测 3 轮里偶发 1 次，本地复现过）。
# 所以这里等它落盘，而不是把竞态当成缺陷。
TRACES_OK=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s "$BASE/admin/api/traces?limit=5" -H "X-Admin-Token: $ADMIN_TOKEN" | grep -q '"steps"'; then TRACES_OK=1; break; fi
  sleep 0.3
done
[ "$TRACES_OK" = 1 ] && ok "轨迹接口可用（P5）" || bad "轨迹接口异常"
curl -s "$BASE/admin/api/report?window=1h" -H "X-Admin-Token: $ADMIN_TOKEN" | grep -q '归因投递率' && ok "文本报告可用" || bad "报告接口异常"
check "无令牌访问管理接口" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/api/overview")" "401"
check "看板 HTML" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin" -H "X-Admin-Token: $ADMIN_TOKEN")" "200"

section "10. 运营动作与优雅退出"
curl -s -X POST "$BASE/admin/api/providers/toggle" -H "X-Admin-Token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"id":"mock","disabled":true}' >/dev/null
check "禁用后调用返回 503" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H 'authorization: Bearer sk-smoke-pro' -H 'content-type: application/json' -d '{"model":"mock-small","messages":[{"role":"user","content":"x"}]}')" "503"
curl -s -X POST "$BASE/admin/api/providers/toggle" -H "X-Admin-Token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"id":"mock","disabled":false}' >/dev/null
check "恢复后调用返回 200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H 'authorization: Bearer sk-smoke-pro' -H 'content-type: application/json' -d '{"model":"mock-small","messages":[{"role":"user","content":"x"}]}')" "200"

kill -TERM "$RELAY_PID" 2>/dev/null
for _ in $(seq 1 40); do kill -0 "$RELAY_PID" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$RELAY_PID" 2>/dev/null; then bad "SIGTERM 后进程未退出"; else ok "SIGTERM 优雅退出"; fi
RELAY_PID=""

section "11. 重启后度量仍在（SQLite 持久化）"
node --disable-warning=ExperimentalWarning dist/cli.js report --config "$TMPDIR_SMOKE/relay.yaml" 2>/dev/null | head -3 >"$TMPDIR_SMOKE/report.txt"
if grep -q '损耗度量' "$TMPDIR_SMOKE/report.txt"; then ok "relay report 可读取历史度量"; else bad "relay report 无输出：$(cat "$TMPDIR_SMOKE/report.txt")"; fi
grep -E '请求 [1-9]' "$TMPDIR_SMOKE/report.txt" >/dev/null && ok "重启后仍统计到请求" || bad "重启后度量丢失"

printf '\n\033[1m== 冒烟结果：通过 %d，失败 %d ==\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || { printf '\n网关日志尾部：\n'; tail -20 "$TMPDIR_SMOKE/relay.log"; }
exit "$FAIL"
