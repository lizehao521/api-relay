#!/usr/bin/env bash
#
# 导出一份**可恢复的机密包**。
#
# ─────────────────────────────────────────────────────────────────────
# 为什么必须有这个脚本（2026-09-14 交叉审计的 P0）
# ─────────────────────────────────────────────────────────────────────
# 下面这些东西**只有本机一份，且不在任何备份里**：
#   · .relay-net.env      —— 4 个厂商 key + 管理令牌的**唯一副本**
#   · data/relay.db       —— 全部客户 key（哈希）、额度、账目
#   · .relay-vendor-keys.txt / .relay-sale-key.txt —— 发给客户的明文 key
# 磁盘坏、换机、误删，任何一件发生 = 网关起不来（start-net.sh 缺环境变量直接退出）
# + 客户 key 全丢（他们全部 401）。
#
# 所以：定期跑本脚本，把产物**拷到本机之外**（自己的电脑 / 对象存储 / U 盘）。
# 拷出去这一步脚本管不到，所以它只做两件事：打包 + 提醒。
# 另有 scripts/ops-check.sh 会盯着"最近一次导出是多久以前"，超过 7 天就报红。
#
# 用法：
#   bash scripts/export-secrets.sh              # 打到默认目录 data/export/
#   bash scripts/export-secrets.sh /tmp/带走    # 打到指定目录
#
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="${1:-data/export}"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR" 2>/dev/null || true

# ── 1. 环境变量（厂商 key + 管理令牌）───────────────────────────────
if [ ! -f .relay-net.env ]; then
  echo "❌ 找不到 .relay-net.env —— 没有它网关根本起不来，请先确认文件在哪" >&2
  exit 1
fi
install -m 600 .relay-net.env "$WORK/relay-net.env"

# ── 2. 数据库：用 sqlite3 的一致性备份（能拿到 WAL 里还没合并的事务）──
DB="data/relay.db"
if [ -f "$DB" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB" ".backup '$WORK/relay.db'"
  else
    # 没有 sqlite3 时先 checkpoint 再拷 —— 直接 cp 会漏掉 -wal 里最近的事务，
    # 恢复出来是"缺了最后一段"的库（审计 P1-3 点过这个坑）
    if command -v node >/dev/null 2>&1; then
      node --disable-warning=ExperimentalWarning -e '
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(process.argv[1]);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.close();
      ' "$DB" 2>/dev/null || true
    fi
    cp "$DB" "$WORK/relay.db"
  fi
  # 校验：备份必须能打开且完整，否则这个包是假的安全感
  if command -v sqlite3 >/dev/null 2>&1; then
    if [ "$(sqlite3 "$WORK/relay.db" 'PRAGMA integrity_check;' 2>/dev/null | head -1)" != "ok" ]; then
      echo "❌ 数据库备份校验失败，已中止（不生成半成品包）" >&2
      exit 1
    fi
  fi
else
  echo "⚠️  没有 $DB（还没跑过网关？），本次只导出环境变量" >&2
fi

# ── 3. 对外凭据文本（发给客户的那些明文 key）────────────────────────
for f in .relay-vendor-keys.txt .relay-sale-key.txt .relay-external-key.txt .relay-dynv6.env .relay-funnel-url; do
  [ -f "$f" ] && install -m 600 "$f" "$WORK/$(basename "$f")"
done

# ── 4. 恢复说明（换机时照着做就行）─────────────────────────────────
cat > "$WORK/RESTORE.md" <<'DOC'
# 恢复步骤（换机 / 磁盘坏之后）

机密的来源就是本包。按顺序做：

1. **恢复环境变量**（缺它网关直接退出，这是第一个坑）
   ```
   install -m 600 relay-net.env  <项目>/.relay-net.env
   ```
   里面是：AGNES_API_KEY / AGNES_CN_API_KEY / MIMO_API_KEY / TOKENRHYTHM_API_KEY /
   RELAY_ADMIN_TOKEN / RELAY_KEY_FREE|STANDARD|PRO、以及 DDNS token。

2. **恢复数据库**（客户 key 的哈希、额度、账目都在里面）
   ```
   bash start-net.sh stop
   # ⚠️ 先停 keeper，再动库 —— 它每 10 秒会把网关拉起来，抢着写库
   kill "$(cat logs/.keepalive.pid)" 2>/dev/null || true
   cp relay.db <项目>/data/relay.db
   rm -f <项目>/data/relay.db-wal <项目>/data/relay.db-shm
   ```

3. **起服务并自检**
   ```
   bash start-net.sh start
   bash scripts/ops-check.sh
   curl -s localhost:8787/healthz
   ```

4. **注意**：库回滚到导出那一刻 = **导出之后新签发的客户 key 会全部 401**、
   额度也回退。要么先把这些 key 记下来重发，要么改用更新的包。

5. 机器/环境变量/DDNS/Funnel 的完整说明见 `docs/MAINTENANCE.md`。
DOC

# ── 5. 打包 ────────────────────────────────────────────────────────
OUT="$OUT_DIR/relay-secrets-$STAMP.tar.gz"
tar -czf "$OUT" -C "$WORK" .
chmod 600 "$OUT"

# 只留最近 14 份（每份约 0.5MB；本机那份是"方便恢复"用的，
# 真正防灾的是你拷出去的那一份）
KEEP=14
ls -1t "$OUT_DIR"/relay-secrets-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do rm -f "$f"; done

echo "✅ 机密包已生成：$OUT"
echo "   内容：$(tar -tzf "$OUT" | tr '\n' ' ')"
echo "   大小：$(du -h "$OUT" | cut -f1)"
echo
echo "⚠️  还没完 —— 这个包现在和原始机密在**同一块盘**上，磁盘坏了照样一起没。"
echo "    请立刻把它拷到本机之外（自己的电脑 / 对象存储 / U 盘），例如："
echo "      scp '$OUT' 你的电脑:~/"
echo "    ops-check.sh 会检查最近一次导出的时间，超过 7 天会报红。"
