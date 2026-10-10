#!/usr/bin/env bash
# 一行体验：mock 上游 + 网关 + 看板 + 自检，全部在这一个进程里，无需任何密钥。
#
#   bash demo.sh                  # 默认 127.0.0.1:8787
#   bash demo.sh --port 9000      # 换端口（默认会自动避让被占用的端口）
#
set -euo pipefail
cd "$(dirname "$0")"
[ -d dist ] || { echo "首次运行，正在构建…"; npm run build --silent; }
exec node --disable-warning=ExperimentalWarning dist/cli.js demo "$@"
