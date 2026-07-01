# Operations Runbook

This runbook covers the operator-facing surfaces of a live KinTunnel deployment. It assumes the engine and admin containers are running from the stock Compose stack. For install and initial bring-up see [Quick Start](quick-start.md) and [Docker Compose Installation](installation/docker-compose.md).

## Environment Variables

All variables use the `KINTUNNEL_*` namespace. The `*_FILE` suffix form reads from a file path (secrets bind-mounted under `/etc/kintunnel/secrets`).

### Engine

| Variable | Type | Default | Semantics |
|---|---|---|---|
| `KINTUNNEL_ENV` | enum (`development` \| `production`) | `production` | Controls log verbosity and error verbosity in responses. |
| `KINTUNNEL_DRY_RUN` | bool | `true` | When `true`, validate state and render configs without touching host networking. Flip to `false` after the host passes the deep health report. |
| `KINTUNNEL_ENABLE_HOST_NETWORKING` | bool | `false` | Hard gate for `wg` / `ip link` / `iptables` exec. Without this, the apply path is a no-op even in non-dry-run. |
| `KINTUNNEL_NAT_APPLY` | bool | `false` | When `true`, `networking.apply()` runs `iptables` / `sysctl`. Off by default so a half-configured Compose boot stays non-destructive. |
| `KINTUNNEL_FORWARDING_REQUIRED` | bool | `true` | When `true`, `health.tun` and `health.forwarding` are required; when `false`, they warn only. |
| `KINTUNNEL_WG_EGRESS_INTERFACE` | string | unset (auto) | Override the egress interface for MASQUERADE. If unset, the engine resolves from the default route. |
| `KINTUNNEL_DATA_DIR` | path | `/var/lib/kintunnel` | Where `state.json` lives. |
| `KINTUNNEL_BACKUP_DIR` | path | `/backups` | Snapshot directory. Must be on the same filesystem as `KINTUNNEL_DATA_DIR` for atomic rename. |
| `KINTUNNEL_BACKUP_RETENTION_COUNT` | int (1-1000) | `10` | Number of snapshots kept by the retention pruner. |
| `KINTUNNEL_BACKUP_LOCK_TIMEOUT_MS` | int (1000-300000) | `30000` | Max wait acquiring the exclusive lock on `/backups/.lock`. |
| `KINTUNNEL_APPLY_BOOTSTRAP_TIMEOUT_MS` | int (1000-120000) | `15000` | Max wait for the `ip link add → wg setconf → ip addr → ip link up` cold-start sequence. |
| `KINTUNNEL_LOG_LEVEL` | enum (`debug` \| `info` \| `warn` \| `error`) | `info` | NDJSON log threshold. Set `debug` for verbose apply path tracing. |
| `KINTUNNEL_AUDIT_LOG_ROTATION_BYTES` | int | `5242880` | Persistent audit log rotates when it exceeds this size. |
| `KINTUNNEL_AUDIT_LOG_RETENTION_COUNT` | int (1-100) | `10` | Number of rotated audit files kept. |
| `KINTUNNEL_ENGINE_PORT` | port | `9090` | Internal HTTP API port. Do not publish outside the Compose network. |
| `KINTUNNEL_PUBLIC_ENDPOINT` | host:port | unset | Public address advertised to peers in their configs. |

### Secrets (always via `_FILE` form)

| Variable | Form | Required | Notes |
|---|---|---|---|
| `KINTUNNEL_ADMIN_TOKEN` | string or `_FILE` | yes | Admin UI bearer token. Min 32 chars in production; see `assertStrongEngineApiToken` for the engine-side check. |
| `KINTUNNEL_ENGINE_API_TOKEN` | string or `_FILE` | yes | Engine API bearer token. Same strength check. |

## First-Run Checklist

1. **Generate the admin token.** Use `openssl rand -base64 48` (or longer) and write it to `config/secrets/admin-token.txt` with `chmod 0400`.
2. **Generate the engine API token.** Distinct from the admin token. Same strength requirement. Write to `config/secrets/engine-api-token.txt`.
3. **Configure the public endpoint.** Set `KINTUNNEL_PUBLIC_ENDPOINT=your.vps.example:51820` in `.env`. This is the address embedded in generated peer configs.
4. **Leave `KINTUNNEL_DRY_RUN=true` for the first boot.** It validates state without touching the host. Compose up the stack and verify the engine's `/health` reports `ok=true` with `state_io` passing.
5. **Verify `/v1/capabilities`.** Confirm `hasWg`, `hasWgQuick`, `hasTun` are all `true`. Any `false` here means a missing capability on the host or in the image.
6. **When ready for live mode:** flip `KINTUNNEL_DRY_RUN=false` and `KINTUNNEL_NAT_APPLY=true` in the minimal-VPS overlay, then `docker compose up -d`. Wait for the engine to report `ok=true` and `apply.interface.created` in the audit log.
7. **Set `KINTUNNEL_LOG_LEVEL=info`** for production. Use `debug` only when troubleshooting apply path issues — it generates significant log volume.

## Backup Runbook

The engine exposes seven backup endpoints on the `/v1/backups` family. All require `Authorization: Bearer $KINTUNNEL_ENGINE_API_TOKEN`.

### Create a snapshot

```bash
curl -X POST -H "Authorization: Bearer $KINTUNNEL_ENGINE_API_TOKEN" \
     http://localhost:9090/v1/backups \
     -H "Content-Type: application/json" \
     -d '{"trigger":"manual"}'
```

Response (201):

```json
{
  "snapshot_id": "0190a3b4-7c2e-7def-8a1b-2c4d5e6f7890",
  "created_at": "2026-06-29T12:00:00.000Z",
  "engine_revision": 42,
  "trigger": "manual",
  "size_bytes": 8192,
  "file_count": 2,
  "corrupt": false
}
```

### List snapshots

```bash
curl -H "Authorization: Bearer $KINTUNNEL_ENGINE_API_TOKEN" \
     http://localhost:9090/v1/backups
```

Pass `?corrupt_only=true` to surface snapshots whose manifest failed SHA-256 verification. The engine does not delete corrupt snapshots automatically — operators decide.

### Read a manifest

```bash
curl -H "Authorization: Bearer $KINTUNNEL_ENGINE_API_TOKEN" \
     http://localhost:9090/v1/backups/snap-<id>
```

Returns both the `BackupSummary` and the full `BackupManifest`, including per-file SHA-256 hashes.

### Dry-run a restore (restore plan)

```bash
curl -X POST -H "Authorization: Bearer $KINTUNNEL_ENGINE_API_TOKEN" \
     http://localhost:9090/v1/backups/restore-plan \
     -H "Content-Type: application/json" \
     -d '{"snapshot_id":"snap-<id>"}'
```

Response carries `peer_changes.added`, `peer_changes.removed`, `peer_changes.modified`, plus `affected_public_keys` and any `warnings[]`. Use this to preview impact before applying.

### Apply a restore

```bash
curl -X POST -H "Authorization: Bearer $KINTUNNEL_ENGINE_API_TOKEN" \
     http://localhost:9090/v1/backups/snap-<id>/restore \
     -H "Content-Type: application/json" \
     -d '{"apply": true}'
```

The engine takes a safety snapshot first (`trigger: "pre-rotate"`) and returns its `snapshot_id` in the response. After the swap, **operators MUST call `POST /v1/reconcile`** to push the restored state onto the WireGuard interface — see [Restore Disaster Scenarios](#restore-disaster-scenarios).

Pass `"force": true` to skip the safety snapshot when you are certain you want to overwrite without rollback.

### Export a snapshot

```bash
curl -H "Authorization: Bearer $KINTUNNEL_ENGINE_API_TOKEN" \
     -o snap-<id>.json \
     http://localhost:9090/v1/backups/snap-<id>/export
```

Returns a JSON wrapper carrying the manifest, base64-encoded `state.json`, and the SHA-256 of the state. Suitable for off-host archival or migration to a new VPS.

### Delete a snapshot

```bash
curl -X DELETE -H "Authorization: Bearer $KINTUNNEL_ENGINE_API_TOKEN" \
     http://localhost:9090/v1/backups/snap-<id>
```

Refuses to delete the **most-recent** snapshot to prevent accidental loss. If you really need to delete it, delete an older snapshot first so the target is no longer the newest.

## Restore Disaster Scenarios

### Lost peer data

A peer was created and its private key was lost from the admin UI's recent activity. The server still has the peer config and the public key, so the peer can technically still connect — but without its private key the device cannot reconnect after a fresh WireGuard client install.

**Recovery:** restore the most-recent snapshot from before the peer was created. This regenerates the peer's private key on the server side and re-renders the config.

```bash
# 1. List snapshots, find the most recent one before the lost peer
curl -H "Authorization: Bearer $KINTUNNEL_ENGINE_API_TOKEN" \
     http://localhost:9090/v1/backups

# 2. Restore it (safety snapshot is automatic)
curl -X POST -H "Authorization: Bearer $KINTUNNEL_ENGINE_API_TOKEN" \
     http://localhost:9090/v1/backups/snap-<id>/restore \
     -H "Content-Type: application/json" \
     -d '{"apply": true}'

# 3. Push the restored state to WireGuard
curl -X POST -H "Authorization: Bearer $KINTUNNEL_ENGINE_API_TOKEN" \
     http://localhost:9090/v1/reconcile
```

### Bad peer creation

A peer was created with a typo, the wrong AllowedIPs, or against the wrong person. The peer config is broken and the device on the other end cannot connect.

**Recovery:** restore the snapshot from immediately before the bad creation. If you took a snapshot just before (`trigger: "manual"`), use it. Otherwise restore the previous nightly / scheduled snapshot and accept that other changes since then are also rolled back.

### Engine restart after restore

The restore endpoint swaps `state.json` on disk but does **not** automatically reconcile onto the WireGuard interface. After a successful `apply: true` restore, the operator MUST call `POST /v1/reconcile`:

```bash
curl -X POST -H "Authorization: Bearer $KINTUNNEL_ENGINE_API_TOKEN" \
     http://localhost:9090/v1/reconcile
```

Without this step, the live `wg0` interface keeps its old peer set while the engine's `state.json` reflects the snapshot. The `/health` endpoint will surface this divergence as a `drift.detected` event in the audit log and as `ok=false` if `health.interface` runs against the live interface.

## Health Monitoring

The engine exposes three health endpoints with escalating depth:

- **`/health`** — unauthenticated, container-orchestrator-friendly. Returns the same `HealthReport` shape as `/v1/health`.
- **`/v1/health`** — bearer-token-gated equivalent of `/health`. Same shape.
- **`/v1/capabilities`** — informational inventory (`hasWg`, `hasWgQuick`, `hasTun`, `hasIptables`, `ipForward`, …). Never returns a non-200 status; it is a static capability dump.

### When `/health` returns 503

A 503 means at least one **required** check failed. Inspect `checks[]` to find which one:

```json
{
  "ok": false,
  "checks": [
    {"name": "tun", "status": "fail", "detail": "/dev/net/tun not readable", "required": true},
    {"name": "state_io", "status": "pass", "detail": "ok", "required": true}
  ],
  "required_failing": ["tun"],
  "warnings": []
}
```

| Failing check | Likely cause | Fix |
|---|---|---|
| `tun` | `/dev/net/tun` not exposed to the engine container | Add `devices: [/dev/net/tun:/dev/net/tun]` to the engine service in `docker-compose.yml` and restart. |
| `forwarding` | `net.ipv4.ip_forward=0` and `KINTUNNEL_FORWARDING_REQUIRED=true` | Either flip the sysctl on the host (`sysctl -w net.ipv4.ip_forward=1`) or set `KINTUNNEL_FORWARDING_REQUIRED=false`. |
| `interface` | WireGuard interface is missing or down | Call `POST /v1/reconcile`. If it persists, check `/v1/capabilities` — `hasWg` may be false. |
| `nat` | MASQUERADE rule absent and `KINTUNNEL_NAT_APPLY=true` | Inspect `iptables -t nat -S POSTROUTING` on the host. Either re-run reconcile or set `KINTUNNEL_NAT_APPLY=false` if you do not need NAT. |
| `iptables` | `iptables` binary not invokable from the engine container | Confirm `cap_add NET_ADMIN` is present and the engine image has `iptables` installed. |
| `state_io` | `state.json` unreadable / unwritable | Check the `kintunnel-data` named volume is mounted and disk is not full. |

The `port` check is warn-only by design — UDP reachability is best-effort and does not flip the engine to `ok=false`.

## Metrics Scraping

The engine exposes Prometheus text exposition at `/metrics`. No `prom-client` dependency; the engine emits a minimal text serializer itself.

Example Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: kintunnel-engine
    scheme: http
    static_configs:
      - targets: ['kintunnel-engine:9090']
    metrics_path: /metrics
    scrape_interval: 30s
    bearer_token_file: /etc/prometheus/secrets/kintunnel-engine-api-token
```

Note: `/metrics` is **not** currently bearer-token-gated in v1 because Prometheus needs to scrape it without credential rotation; if you scrape over a public network, put a reverse proxy with mTLS in front.

### Metrics emitted

| Kind | Series |
|---|---|
| Counter | `kintunnel_peers_total`, `kintunnel_peers_active`, `kintunnel_peers_revoked`, `kintunnel_peers_deleted`, `kintunnel_reconcile_runs_total`, `kintunnel_reconcile_failures_total`, `kintunnel_apply_failures_total`, `kintunnel_backup_creates_total`, `kintunnel_backup_restores_total` |
| Gauge | `kintunnel_state_revision`, `kintunnel_last_reconcile_timestamp_seconds`, `kintunnel_last_apply_duration_seconds`, `kintunnel_peers_active` |
| Histogram | `kintunnel_reconcile_duration_seconds`, `kintunnel_apply_duration_seconds` |

## Audit Log Query

The persistent audit log is queryable via `GET /v1/audit`:

```bash
# All apply path events
curl -H "Authorization: Bearer $KINTUNNEL_ENGINE_API_TOKEN" \
     "http://localhost:9090/v1/audit?action=apply.peer.removed"

# Backup lifecycle events from a specific actor
curl -H "Authorization: Bearer $KINTUNNEL_ENGINE_API_TOKEN" \
     "http://localhost:9090/v1/audit?action=backup.&actor=engine"

# Everything since a timestamp
curl -H "Authorization: Bearer $KINTUNNEL_ENGINE_API_TOKEN" \
     "http://localhost:9090/v1/audit?since=2026-06-29T00:00:00Z"
```

Filters combine with `AND`. Use `action=prefix.` (with the trailing dot) to fetch all actions in a namespace (e.g. `apply.`, `backup.`, `networking.`).

### Known gap

Audit events emitted directly from `state.ts` (peer lifecycle: `peer.created`, `peer.revoked`, `peer.deleted`) currently land in the **ring buffer** (`state.events`) and in `/v1/status` recent activity, but they do not all flow into the **persistent NDJSON** sink. The reconcile path is fully covered. Operators relying on durable peer lifecycle history should treat the ring buffer as the source of truth until Wave 4 closes this seam — see [architecture.md](architecture.md#audit-pipeline).

## Log Level Tuning

`KINTUNNEL_LOG_LEVEL` filters NDJSON output to stdout:

```yaml
environment:
  KINTUNNEL_LOG_LEVEL: info   # default in production
```

- `debug` — verbose apply path tracing (`planApply`, `executeApply` step boundaries, per-peer `wg set` invocations). Heavy volume; use only during incident triage.
- `info` — startup, lifecycle events, reconcile start/stop, backup create/restore. The default.
- `warn` — degraded operation (port probe failed, idempotent rule insertion skipped, partial rollback).
- `error` — failed applies, lock timeouts, restore failures. Always emitted.

Combine with the `service` and `event` fields for filtering:

```bash
# Follow only reconcile events
docker logs -f kintunnel-engine | jq -c 'select(.event | startswith("reconcile"))'

# Follow apply failures only
docker logs -f kintunnel-engine | jq -c 'select(.event == "apply.failed")'
```

## Container Hardening

The locked architectural decision (2026-06-29) is **Linux capabilities only — no root, no `docker.sock`, no host PID namespace.** The engine service in `docker-compose.yml` reflects this:

```yaml
services:
  engine:
    init: true
    read_only: true
    cap_drop: [ALL]
    cap_add: [NET_ADMIN, NET_RAW]
    security_opt: [no-new-privileges:true]
    tmpfs: [/tmp, /run]
    volumes:
      - kintunnel-data:/var/lib/kintunnel
      - kintunnel-backups:/backups
```

### Why NET_ADMIN and NET_RAW

- **NET_ADMIN** — required for `wg`, `wg setconf`, `ip link`, `ip addr`, `ip route`, and `iptables`.
- **NET_RAW** — required to open `/dev/net/tun` for the WireGuard interface. Without it, `ip link add <name> type wireguard` fails with `EPERM`.

`cap_drop: ALL` plus a minimal `cap_add` is the locked model. Do not promote the engine to a broader capability set "for convenience."

### Why not root

Root would be enough for everything the engine does, but a root compromise of the engine process would let the attacker escape into the host kernel. Running as a non-root UID inside a capability-bounded container means the engine process itself is unprivileged; it only exercises its bounded capabilities on the operations it explicitly performs.

### Why not `docker.sock`

Mounting `/var/run/docker.sock` would let the engine spawn or inspect arbitrary containers — far beyond its mandate. WireGuard + iptables is all it needs; mount nothing else from the host.

### Why not host PID namespace

`pid: host` would let the engine see and signal host processes. Combined with `NET_ADMIN` it would be enough to attack other services on the host. Keep the engine inside its own PID namespace.

### Why a separate backups volume

`kintunnel-backups` is a named volume, distinct from `kintunnel-data`. This separation lets operators mount backups on a different physical disk, snapshot it independently, or rotate it without touching live state. The default ownership is 0:0 inside the container because the engine process runs as UID 0 (it needs to call `iptables`); `read_only: true` on the root filesystem means writes only land on `kintunnel-data`, `kintunnel-backups`, `/tmp`, and `/run`.