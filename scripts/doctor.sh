#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

pass() { printf '[ok] %s\n' "$*"; }
warn() { printf '[warn] %s\n' "$*" >&2; }
fail() { printf '[fail] %s\n' "$*" >&2; return 1; }

status=0

check_command() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    pass "$name found: $(command -v "$name")"
  else
    fail "$name is not installed or not on PATH" || status=1
  fi
}

check_command docker

if docker compose version >/dev/null 2>&1; then
  pass "docker compose plugin available"
else
  fail "docker compose plugin is not available" || status=1
fi

if [[ -f .env ]]; then
  pass ".env exists"
else
  warn ".env is missing; copy .env.example to .env and edit it"
fi

if [[ -f config/kintunnel.yml ]]; then
  pass "config/kintunnel.yml exists"
else
  warn "config/kintunnel.yml missing; copy config/kintunnel.example.yml when runtime config lands"
fi

if [[ -f config/secrets/admin-token.txt ]]; then
  pass "admin token file exists"
else
  warn "config/secrets/admin-token.txt missing; create it with: openssl rand -base64 32 > config/secrets/admin-token.txt"
fi

if [[ -f config/secrets/engine-api-token.txt ]]; then
  pass "engine API token file exists"
else
  warn "config/secrets/engine-api-token.txt missing; create it with: openssl rand -base64 32 > config/secrets/engine-api-token.txt"
fi

if [[ -c /dev/net/tun ]]; then
  pass "/dev/net/tun is available"
else
  fail "/dev/net/tun is missing; WireGuard containers need TUN support" || status=1
fi

if command -v sysctl >/dev/null 2>&1; then
  ipv4_forward="$(sysctl -n net.ipv4.ip_forward 2>/dev/null || true)"
  if [[ "$ipv4_forward" == "1" ]]; then
    pass "net.ipv4.ip_forward=1"
  else
    warn "net.ipv4.ip_forward is '${ipv4_forward:-unknown}'; enable forwarding on the host for full tunnel egress"
  fi

  src_valid_mark="$(sysctl -n net.ipv4.conf.all.src_valid_mark 2>/dev/null || true)"
  if [[ "$src_valid_mark" == "1" ]]; then
    pass "net.ipv4.conf.all.src_valid_mark=1"
  else
    warn "net.ipv4.conf.all.src_valid_mark is '${src_valid_mark:-unknown}'; Compose sets it in-container, but host policy may still matter"
  fi
else
  warn "sysctl not found; skipping kernel parameter checks"
fi

compose_env_args=()
if [[ ! -f .env && -f .env.example ]]; then
  compose_env_args=(--env-file .env.example)
fi

if docker compose "${compose_env_args[@]}" --profile admin config >/dev/null; then
  pass "docker compose config renders"
else
  fail "docker compose config failed; check .env values and compose syntax" || status=1
fi

if [[ "$status" -eq 0 ]]; then
  printf 'Doctor completed without hard failures.\n'
else
  printf 'Doctor found hard failures.\n' >&2
fi

exit "$status"
