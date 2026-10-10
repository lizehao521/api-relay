# 示例

## `client/adaptive-retry.mjs` — 把「失败归因」变成一行代码

演示这套网关真正想解决的问题：**客户端不该再去 parse 上游的错误文本**。
中转站在错误体里给了 `relay_attribution.suggested_next`，客户端直接执行它。

```bash
# 1) 起 mock 上游 + 网关（见根 README §1）
npm run mock &
node dist/cli.js serve &

# 2) 正常路径
RELAY_BASE=http://127.0.0.1:8787 RELAY_KEY=sk-relay-pro-demo RELAY_MODEL=mock-small \
  node examples/client/adaptive-retry.mjs

# 3) 各种失败路径（mock 上游内置故障注入模型名）
for m in mock-429 mock-balance mock-401 mock-filter mock-context mock-503 mock-404; do
  echo "=== $m ==="
  RELAY_BASE=http://127.0.0.1:8787 RELAY_KEY=sk-relay-pro-demo RELAY_MODEL=$m \
    node examples/client/adaptive-retry.mjs
done
```

### 你会看到什么

| 注入的模型名 | 网关归因 | 客户端动作 |
|---|---|---|
| `mock-429` | `rate_limited` / `retry_with_backoff` + `retryAfterMs` | 等指定毫秒后重发（自动） |
| `mock-balance` | `quota_exhausted` / `top_up_balance`（**HTTP 402**） | 停止，提示联系运营 |
| `mock-401` | `auth_invalid` / `fix_credentials` | 停止（重试无意义） |
| `mock-filter` | `content_filtered` / `rewrite_input` | 停止，提示需改写输入 |
| `mock-context` | `context_length_exceeded` / `reduce_context` | 裁剪历史后重发（自动） |
| `mock-503` | `model_overloaded` / `retry_with_backoff` | 退避后重发（自动） |
| `mock-404` | `model_not_found` / `switch_model` | 换模型重发（自动，见下） |

### 两个值得注意的行为

1. **`mock-balance` / `mock-401` 会让网关立刻熔断该上游 30 秒**（冷却期内返回可归因的 503）。
   这是设计如此：凭据/余额类故障重试不可能成功，继续打只是浪费延迟与配额。
   演示时若连续测多个注入项，用 `POST /admin/api/providers/reset` 恢复，或给每项起一套新的 mock+网关。
2. **换模型在演示环境会失败**：mock 的故障注入模型名（`mock-429` 等）本身不是可用的"真"模型，
   换过去只会得到一个同样归因为 `model_not_found` 的 503。示例因此识别 `upstream === 'relay'`
   就停止——**"没有可用上游"是运营侧问题，客户端不该继续自转**。

### 关于 `X-Relay-Verify-Nonce`

示例里 `verify: true` 会带上这个头，网关返回 `x-relay-content-hmac`。
客户端用同一 nonce 对响应体重算 HMAC 即可**自证中转站没有篡改你的数据**：

```js
import { createHmac } from 'node:crypto';
const expected = createHmac('sha256', nonce).update(rawBody).digest('hex');
console.log(expected === res.headers.get('x-relay-content-hmac'));  // true = 字节未被改动
```

这是"我只是管道"从口头承诺变成可审计事实的方式，普通中转站给不出。
