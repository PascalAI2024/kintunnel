# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of Keep a Changelog and intends to use semantic versioning once releases begin.

## Unreleased

### Added

- Initial public repository foundation.
- Apache-2.0 licensing scaffold.
- Security, contribution, conduct, roadmap, and notice documents.
- README positioning for an original Docker-native family VPN manager for WireGuard deployments.
- Process-level integration coverage for the dry-run engine and admin HTTP client peer lifecycle.
- Engine API token authentication.
- Admin config download, no-store sensitive response headers, and recent activity view.
- Engine audit events for state initialization, peer lifecycle, and reconcile actions.
- Engine apply path: `apply.ts` with bootstrap (ip link + wg setconf + ip addr add), warm sync (wg syncconf), peer removal (wg set ... peer remove), drift detection on listenPort, and best-effort rollback.
- NAT + firewall policy: `networking.ts` with MASQUERADE for outbound tunnel traffic, FORWARD chain rules tagged with kintunnel comment markers, idempotent iptables `-C` pre-check, rollback via `-D` on partial failure, `ip_forward` sysctl.
- Backup runtime: `backup.ts` with atomic snapshots under `/backups/snap-<uuid>/`, sha256 manifest integrity, safety snapshot before restore, JSON wrapper export/import, retention pruner (default 7), refuses to delete most-recent snapshot.
- Deep health: `health.ts` with 7 probes (tun, forwarding, interface, nat, iptables, port, state_io), structured `checks[]` in /health response, 503 when any required check fails.
- /v1/capabilities endpoint exposing the full Capabilities shape (hasWg, hasWgQuick, hasTun, canInspectInterface, hasIptables, hasIpset, ipForward).
- 7 /v1/backups endpoints: create, list, get manifest, restore, export, restore-plan, delete.
- 18 new AuditAction members covering apply/networking/backup lifecycle.
- Structured NDJSON logger with KINTUNNEL_LOG_LEVEL env filtering.
- Prometheus /metrics endpoint with counters, gauges, histograms (text exposition, no prom-client dep).
- Persistent NDJSON audit log with size-based rotation, queryable via GET /v1/audit.
- 6 new KINTUNNEL_* env vars: NAT_APPLY, BACKUP_DIR, BACKUP_RETENTION_COUNT, BACKUP_LOCK_TIMEOUT_MS, AUDIT_LOG_ROTATION_BYTES, AUDIT_LOG_RETENTION_COUNT (LOG_LEVEL added separately).
- Engine container hardening: cap_drop ALL + cap_add [NET_ADMIN, NET_RAW], read_only root, tmpfs /tmp + /run, no-new-privileges, kintunnel-backups named volume. Mirrored across base compose, minimal-vps overlay, and dokploy-swarm reference.
- atomicWriteFile + withFileLock (exclusive-lock-file based, cross-process) helpers in state.ts.

### Changed

- README and operator docs now describe the runnable dry-run MVP, source-build Docker flow, build commands, and current non-dry-run limitations.
- Engine defaults now fail closed into dry-run mode unless host networking is explicitly acknowledged.
- `KINTUNNEL_DRY_RUN=true` is still the safe default; flipping to false now triggers real host networking apply + NAT + reconcile (previously was a no-op with "intentionally deferred" message).
- /health response shape extended with `checks[]`, `required_failing[]`, `warnings[]`. Backwards-compatible: `ok: boolean` is preserved.

### Deprecated

- Nothing yet.

### Removed

- Nothing yet.

### Fixed

- README "Not finished" section: 4 of the 5 listed gaps are now implemented. The remaining gap (live VPS validation) requires a self-hosted runner.

### Security

- Added initial security reporting guidance.
