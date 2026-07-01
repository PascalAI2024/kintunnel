# Privilege Model

This document covers the Phase 1 implementation specifics of KinTunnel's security posture. For the broader security philosophy see [security-model.md](security/security-model.md). For threat-model and incident-response guidance, see [SECURITY.md](https://github.com/PascalAI2024/kintunnel/blob/main/SECURITY.md).

The privileged-side architecture is locked (2026-06-29): **Linux capabilities only, no root, no `docker.sock`, no host PID namespace.** This document explains what that means in practice and what an operator needs to defend against.

## Privilege Model

The engine container runs with `cap_drop: ALL` plus a minimal `cap_add: [NET_ADMIN, NET_RAW]`. Inside the container the engine process runs as a non-root UID (the locked decision is "no root"). It exercises only the bounded capabilities it needs for `wg`, `iptables`, and `sysctl`. There is no `docker.sock` mount and the engine is in its own PID namespace.

The admin container is fully unprivileged: `cap_drop: ALL` with no `cap_add`. It cannot touch host networking or WireGuard. It communicates with the engine over the internal Compose network using a bearer token.

```
                    ┌────────────────────────────────────────────────┐
                    │                  VPS host                       │
                    │                                                │
   client device ──UDP──►  WireGuard kernel module (host kernel)    │
                    │            ▲                                   │
                    │            │                                   │
                    │   ┌────────┴──────────────┐                    │
                    │   │  kintunnel-engine     │  capabilities:     │
                    │   │  (no root)            │   NET_ADMIN        │
                    │   │                       │   NET_RAW          │
                    │   │  /v1/* (token-gated)  │                    │
                    │   │  /health (open)       │                    │
                    │   └──────┬────────────────┘                    │
                    │          │ internal network                    │
                    │   ┌──────┴────────────────┐                    │
                    │   │  kintunnel-admin      │  capabilities:     │
                    │   │  (no root)            │   (none)           │
                    │   │                       │                    │
                    │   │  :8080 (UI / API)     │                    │
                    │   └───────────────────────┘                    │
                    │                                                │
                    └────────────────────────────────────────────────┘
```

## Capability Rationale

| Capability | Used by | Without it |
|---|---|---|
| `NET_ADMIN` | `wg`, `wg-quick`, `wg setconf`, `wg syncconf`, `ip link`, `ip addr`, `ip route`, `iptables`, `sysctl -w net.ipv4.ip_forward` | Apply path returns `capability_missing`. NAT and FORWARD rule insertion fails. `ip_forward` cannot be toggled. |
| `NET_RAW` | `ip link add <name> type wireguard` (opens `/dev/net/tun`) | Cold-start bootstrap fails with `EPERM` on the tun open. |

`NET_ADMIN` is the larger of the two — it grants broad network-configuration power. The locked model accepts that trade-off because the alternative (running as root) is strictly worse. The minimal `cap_add` set, plus `cap_drop: ALL`, plus `no-new-privileges`, plus `read_only` root, plus a separate PID namespace, bounds the blast radius as tightly as the kernel allows.

## Blast Radius

Two adversary profiles:

### Admin-plane compromise

Attacker controls the admin service (browser session stolen, admin token leaked, XSS in admin UI).

- **Can:** create, revoke, delete peers; rotate admin token; view recent activity; trigger reconcile; read peer public keys.
- **Cannot:** directly read peer private keys from `state.json` (the admin service does not have the engine API token by default; peer config export endpoints require the engine token).
- **Cannot:** touch host networking. The admin container has no capabilities.
- **Cannot:** spawn other containers. There is no `docker.sock` mount on the admin container.

The engine token is the boundary. If the attacker does **not** have the engine API token, the admin compromise is bounded to the admin's own surfaces. If the attacker **does** have both, see below.

### Engine-plane compromise

Attacker controls the engine service (container escape, RCE in the engine process, stolen engine API token).

- **Can:** control the WireGuard interface; add and remove peers at will; insert / remove `iptables` rules; toggle `ip_forward`; create and restore backups; read and write `state.json`; emit arbitrary audit events.
- **Cannot:** break out of the container's capability set. The engine cannot, for example, mount filesystems, load kernel modules, or `ptrace` host processes — those are gated on capabilities the engine does not hold.
- **Cannot:** reach the admin service's session state directly. The engine has the admin's bearer token only if operators intentionally configured it that way; the default is one-way trust from admin → engine.

The engine compromise is the worse of the two because it controls the VPN data plane. Detection is via the persistent audit log — `apply.*` events show what landed.

## API Token Requirements

The engine enforces a strong-token check on `KINTUNNEL_ENGINE_API_TOKEN` via `assertStrongEngineApiToken`:

- **Minimum length:** 32 characters
- **No placeholder words:** rejects `change-me`, `dev`, `test`, `example`, `placeholder`, `replace-me`, and similar patterns
- **No whitespace:** tabs, spaces, newlines are rejected
- **Character diversity:** at least 8 unique characters (catches `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`)

The engine refuses to start with a weak token. The admin token is validated by the admin service with the same rules.

Generate tokens with `openssl rand -base64 48` (gives 64 base64 chars) and store them under `/etc/kintunnel/secrets/`, never in `.env` files committed to a repo.

## Secret Storage

All secrets use the `_FILE` env-var convention. Compose mounts the secret directory read-only into the container:

```yaml
secrets:
  admin_token:
    file: ./config/secrets/admin-token.txt
  engine_api_token:
    file: ./config/secrets/engine-api-token.txt

services:
  engine:
    secrets:
      - engine_api_token
    environment:
      KINTUNNEL_ENGINE_API_TOKEN_FILE: /run/secrets/engine_api_token
```

Operators MUST:

- Mount secrets read-only.
- Keep `config/secrets/` outside version control (add to `.gitignore` if it is not already).
- Use distinct tokens for `KINTUNNEL_ADMIN_TOKEN` and `KINTUNNEL_ENGINE_API_TOKEN`. Sharing them collapses the two blast radii.
- Rotate tokens at least quarterly; rotate immediately on any operator departure or suspected compromise.

## Audit Trail

The engine emits audit events to two sinks:

1. **In-memory ring buffer** (`state.events`, last 250) — fast; surfaced via the admin UI's recent activity view. Persists as part of `state.json`.
2. **Persistent NDJSON** (`/var/lib/kintunnel/audit.log*`) — rotated by size (`KINTUNNEL_AUDIT_LOG_ROTATION_BYTES`, default 5 MiB) with up to `KINTUNNEL_AUDIT_LOG_RETENTION_COUNT` files kept (default 10). Queryable via `GET /v1/audit?action=&actor=&since=`.

Events from the apply path, networking, backup lifecycle, and `state.ts` peer lifecycle (`peer.created`, `peer.revoked`, `peer.deleted`) all land in **both** sinks — see [architecture.md Audit coverage](architecture.md#audit-coverage) for the one remaining limitation (a process-wide, not per-instance, sink reference in `apply.ts`/`networking.ts`, which doesn't matter under the single-active-node deployment model this project requires).

## Threat Model

### Adversary goals and current controls

| Goal | Vector | Current control |
|---|---|---|
| Steal admin session | XSS, token log, browser compromise | Token-gated UI, no-store headers on sensitive responses, IP allowlist guidance, HTTPS reverse proxy |
| Steal engine API token | `docker inspect`, log file leak, container exec | Token never logged; required strength check; secrets read from `_FILE` form |
| Read peer private keys | Engine RCE, state file theft | `state.json` is on the engine's read-only-root + writable volume mount; only the engine process reads it; backup archives include the private key but are operator-controlled |
| Forge an audit event | Engine compromise, persistent log tampering | Engine compromise permits forging ring-buffer events; persistent NDJSON is append-only via the rotation primitive, but a determined attacker with engine RCE could rewrite it. Mitigation: ship `audit.log` off-host for tamper-evidence. |
| Modify WireGuard state without detection | Direct host access outside Compose | The host kernel's WireGuard state is the source of truth at runtime. Engine's drift detection catches divergence on every reconcile. |
| Recover state from a backup that was tampered with | Backup archive theft + re-introduction | Restore verifies SHA-256 manifest before swapping state. See [Backup Integrity](#backup-integrity). |

### What the locked decisions do **not** protect

- A determined root-on-host attacker can read everything. The engine's hardening is **not** a defense against a host-rooted adversary; that requires host hardening (SSH keys, no password login, fail2ban, kernel patches) which is out of scope for this document.
- A network adversary between admin and engine can replay the bearer token unless transport is encrypted. The engine has no built-in mTLS; if the Compose network is on a shared host, run it on an isolated `network` and consider an Envoy sidecar in Wave 4.
- A compromised VPS provider can read memory of the engine process. Mitigation is operator-controlled: short-lived tokens, audit review, and rotation cadence.

## Backup Integrity

Every snapshot carries a `BackupManifest` with per-file SHA-256 hashes:

```json
{
  "kintunnel_version": "0.x.y",
  "format_version": 1,
  "schema_version": 1,
  "snapshot_id": "0190a3b4-...",
  "engine_revision": 42,
  "files": [
    {"path": "state.json", "size_bytes": 8192, "sha256": "abc123..."}
  ],
  "compatibility": {"min_engine_version": "0.0.0"},
  "encrypted": false,
  "retention": {"policy": "count", "kept_after_prune": 10}
}
```

### Restore-time verification

`POST /v1/backups/:id/restore` recomputes SHA-256 over the snapshot's `state.json` and compares to `manifest.files[0].sha256` before touching live state. A mismatch fails with HTTP 409 and the manifest is flagged `corrupt: true` in subsequent `GET /v1/backups` listings.

### Safety snapshot

Every non-forced restore first creates a snapshot of the current `state.json` with `trigger: "pre-rotate"`. The new snapshot's `snapshot_id` is returned to the caller as `safety_snapshot_id`. If the restore does the wrong thing, the operator can restore the safety snapshot back to the prior state in one step.

### What's in a backup

The current `state.json` is captured in full. That includes the **WireGuard server's private key** (`serverPrivateKey`). Operators MUST treat backup archives as the equivalent of the server private key:

- Encrypt at rest (`gpg -c`, age, sops — pick one).
- Restrict file permissions (`chmod 0400`).
- Store off-host.
- Treat any backup leak as a key-rotation event — generate a new server keypair, re-render every peer config, redistribute to users.

Encryption-at-rest for backup archives is tracked as a Wave 4 follow-up.

## Network Exposure

### Engine ports

| Port | Protocol | Bound to | Notes |
|---|---|---|---|
| `9090` | TCP (HTTP API) | Internal Compose network only | `/health` is open; `/v1/*` requires bearer token. Do not publish to `0.0.0.0`. |
| `51820` | UDP (WireGuard) | `0.0.0.0` (host) | The only port intended for public reachability. Open in the host firewall only for the regions you operate in. |

### Admin port

| Port | Protocol | Bound to | Notes |
|---|---|---|---|
| `8080` | TCP (HTTP UI / API) | `127.0.0.1` by default | Operators MUST put an HTTPS reverse proxy in front (Caddy, Traefik, Nginx) before any remote access. |

### What the operator MUST do

- Do **not** publish the engine's `9090/TCP` port outside the Compose network. Health-check scraping via `docker exec` or an internal Prometheus sidecar is the supported pattern.
- Do **not** publish the admin's `8080/TCP` port directly. Always front it with TLS termination and an authentication boundary.
- Restrict `51820/UDP` to the source regions you expect users from, if your provider's firewall allows it.
- Treat DNS records pointing users to the public endpoint as part of the security perimeter. Rotate the public endpoint (and the server keypair) if DNS is hijacked.

### Reverse proxy posture

When putting the admin UI behind a reverse proxy:

- TLS 1.2+ only. HSTS on.
- IP allowlist at the proxy if the operator pool is small.
- Rate limit `/api/v1/auth/login` aggressively (brute-force surface).
- Forward the original client IP to the admin via `X-Forwarded-For` so the audit log captures it.

### Engine token over the wire

The bearer token is sent in `Authorization: Bearer …` headers over HTTP. Inside the Compose network this is acceptable because the network is on a single host and not internet-routable. If the operator deploys across hosts with the admin and engine on separate machines, terminate TLS between them with a sidecar or a private CA.

## Summary

The privilege model is narrow by design. Engine is capability-bounded and audited; admin is fully unprivileged. Tokens are strong, secrets live in `_FILE` mounts, backups carry SHA-256 manifests, and the only public port is the WireGuard UDP listener. The remaining controls — operator-side hardening of the host, off-host audit shipping, encrypted backup archives, admin-to-engine mTLS — are operator responsibilities and Wave 4 follow-ups.