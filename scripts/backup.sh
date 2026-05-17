#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="${KINTUNNEL_BACKUP_DIR:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="${BACKUP_DIR%/}/kintunnel-backup-${STAMP}.tar.gz"

mkdir -p "$BACKUP_DIR"

if [[ ! -d config ]]; then
  printf 'Missing config directory; nothing sensible to back up.\n' >&2
  exit 1
fi

printf 'Creating backup: %s\n' "$ARCHIVE"
printf 'This captures local config plus any local data directory. Docker named volumes require runtime support not present in this scaffold.\n'

paths=(config)
local_data="${KINTUNNEL_INCLUDE_LOCAL_DATA:-data}"
if [[ -d "$local_data" ]]; then
  paths+=("$local_data")
else
  printf '[warn] Local data directory not found, skipping: %s\n' "$local_data" >&2
fi

tar \
  --exclude './backups' \
  --exclude './tmp' \
  --exclude './*.log' \
  -czf "$ARCHIVE" \
  "${paths[@]}"

sha256sum "$ARCHIVE" > "${ARCHIVE}.sha256"

printf 'Backup written.\n'
printf 'Checksum: %s\n' "${ARCHIVE}.sha256"
