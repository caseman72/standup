#!/bin/bash

MEMOS_DIR="$HOME/.memos"
DB_FILE="$MEMOS_DIR/memos_prod.db"
BACKUP_DIR="$MEMOS_DIR/dbBackups"
CONTAINER_NAME="memos"

echo "=== Memos Database Recovery ==="
echo

# Check if container is running
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "* Container is running ✓"
else
    echo "* Container is NOT running ✗"
    echo "  Start the container first: docker start $CONTAINER_NAME"
    exit 1
fi

# Check if database is corrupted
echo -n "* Checking database integrity... "
INTEGRITY=$(sqlite3 "$DB_FILE" "PRAGMA integrity_check;" 2>&1)
if [ "$INTEGRITY" = "ok" ]; then
    echo "database is OK ✓"
    echo "  No repair needed."
    exit 0
else
    echo "SQL is corrupted ✗"
    echo "  Error: $INTEGRITY"
fi

# Find latest backup
LATEST_BACKUP=$(ls -t "$BACKUP_DIR"/memos_prod.*.db 2>/dev/null | grep -v '\-shm$' | grep -v '\-wal$' | head -1)
if [ -z "$LATEST_BACKUP" ]; then
    echo "* No backups found in $BACKUP_DIR ✗"
    exit 1
fi

echo "* Latest backup: $(basename "$LATEST_BACKUP")"

# Verify backup is valid
echo -n "* Verifying backup integrity... "
BACKUP_CHECK=$(sqlite3 "$LATEST_BACKUP" "PRAGMA integrity_check;" 2>&1)
if [ "$BACKUP_CHECK" = "ok" ]; then
    echo "backup is valid ✓"
else
    echo "backup is corrupted ✗"
    echo "  Try an older backup manually."
    exit 1
fi

# Ask for confirmation
echo
read -p "* Restore from this backup? [Y/n] " -n 1 -r
echo
if [[ $REPLY =~ ^[Nn]$ ]]; then
    echo "  Aborted."
    exit 0
fi

# Perform restore
echo "* Restoring..."
docker stop "$CONTAINER_NAME" > /dev/null 2>&1
mv "$DB_FILE" "$DB_FILE.corrupted.$(date +%Y%m%d-%H%M%S)"
rm -f "$DB_FILE-shm" "$DB_FILE-wal"
cp "$LATEST_BACKUP" "$DB_FILE"
docker start "$CONTAINER_NAME" > /dev/null 2>&1

# Verify it's working
sleep 2
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "* Restored ✓"
    echo
    echo "Memos is back online at http://localhost:5230"
else
    echo "* Container failed to start ✗"
    exit 1
fi
