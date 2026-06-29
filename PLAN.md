# KinTunnel — Production Push Plan

**Scope:** Phase 1 production-ready + Phase 2 (Operator Safety) + Phase 3 (Family-Scale).
**Privilege model:** Linux capabilities only (NET_ADMIN + NET_RAW), no host socket, no root.
**Status legend:** ⬜ todo · 🟦 in-progress · ✅ done · 🚫 blocked · ⛔ abandoned

> Source of truth alongside `TaskList`. Update statuses as work lands.
> Persistent file — survives session compaction.

---

## Phase 1: Production-Ready Engine

> **Status (2026-06-29):** Implementation complete for P1.1–P1.4. P1.5 (live VPS CI workflow) is the only deferred item — needs a self-hosted runner with /dev/net/tun. Code lives under `packages/engine/src/{apply,networking,backup,health}.ts` with full unit test coverage (51 new tests). Acceptance gate met: `npm run build` clean, 76/76 tests pass, all 3 compose files validate.

### P1.1 Engine apply path — interface + peers
- ✅ Audit current runtime.ts reconcile() seam
- ✅ Design apply path: wg syncconf for warm sync, wg set for individual ops, ip link + wg setconf for cold-start
- ✅ Implement `planApply()` — diff intended vs runtime, classify actions
- ✅ Implement `executeApply()` — bootstrap (ip link add + wg setconf + ip addr add + ip link up) + warm (wg syncconf) + peer removal (wg set peer remove)
- ✅ Implement `rollbackPlan()` — best-effort ip link del on bootstrap failure
- ✅ Wire into reconcile() — replaces the "intentionally deferred" message
- ✅ Atomicity: flock-protected, drift detection on listenPort, partial rollback on syncconf failure
- ✅ Audit events: `apply.interface.created`, `apply.peer.added`, `apply.peer.removed`, `apply.peer.synced`, `apply.drift.detected`, `apply.rollback.executed`
- ✅ Tests: `tests/engine/apply.test.ts` (11 cases, all green)

### P1.2 NAT + firewall policy with rollback
- ✅ Design NAT policy: iptables -t nat -A POSTROUTING -s <tunnel_cidr> -o <egress_iface> -j MASQUERADE
- ✅ Design FORWARD policy: established/related + tunnel new + drop invalid, all tagged with kintunnel comment markers
- ✅ Pre-check: each rule tested with `iptables -C` before `iptables -A` (idempotent insert)
- ✅ Rollback: `iptables -D` for all 4 comment markers we own, audit `networking.rolledback`
- ✅ Implement `applyNetworking()` and `rollbackNetworking()`
- ✅ Audit events: `networking.forwarding.enabled`, `networking.masquerade.applied`, `networking.forward.policy.applied`, `networking.rolledback`
- ✅ Tests: `tests/engine/networking.test.ts` (16 cases, all green)

### P1.3 Backup + restore runtime
- ✅ Design: atomic snapshot under `/backups/snap-<uuid>/` with manifest.json + state.json, sha256 integrity
- ✅ Implement `backupCreate()` — mkdir → atomicWriteFile manifest + state → rename, under withFileLock
- ✅ Implement `backupList()`, `backupDelete()` (refuses most-recent), `backupRestorePlan()` (peer diff)
- ✅ Implement `backupRestore()` — safety snapshot first, atomic state swap, wg-quick down best-effort
- ✅ Retention: prune to top N on each create, default 7
- ✅ Export/import via JSON wrapper (no tar.gz dependency — manifest carries sha256)
- ✅ API endpoints: `POST /v1/backups`, `GET /v1/backups`, `GET /v1/backups/:id`, `POST /v1/backups/:id/restore`, `GET /v1/backups/:id/export`, `POST /v1/backups/restore-plan`, `DELETE /v1/backups/:id`
- ✅ Audit events: `backup.created`, `backup.pruned`, `backup.restored`, `backup.exported`, `backup.imported`, `backup.deleted`
- ✅ Tests: `tests/engine/backup.test.ts` (11 cases, all green)

### P1.4 Enhanced /health
- ✅ `/dev/net/tun` readable (R_OK check, does NOT open for write)
- ✅ `/proc/sys/net/ipv4/ip_forward` == 1
- ✅ WireGuard interface up + listen_port matches
- ✅ NAT MASQUERADE rule present (via `checkNatRulePresent`)
- ✅ iptables binary invokable
- ✅ UDP port reachability (best-effort, warn-only)
- ✅ state_io always runs (even in dry-run)
- ✅ Structured `checks: HealthCheck[]` with `required_failing`, `warnings`
- ✅ 503 if any required check fails
- ✅ New `/v1/capabilities` endpoint returns full Capabilities shape
- ✅ Tests: `tests/engine/health.test.ts` (13 cases, all green)

### P1.5 Live VPS validation in CI
- ⏸️ Deferred — requires self-hosted runner with /dev/net/tun. GitHub-hosted ubuntu-latest has the kernel module but cannot expose /dev/net/tun to a docker-in-docker engine. Action item: add a `validate-live.yml` workflow_dispatch job that spins the engine on a self-hosted runner (label: `[self-hosted]`). Manual test plan in `PLAN-implementation.md` §13.

---

## Phase 2: Operator Safety

### P2.1 Structured logging
- ⬜ Engine: JSON logs with `timestamp`, `level`, `service`, `event`, `revision`, fields
- ⬜ Admin: same format, separate sink
- ⬜ Log level via `KINTUNNEL_LOG_LEVEL` (debug/info/warn/error)
- ⬜ Replace `console.log` / ad-hoc logs

### P2.2 Metrics endpoint
- ⬜ `/metrics` Prometheus-format (text exposition)
- ⬜ Counters: peers_total, peers_active, peers_revoked, peers_deleted, reconcile_runs, reconcile_failures, apply_failures, backup_creates, backup_restores
- ⬜ Gauges: state_revision, last_reconcile_timestamp_seconds, last_apply_duration_seconds
- ⬜ Histograms: reconcile_duration_seconds, apply_duration_seconds

### P2.3 Audit log hardening
- ⬜ Persistent audit log (separate file from state.json)
- ⬜ `GET /v1/audit?since=&action=&actor=` filtering
- ⬜ NDJSON export to /backups/audit-<date>.ndjson (configurable rotation)
- ⬜ Optional webhook push (off by default, future Phase)

### P2.4 Deep health probes
- ⬜ `/livez` — process up (always 200 unless crashloop)
- ⬜ `/readyz` — engine reconciled within last N minutes + interface up
- ⬜ `/healthz` (alias for `/health`) — deep checks (kept compatible)

---

## Phase 3: Family-Scale

### P3.1 Person + Device data model
- ⬜ Spec already defines `Person` + `Device` in `specs/data-model.md`
- ⬜ Implement: `state.persons: PersonRecord[]`, devices reference person_id
- ⬜ Backwards-compat: peers without `person_id` continue working
- ⬜ Migration: existing peers get implicit person "Unassigned"

### P3.2 Person CRUD
- ⬜ Engine API: `GET/POST/PATCH/DELETE /v1/persons`
- ⬜ Admin UI: people list + create + edit display name + notes
- ⬜ Person-level revocation (revokes all devices)

### P3.3 Device-per-person
- ⬜ Each peer can be linked to a person + a device label (laptop, phone, etc.)
- ⬜ Admin UI: peer creation form gains person + device fields
- ⬜ Person view shows all devices with last handshake

### P3.4 Expiry automation
- ⬜ Background ticker (or lazy check on /status) flags expired peers
- ⬜ Optional auto-revoke on expiry (configurable, default off — warn only)
- ⬜ Admin UI banner for soon-to-expire peers

### P3.5 Group policies (later)
- ⬜ Defer until P3.1-P3.4 land — out of scope for this push

---

## Cross-Cutting

### C.1 Admin UI updates
- ⬜ Surface reconcile result, NAT/firewall status, backup status on dashboard
- ⬜ Add People tab
- ⬜ Add device labels in peer creation
- ⬜ Health banner

### C.2 Tests
- ⬜ Unit: apply path, NAT policy builder, backup manifest, key alloc
- ⬜ Integration: full lifecycle (create peer → reconcile → assert wg show)
- ⬜ Mocked integration: process-level with stubbed `child_process`
- ⬜ Live CI: see P1.5

### C.3 Docs
- ⬜ `docs/architecture.md` — apply path diagram
- ⬜ `docs/operations.md` — backup/restore runbook
- ⬜ `docs/security.md` — capability model, threat model
- ⬜ `docs/persons.md` — family-scale data model
- ⬜ Update README to flip "Not finished" status once P1 lands

### C.4 Compose hardening
- ⬜ Engine service: `cap_add: NET_ADMIN, NET_RAW`, `cap_drop: ALL`, `read_only: true`, `security_opt: no-new-privileges:true`
- ⬜ Backup volume: separate named volume, retained across restarts
- ⬜ `tmpfs: /run` for runtime state

---

## Workflow phases

1. **Audit** — full code/spec review, lock down phase boundaries
2. **Design** — apply path, NAT policy, backup schema (architecture sketches)
3. **Implement** — engine apply → NAT → backup → health (parallel where safe)
4. **Wire** — admin UI surfacing, audit events, structured logs
5. **Test** — unit + integration + live CI
6. **Document** — docs/, README, CHANGELOG, ADRs as needed
7. **Verify** — full compose up, dry-run + non-dry-run, full reconcile cycle

---

## Acceptance criteria

- `npm test` passes
- `npm run build` passes
- Engine `POST /v1/reconcile` with `KINTUNNEL_DRY_RUN=false` actually applies to host WireGuard
- `iptables -t nat -S` shows MASQUERADE rule after reconcile
- `POST /v1/backups` creates snapshot; `POST /v1/backups/:id/restore` returns engine to that snapshot
- `GET /health` returns 503 if /dev/net/tun missing
- Live CI workflow succeeds on `ubuntu-latest`
- All audit events recorded with consistent shape
- No TODO/FIXME/console.log in committed code
- README's "Not finished" section is empty