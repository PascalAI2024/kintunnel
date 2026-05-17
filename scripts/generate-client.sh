#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage:
  scripts/generate-client.sh <client-name> [owner]

Creates a client request JSON file for the future KinTunnel engine/admin API.
It does not generate keys yet because the runtime contract does not exist.
USAGE
}

name="${1:-}"
owner="${2:-}"

if [[ -z "$name" || "$name" == "-h" || "$name" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! "$name" =~ ^[A-Za-z0-9._-]+$ ]]; then
  printf 'Client name may only contain letters, numbers, dot, underscore, and hyphen.\n' >&2
  exit 1
fi

if [[ -n "$owner" && ! "$owner" =~ ^[A-Za-z0-9._[:space:]-]+$ ]]; then
  printf 'Owner may only contain letters, numbers, spaces, dot, underscore, and hyphen.\n' >&2
  exit 1
fi

REQUEST_DIR="${KINTUNNEL_CLIENT_REQUEST_DIR:-./tmp/client-requests}"
mkdir -p "$REQUEST_DIR"

request_file="${REQUEST_DIR%/}/${name}.json"
if [[ -e "$request_file" ]]; then
  printf 'Refusing to overwrite existing request: %s\n' "$request_file" >&2
  exit 1
fi

created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$request_file" <<JSON
{
  "name": "$name",
  "owner": "${owner:-$name}",
  "createdAt": "$created_at",
  "allowedIps": null,
  "dns": null,
  "persistentKeepalive": 25,
  "notes": "Request placeholder. Generate real keys only through the KinTunnel runtime once implemented."
}
JSON

printf 'Client request written: %s\n' "$request_file"
printf 'No WireGuard keys were generated. That waits for the runtime API, sensibly.\n'
