# 安全政策（SECURITY）

## 报告漏洞

**请勿开公开 issue 报告安全漏洞。**

请通过以下方式私下联系维护者：
- GitHub: [@lizehao521](https://github.com/lizehao521)（私信 / Security Advisory）
- 或在本仓库开启 **Security Advisory**（GitHub → Security → Report a vulnerability）

我会尽快确认并修复。修复发布后再公开披露细节。

## 本项目处理的安全敏感面

作为模型 API 聚合网关，本项目的核心信任边界就是「密钥与上游响应」：

1. **客户端 key 不下落明文**：key 以 sha256 哈希存储与索引，明文只在配置里出现一次，进程内不保留明文映射（见 `src/gateway/keys.ts`）。
2. **管理面鉴权**：`src/admin/auth.ts` 用 `timeSafeEqual` 防时序攻击，连续失败 20 次锁 5 分钟，未配置 adminToken 时仅允许本机（127.0.0.1）。
3. **日志脱敏**：`src/core/logger.ts` 的 `redact()` 递归脱敏 `apiKey`/`token`/`secret` 等字段，且不误伤 `keyId`/`kbId` 等标识符。新增日志字段时请勿绕过。
4. **成功响应零改写**：正常响应逐字节透传，降损层只在失败路径介入，避免引入意外的数据泄露面。

## 安全相关配置建议（部署方）

- **必须 TLS**：客户端 key 放在 `Authorization` 头里，明文 HTTP 等于把 key 公开发布（见 `docs/DEPLOYMENT.md`）。
- 生产部署务必设置强 adminToken（≥ 16 字符），否则管理接口仅本机可访问。

## 已知的安全设计取舍

- `baseUrl` 由管理员配置（非终端用户可控），当前未做私有地址（SSRF）拦截——
  若你将网关暴露给不可信的 upstream 配置来源，请自行加白名单。

---

本文件与代码中的安全控制会随版本演进，请以仓库 `main` 分支最新版本为准。
