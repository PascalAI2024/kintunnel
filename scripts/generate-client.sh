#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage:
  scripts/generate-client.sh <client-name> [owner]

Creates a peer creation request JSON file for the KinTunnel engine API.
The engine can generate WireGuard keys server-side when generate_keys is true.
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
  "created_at": "$created_at",
  "generate_keys": true,
  "allowed_ips": ["0.0.0.0/0"],
  "dns_servers": ["1.1.1.1"],
  "persistent_keepalive": 25,
  "notes": "Submit name, generate_keys, allowed_ips, dns_servers, and persistent_keepalive to POST /v1/peers. Do not put private keys in tickets."
}
JSON

printf 'Client request written: %s\n' "$request_file"
printf 'Submit this through the admin UI or engine API when ready.\n'
