#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Daily SQLite backup for codm-wager-bot
# ═══════════════════════════════════════════════════════════
#
# Add to crontab with: crontab -e
# 0 3 * * * /path/to/codm-wager-bot/scripts/backup-db.sh >> /path/to/codm-wager-bot/data/backups/backup.log 2>&1
#
# Safe to run multiple times per day — overwrites the same date's backup.
# Keeps only the last 30 backups.
# ═══════════════════════════════════════════════════════════

set -euo pipefail

# Resolve project root (one level up from scripts/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DB_PATH="$PROJECT_DIR/data/codm-wager.db"
BACKUP_DIR="$PROJECT_DIR/data/backups"
TODAY="$(date +%Y-%m-%d)"
BACKUP_FILE="$BACKUP_DIR/codm-wager-${TODAY}.db"

# Ensure backup directory exists
mkdir -p "$BACKUP_DIR"

# Verify source DB exists
if [ ! -f "$DB_PATH" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: Database not found at $DB_PATH"
  exit 1
fi

# Use SQLite .backup command if sqlite3 is available (handles WAL mode safely),
# otherwise fall back to cp
if command -v sqlite3 &>/dev/null; then
  sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backed up (sqlite3 .backup) -> $BACKUP_FILE"
else
  cp "$DB_PATH" "$BACKUP_FILE"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backed up (cp) -> $BACKUP_FILE"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: sqlite3 not found — WAL data may not be included. Install sqlite3 for safe backups."
fi

# Prune old backups — keep only the 30 most recent
BACKUP_COUNT=$(ls -1 "$BACKUP_DIR"/codm-wager-*.db 2>/dev/null | wc -l | tr -d ' ')
if [ "$BACKUP_COUNT" -gt 30 ]; then
  REMOVE_COUNT=$((BACKUP_COUNT - 30))
  ls -1t "$BACKUP_DIR"/codm-wager-*.db | tail -n "$REMOVE_COUNT" | while read -r old; do
    rm -f "$old"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pruned old backup: $(basename "$old")"
  done
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Done. $BACKUP_COUNT backup(s) in $BACKUP_DIR (max 30)."
