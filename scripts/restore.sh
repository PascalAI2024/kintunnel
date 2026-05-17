#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage:
  scripts/restore.sh <backup.tar.gz>
  KINTUNNEL_RESTORE_CONFIRM=restore scripts/restore.sh <backup.tar.gz>

Default mode is a dry run. Confirmed mode extracts into ./restore-<timestamp>.
It does not overwrite live config or data. Dull, but much less dramatic.
USAGE
}

archive="${1:-}"
if [[ -z "$archive" || "$archive" == "-h" || "$archive" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -f "$archive" ]]; then
  printf 'Backup archive not found: %s\n' "$archive" >&2
  exit 1
fi

if [[ -f "${archive}.sha256" ]]; then
  sha256sum -c "${archive}.sha256"
else
  printf '[warn] No checksum file found next to archive.\n' >&2
fi

printf 'Archive contents:\n'
tar -tzf "$archive" | sed 's/^/  /'

if [[ "${KINTUNNEL_RESTORE_CONFIRM:-}" != "restore" ]]; then
  printf '\nDry run only. Set KINTUNNEL_RESTORE_CONFIRM=restore to extract into a restore directory.\n'
  exit 0
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="restore-${STAMP}"
mkdir -p "$TARGET"
tar -xzf "$archive" -C "$TARGET"

printf 'Restored archive into %s\n' "$TARGET"
printf 'Review it, then manually promote files into config/data during a maintenance window.\n'
