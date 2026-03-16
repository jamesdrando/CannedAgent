#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Edit these fixtures to whatever accounts you want to keep around locally.
USER_FIXTURES=(
  "owner|owner@example.com|ownerpass123|1"
  "friend|friend@example.com|friendpass123|0"
)

if [[ -n "${DATABASE_URL:-}" ]]; then
  case "$DATABASE_URL" in
    sqlite:///*) DB_FILE="${DATABASE_URL#sqlite:///}" ;;
    *)
      echo "This script currently supports sqlite DATABASE_URL values only." >&2
      exit 1
      ;;
  esac
else
  DB_FILE="$ROOT_DIR/data/canned_agent.db"
fi

if [[ ! -f "$DB_FILE" ]]; then
  echo "Database not found at $DB_FILE" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required to run this script." >&2
  exit 1
fi

if [[ -x "$ROOT_DIR/venv/bin/python" ]]; then
  PYTHON_BIN="$ROOT_DIR/venv/bin/python"
else
  PYTHON_BIN="python3"
fi

SQL_FILE="$(mktemp)"
trap 'rm -f "$SQL_FILE"' EXIT

cat > "$SQL_FILE" <<'SQL'
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
DELETE FROM session_records
WHERE user_id IN (
  SELECT id FROM users
  WHERE normalized_email = 'admin@example.com' OR normalized_username = 'admin'
);
DELETE FROM messages
WHERE chat_id IN (
  SELECT id FROM chats
  WHERE user_id IN (
    SELECT id FROM users
    WHERE normalized_email = 'admin@example.com' OR normalized_username = 'admin'
  )
);
DELETE FROM chats
WHERE user_id IN (
  SELECT id FROM users
  WHERE normalized_email = 'admin@example.com' OR normalized_username = 'admin'
);
DELETE FROM users
WHERE normalized_email = 'admin@example.com' OR normalized_username = 'admin';
SQL

for fixture in "${USER_FIXTURES[@]}"; do
  IFS='|' read -r username email password is_admin <<< "$fixture"

  normalized_username="$(printf '%s' "$username" | tr '[:upper:]' '[:lower:]')"
  normalized_email="$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]')"

  cat >> "$SQL_FILE" <<SQL
DELETE FROM session_records
WHERE user_id IN (
  SELECT id FROM users
  WHERE normalized_email = '$normalized_email' OR normalized_username = '$normalized_username'
);
DELETE FROM messages
WHERE chat_id IN (
  SELECT id FROM chats
  WHERE user_id IN (
    SELECT id FROM users
    WHERE normalized_email = '$normalized_email' OR normalized_username = '$normalized_username'
  )
);
DELETE FROM chats
WHERE user_id IN (
  SELECT id FROM users
  WHERE normalized_email = '$normalized_email' OR normalized_username = '$normalized_username'
);
DELETE FROM users
WHERE normalized_email = '$normalized_email' OR normalized_username = '$normalized_username';
SQL

  "$PYTHON_BIN" - "$username" "$email" "$password" "$is_admin" >> "$SQL_FILE" <<'PY'
import sys
from uuid import uuid4

from src.auth import hash_password, normalize_email, normalize_username
from src.models import utcnow

username, email, password, is_admin = sys.argv[1:]
hashed_password, password_salt = hash_password(password)
timestamp = utcnow().isoformat()

def sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"

print(
    "INSERT INTO users ("
    "id, username, normalized_username, email, normalized_email, "
    "hashed_password, password_salt, is_admin, is_active, "
    "created_at, updated_at, password_updated_at"
    ") VALUES ("
    f"{sql_string(uuid4().hex)}, "
    f"{sql_string(username)}, "
    f"{sql_string(normalize_username(username))}, "
    f"{sql_string(email)}, "
    f"{sql_string(normalize_email(email))}, "
    f"{sql_string(hashed_password)}, "
    f"{sql_string(password_salt)}, "
    f"{int(is_admin)}, "
    "1, "
    f"{sql_string(timestamp)}, "
    f"{sql_string(timestamp)}, "
    f"{sql_string(timestamp)}"
    ");"
)
PY
done

echo "COMMIT;" >> "$SQL_FILE"

sqlite3 "$DB_FILE" < "$SQL_FILE"

echo
echo "Updated users in $DB_FILE"
echo "Remember to start the app with SEED_DEFAULT_ADMIN=0 if you do not want the stock admin recreated."
echo
echo "Created accounts:"
for fixture in "${USER_FIXTURES[@]}"; do
  IFS='|' read -r username email password is_admin <<< "$fixture"
  role="user"
  if [[ "$is_admin" == "1" ]]; then
    role="admin"
  fi
  echo "  - $username <$email> [$role] password: $password"
done
