#!/usr/bin/env bash
# 把对外入口从「quick tunnel 随机名」换成「IPv6 直连 + HTTPS」。
# 路线来源：隔壁 `二转moa模型/docs/07_对外接入方案.md` 的 A 路线。
#
#   阶段一（默认）：装 nginx、自签证书、配好反代 → 用手机验 IPv6 通不通
#   阶段二（--letsencrypt）：确认通了之后，换成 Let's Encrypt 的 IP 证书（自动续）
#
#   sudo bash scripts/setup-v6-tls.sh
#   sudo bash scripts/setup-v6-tls.sh --letsencrypt -m you@example.com
#
# ⚠ 前置条件（不满足会白跑）：
#   云控制台/光猫已放行 **IPv6 入站 TCP 80、443、8443**
#   手机开蜂窝数据能打开 http://[<本机v6>]:8787/healthz
#
# 为什么需要 nginx 而不是让网关自己上 TLS：
#   网关只做数据面，证书轮换/续期/ACME 校验都属基础设施；反代层还能顺手把
#   管理面挡在内网（/admin 的 HTML 外壳在网关侧**刻意**不要 token，
#   不在这里挡住就等于把面板公开了）。
set -euo pipefail

CONF_SRC="$(cd "$(dirname "$0")/.." && pwd)/templates/nginx-api-relay-v6.conf"
NGINX_CONF=/etc/nginx/conf.d/api-relay.conf
SSL_DIR=/etc/nginx/ssl
WEBROOT=/var/www/certbot
CERT_NAME=api-relay-v6
GATEWAY_PORT=8787

[ "$(id -u)" = "0" ] || { echo "必须以 root 运行：sudo bash $0" >&2; exit 1; }

MODE=selfsigned
EMAIL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --letsencrypt) MODE=letsencrypt ;;
    -m) EMAIL="${2:-}"; shift ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

# ── 找出本机全局 IPv6 ──
V6=$(ip -6 addr show scope global 2>/dev/null | grep -oP 'inet6 \K[0-9a-f:]+' | grep -v '^fe80' | head -1)
[ -n "$V6" ] || { echo "找不到全局 IPv6 地址，退出" >&2; exit 1; }
echo "本机全局 IPv6: $V6"

# ── 装依赖 ──
if ! command -v nginx >/dev/null; then
  echo "安装 nginx ..."
  apt-get update -qq && apt-get install -y -qq nginx
fi
echo "nginx: $(nginx -v 2>&1)"

mkdir -p "$SSL_DIR" "$WEBROOT"

if [ "$MODE" = "selfsigned" ]; then
  # ── 阶段一：自签证书（先把链路跑通，证书晚点再换正式的）──
  echo "生成自签证书（SAN=IP:$V6，365 天）..."
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout "$SSL_DIR/api-relay.key" -out "$SSL_DIR/api-relay.crt" \
    -subj "/CN=api-relay" -addext "subjectAltName=IP:$V6" 2>/dev/null
  echo "  ✓ 自签证书就绪"
else
  # ── 阶段二：Let's Encrypt IP 证书 ──
  # IP 证书**只在 shortlived profile 下签发**（官方文档：classic/tlsserver 只支持 DNS），
  # 有效期约 6.7 天。certbot 需要 ≥4.x 才认识 --ip-address / --preferred-profile，
  # 所以走 snap 装（apt 里是 1.21.0，太老）。
  if ! certbot --version 2>/dev/null | grep -qE 'certbot ([4-9]|[1-9][0-9])\.'; then
    echo "安装新版 certbot（snap）..."
    snap install --classic certbot
    ln -sf /snap/bin/certbot /usr/bin/certbot
  fi
  echo "certbot: $(certbot --version 2>&1)"

  [ -n "$EMAIL" ] || { echo "阶段二需要邮箱：-m you@example.com" >&2; exit 2; }

  # nginx 先停，把 80 让给 certbot standalone；否则 ACME 校验会抢端口
  systemctl stop nginx || true
  echo "申请 IP 证书（http-01 需要外网能访问 [${V6}]:80）..."
  set +e
  certbot certonly --standalone \
    --ip-address "$V6" \
    --preferred-profile shortlived \
    --cert-name "$CERT_NAME" \
    --agree-tos -n -m "$EMAIL"
  RC=$?
  set -e
  if [ $RC -ne 0 ]; then
    echo "✗ 申请失败。最可能的原因：**IPv6 入站的 80 端口没放行** ——" >&2
    echo "  Let's Encrypt 要从公网连 [${V6}]:80 做校验，连不上就签不出来。" >&2
    echo "  先做手机测试确认 IPv6 入站，再回来跑这一步。" >&2
    systemctl start nginx || true
    exit $RC
  fi

  # 用 deploy hook 把证书拷到 nginx 读的固定路径 —— 这样 nginx 配置永远不用改
  cat > /etc/letsencrypt/renewal-hooks/deploy/api-relay-reload.sh <<'HOOK'
#!/bin/sh
set -e
cp /etc/letsencrypt/live/api-relay-v6/fullchain.pem /etc/nginx/ssl/api-relay.crt
cp /etc/letsencrypt/live/api-relay-v6/privkey.pem   /etc/nginx/ssl/api-relay.key
systemctl reload nginx
HOOK
  chmod +x /etc/letsencrypt/renewal-hooks/deploy/api-relay-reload.sh
  /etc/letsencrypt/renewal-hooks/deploy/api-relay-reload.sh
  echo "  ✓ 已切到 Let's Encrypt 证书（短周期，snap 的定时器会自动续）"
fi

# ── 装 nginx 配置 ──
install -m 644 "$CONF_SRC" "$NGINX_CONF"
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl start nginx
systemctl reload nginx

echo
echo "════════ 完成 ════════"
echo "  数据面: https://[${V6}]/v1        （443）"
echo "  备用口: https://[${V6}]:8443/v1"
echo "  ACME  : http://[${V6}]/.well-known/acme-challenge/  （80，仅签证书用）"
[ "$MODE" = "selfsigned" ] && echo "  ⚠ 现在是**自签证书**：客户端需要跳过校验。验通后跑 --letsencrypt 换正式的。"
echo
echo "  现在就用手测（手机开蜂窝数据，别连 WiFi）："
echo "    http://[${V6}]:${GATEWAY_PORT}/healthz     ← 这一步验的是「IPv6 入站有没有放行」"
echo "    通了才说明根因不在防火墙，再往下走。"
echo
echo "  回滚：systemctl stop nginx && rm -f $NGINX_CONF"
