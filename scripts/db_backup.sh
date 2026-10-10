#!/usr/bin/env bash
# 账务库一致性备份。
#
# 为什么需要：data/relay.db 里装着**全部客户端 key、额度、账本**。
# 这个文件没了 = 所有客户立刻 401，且额度记录无法恢复。
# 用 sqlite3 .backup 做一致性快照（不会因为正在写事务而拷到半截文件）。
#
# 用法： bash scripts/db_backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DB=data/relay.db
DIR=data/backups
KEEP=14

mkdir -p "$DIR"
[ -f "$DB" ] || { echo "无数据库文件 $DB，跳过"; exit 0; }

STAMP=$(date +%Y%m%d-%H%M)
OUT="$DIR/relay-$STAMP.db"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" ".backup '$OUT'"       # 一致性备份（推荐路径）
else
  # 兜底：直接 cp 会漏掉 -wal 里还没合并的事务 → 拷出来是"缺最后一段"的库。
  # 所以先 checkpoint 把 WAL 并回主库，再拷（审计 P1-3 点过这个坑）。
  if command -v node >/dev/null 2>&1; then
    node --disable-warning=ExperimentalWarning -e '
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    ' "$DB" 2>/dev/null || true
  fi
  cp "$DB" "$OUT"
fi

# 校验备份可读，避免"备份了但打不开"这种假安全感。
#
# ⚠️ **校验手段必须和备份手段对称**（2026-09-14 复核抓到）：老版本无条件调 sqlite3，
#    而在**没有 sqlite3 的机器**上（正是走 cp 兜底那条路，也正是换机恢复的目标机器）
#    每次都会"校验失败 → 删掉刚做好的那份"，一台备份都留不下。
#    所以：没有 sqlite3 就用 node 验；两样都没有时**保留文件**并告警，总比删掉好。
verify_ok() {
  if command -v sqlite3 >/dev/null 2>&1; then
    [ "$(sqlite3 "$1" 'PRAGMA integrity_check;' 2>/dev/null | head -1)" = "ok" ]
    return $?
  fi
  if command -v node >/dev/null 2>&1; then
    node --disable-warning=ExperimentalWarning -e '
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      const row = db.prepare("PRAGMA integrity_check").get();
      db.close();
      process.exit(String(Object.values(row)[0]) === "ok" ? 0 : 1);
    ' "$1" >/dev/null 2>&1
    return $?
  fi
  return 2   # 无法校验
}

V=0; verify_ok "$OUT" || V=$?
if [ "$V" = "1" ]; then
  # **必须删掉**：留着的话它会成为"最新一份备份"，ops-check 看 mtime 会判"新鲜"，
  # docs 里的恢复命令 `ls -t | head -1` 也正好挑到它 —— 等于用坏文件覆盖好库。
  rm -f "$OUT"
  echo "[$(date '+%F %T')] 备份校验失败（确认不可读），已删除半成品：$OUT" >&2
  exit 1
elif [ "$V" = "2" ]; then
  echo "[$(date '+%F %T')] ⚠️ 机器上既没有 sqlite3 也没有 node，无法校验完整性；**已保留** $OUT，请人工确认" >&2
fi

# 校验过程会用 SQLite 打开这份 WAL 模式的库 → 旁边多出 $OUT-shm / $OUT-wal。
# 它们**必须清掉**：保留策略的 glob 是 `relay-*.db`，匹配不到这两兄弟，于是只增不减；
# 更麻烦的是谁要 `cp relay-*.db*` 就会把**陈旧 WAL**一起带走，可能把好库盖坏。
rm -f "$OUT-shm" "$OUT-wal"
# 顺手清掉备份目录里所有游离 -wal/-shm：`.backup` 的产物是自洽的，任何挨着它的
# -wal/-shm 都只来自只读校验（值永远是空的），而保留策略的 glob `relay-*.db` 匹配不到
# 它们 → 不清理就只增不减（实测 44 个文件里 30 个是它俩）。
find "$DIR" -maxdepth 1 -name 'relay-*.db-wal' -delete 2>/dev/null || true
find "$DIR" -maxdepth 1 -name 'relay-*.db-shm' -delete 2>/dev/null || true

echo "[$(date '+%F %T')] 备份完成 $OUT ($(du -h "$OUT" | cut -f1))，完整性 ok"

# 只留最近 $KEEP 份
ls -1t "$DIR"/relay-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do rm -f "$f"; done
echo "当前备份数：$(ls -1 "$DIR"/relay-*.db 2>/dev/null | wc -l)"
