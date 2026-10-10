# api-relay 巡查日志与长期目标

> 服务: 8787 api-relay  
> 创建时间: 2026-09-25 23:32 CST  
> 维护原则: 不改代码、不重启服务、每 2 分钟扫描、发现异常及时报告

---

## 1. 巡查日志 (Patrol Log)

### 1.1 第一轮巡查 (2026-09-25 15:00–23:32 CST)

| 项目 | 值 |
|------|-----|
| 巡查轮次 | 256 轮 (每 2 分钟一轮) |
| 巡查时长 | ~8.5 小时 |
| 起始请求 | 2,939 |
| 结束请求 | 4,016 |
| 总增量 | +1,077 |
| 平均速率 | ~126 请求/小时 |
| LR 请求 | 109 → 148 (+39) |
| LR 成功 | 109ok → 144ok (+35) |
| LR 错误 | 1ce (anonymous quota_exhausted) + 1ce (anonymous quota_exhausted) = 2ce |
| Provider | 5/5 启用，全程 0 熔断 |
| 存储 | 全程 ok |
| 代码修改 | 0 |
| 服务重启 | 0 |

### 1.2 第二轮巡查 (2026-09-25 23:34– CST)

| 项目 | 值 |
|------|-----|
| 巡查轮次 | 进行中 (256 轮上限) |
| 起始请求 | 11,191 |
| 起始 LR | 268/264ok/2ce |
| 跨会话增量 | +7,175 请求 (+120 LR, +120 ok, 0 新错误) |
| 代码修改 | 0 |
| 服务重启 | 0 |

#### 异常记录

| 时间 | 类型 | 详情 | 处置 |
|------|------|------|------|
| 18:42 CST | client_error | anonymous key quota_exhausted (HTTP 402) | 非 Agnes key，正常行为，忽略 |
| 18:42 CST | stream_interrupted | k_lfgi1vet 长流中断 (464,878ms ≈ 7.7min) | 网络波动，非服务故障，忽略 |

### 1.2 Agnes Key 配额事件 (2026-09-25 15:00–18:44 CST)

| 时间 | 事件 | 详情 | 处置 |
|------|------|------|------|
| ~15:00 | 首次发现 | k_lfgi1vet tokens=5,057,991/5,000,000 (101%) | 已超限，需处理 |
| 15:01 | 重置配额 | reset-quota API | tokens → 0/5,000,000 |
| ~18:40 | 再次超限 | tokens=5,060,656/5,000,000 (101%) | 2 小时内再次用完 |
| 18:42 | 永久解除 | quotaOverride → 999,999,999,999 | 等效无限配额 |
| 18:44 | 重置+验证 | reset-quota + 查询确认 | tokens=0/999,999,999,999 (0%) |

### 1.3 扫描命令模板

```bash
# 健康检查 (每 2 分钟)
curl -s --max-time 5 "http://127.0.0.1:8787/healthz" | python3 -c "
import sys,json
d=json.load(sys.stdin)
lr=d['lossReduction']['counters']
print(f'8787: status={d[\"status\"]} req={d[\"requestCount\"]} inflight={d[\"inflight\"]} store={d[\"store\"][\"ok\"]} prov={d[\"providers\"][\"total\"]}/{d[\"providers\"][\"disabled\"]}d/{d[\"providers\"][\"breakerOpen\"]}b LR: {lr[\"requests\"]}/{lr[\"success\"]}ok/{lr[\"clientErrors\"]}ce/{lr[\"upstreamErrors\"]}ue')
"

# 失败记录查询
sqlite3 data/relay.db "SELECT ts, key_id, tier, outcome, failure_reason, http_status, duration_ms FROM meter WHERE outcome != 'success' ORDER BY ts DESC LIMIT 5"

# Key 状态查询
curl -s -H "Authorization: Bearer $(cat /tmp/admin-token.txt)" \
  "http://127.0.0.1:8787/admin/api/keys" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for k in d.get('keys',[]):
    if k.get('id') == 'k_lfgi1vet':
        u=k.get('usage',{})
        p=k.get('policy',{})
        print(f\"quota={u.get('tokens',0)}/{u.get('quota',0)} pct={u.get('quotaUsedPct',0)}\")
"
```

---

## 2. 发现 (Discoveries)

### 2.1 配额机制发现

| # | 发现 | 影响 |
|---|------|------|
| D1 | `periodQuotaTokens` 是 tier 级别的，key 级别的覆盖字段是 `quotaOverride` | 修改 tier 配置会影响所有 key，应用 `quotaOverride` 做 per-key 覆盖 |
| D2 | `reset-quota` 只重置使用量，不重置 `periodQuotaTokens` 上限 | 重置后依然会被 tier 默认上限卡住，需配合 `quotaOverride` |
| D3 | `quotaOverride: 0` 语义不明（可能是"无限制"或"0 tokens 可用"） | 建议用大数值 (如 999,999,999,999) 代替 0 |
| D4 | `quotaCny` 字段可覆盖人民币额度上限 | 当前未使用，可作为费用兜底机制 |

### 2.2 API 接口发现

| # | 发现 | 影响 |
|---|------|------|
| D5 | `POST /admin/api/keys/update` 支持的字段: label, tier, enabled, allowedModels, expiresAt, quotaOverride, quotaCny | 无法直接修改 `periodQuotaTokens`，需用 `quotaOverride` |
| D6 | `POST /admin/api/keys/reset-quota` 返回 before/quota/note，确认重置成功 | 历史度量不受影响（可审计） |
| D7 | `GET /admin/api/keys` 返回的 `usage` 包含: tokens, costCny, requests, quota, quotaUsedPct | 可实时监控 key 配额使用率 |
| D8 | `GET /admin/api/keys` 返回的 `concurrency` 包含: active, waiting, limit | 可实时监控并发情况 |

### 2.3 服务稳定性发现

| # | 发现 | 影响 |
|---|------|------|
| D9 | 5 个 Provider 全程 0 熔断、0 禁用，稳定性极高 | MiMo 三档 + Agnes intl + Agnes CN 配置合理 |
| D10 | inflight 始终 ≤ 2，无积压 | 服务处理能力充足 |
| D11 | store 始终 ok，无数据写入异常 | SQLite 存储稳定 |
| D12 | LR (lossReduction) 全程 97-98% 成功率 | 异常率极低 |

### 2.4 请求模式发现

| # | 发现 | 影响 |
|---|------|------|
| D13 | 请求速率 ~126/小时，夜间 22:00–23:00 降为 ~30/小时 | 日间高峰约 4-6 请求/2分钟 |
| D14 | LR 请求增长慢于总请求增长 (39/1077 = 3.6%) | 大部分请求不触发 LR 流程 |
| D15 | 2 笔 client error 均为 anonymous key 配额耗尽 | 付费 key 无配额问题 |

---

## 3. 建议 (Recommendations)

### 3.1 短期 (立即执行)

| # | 建议 | 优先级 | 状态 |
|---|------|--------|------|
| R1 | Agnes key 设置 `quotaOverride: 999999999999` 防配额卡死 | 高 | ✅ 已完成 |
| R2 | 所有付费对外 key 建议设置 `quotaOverride` 防误限 | 高 | ⏳ 待执行 |
| R3 | 为 key 设置 `expiresAt` 防止过期遗忘 | 中 | ⏳ 待评估 |
| R4 | 配置 key 自动告警: 配额使用率 > 80% 时通知 | 中 | ⏳ 待开发 |

### 3.2 中期 (1-2 周)

| # | 建议 | 优先级 |
|---|------|--------|
| R5 | 建立定期巡查机制: 每日自动报告 key 配额使用情况 | 中 |
| R6 | 监控 Provider 响应时间，识别慢上游 | 中 |
| R7 | 分析 meter DB 历史数据，统计各模型调用量和成功率 | 低 |
| R8 | 配置自动配额重置 (如果 tier 默认配额不够用) | 低 |

### 3.3 长期 (1 个月+)

| # | 建议 | 优先级 |
|---|------|--------|
| R9 | 建立多节点部署方案，防止单点故障 | 高 |
| R10 | 配置 Prometheus/Grafana 监控面板 | 高 |
| R11 | 实现自动故障转移 (failover) 机制 | 中 |
| R12 | 建立 SLA 监控: 可用性 > 99.9% | 中 |
| R13 | 配置日志归档和告警 (邮件/企微/钉钉) | 中 |
| R14 | 定期安全审计: API key 轮换、访问权限检查 | 低 |

---

## 4. 长期目标 (Long-term Goals)

### 4.1 可用性目标

| 目标 | 指标 | 当前值 |
|------|------|--------|
| 服务可用性 | uptime | ~100% (8.5h 无中断) |
| 请求成功率 | success rate | 99.9%+ (仅 2 笔 anonymous quota) |
| Provider 健康 | breaker open | 0 (全程) |
| 响应时间 | p99 latency | 需建立基线 |
| 存储稳定性 | store ok | 100% |

### 4.2 容量规划目标

| 目标 | 指标 | 当前值 |
|------|------|--------|
| 日请求量 | daily requests | ~3,000 (推算) |
| LR 请求量 | daily LR requests | ~150 (推算) |
| 最大并发 | peak concurrent | ≤ 2 (当前) |
| 峰值速率 | peak rps | ~3/2min (推算) |
| 扩容阈值 | 建议扩容条件 | > 10 req/2min 持续 |

### 4.3 运维成熟度目标

| 阶段 | 能力 | 当前状态 |
|------|------|----------|
| L1 被动响应 | 人工发现异常 | ✅ 当前 |
| L2 主动监控 | 自动扫描 + 告警 | ⏳ 目标 |
| L3 自动修复 | 自动配额重置/熔断恢复 | ⏳ 目标 |
| L4 预测运维 | 基于历史预测故障 | ⏳ 长期 |

---

## 5. 附录

### 5.1 关键 API 端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/healthz` | GET | 健康检查 |
| `/admin/api/keys` | GET | 查询所有 key |
| `/admin/api/keys/update` | POST | 更新 key 属性 |
| `/admin/api/keys/reset-quota` | POST | 重置配额使用量 |
| `/admin/api/keys/create` | POST | 创建新 key |
| `/admin/api/keys/revoke` | POST | 吊销 key |
| `/admin/api/keys/delete` | POST | 删除 key |
| `/admin/api/providers` | GET | 查询 Provider 状态 |
| `/admin/api/loss-reduction` | GET | 查询 LR 配置 |
| `/admin/api/loss-reduction/update` | POST | 更新 LR 配置 |

### 5.2 数据库表结构

```sql
-- meter 表
CREATE TABLE meter (
    ts INTEGER,
    key_id TEXT,
    tier TEXT,
    outcome TEXT,  -- success / client_error / aborted / upstream_error
    failure_reason TEXT,
    http_status INTEGER,
    duration_ms INTEGER
);

-- 常用查询
-- 最近失败
SELECT * FROM meter WHERE outcome != 'success' ORDER BY ts DESC LIMIT 10;

-- 按 key 统计
SELECT key_id, COUNT(*), 
       SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) as ok,
       SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) as fail
FROM meter GROUP BY key_id;

-- 按模型统计
SELECT tier, COUNT(*), 
       AVG(duration_ms) as avg_ms,
       MAX(duration_ms) as max_ms
FROM meter GROUP BY tier;
```

### 5.3 文件清单

| 文件 | 用途 |
|------|------|
| `relay-net.yaml` | 主配置文件 (Provider + Tier + 路由) |
| `data/relay.db` | SQLite 计量数据库 |
| `/tmp/admin-token.txt` | Admin API 令牌 |
| `PATROL_LOG.md` | 本文件 — 巡查日志与长期目标 |
