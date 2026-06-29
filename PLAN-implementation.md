# KinTunnel Phase 1 — Production Implementation Plan

> Synthesis of the four research reports (00 engine audit, 01 backup/restore, 02 WireGuard primitives, 03 iptables/NAT) against the existing codebase and locked ADRs.
>
> **Locked constraints** (do not propose alternatives):
> - Linux capabilities only: `cap_add NET_ADMIN NET_RAW`, `cap_drop ALL`
> - No root, no host socket, no `docker.sock`, no host PID namespace
> - `iptables` (matches `Dockerfile.engine` apt line), not `nftables`
> - `wg-quick` for cold start (bootstrap), `wg syncconf` for warm peer replacement, `wg set` for individual peer ops
> - Two-service split (ADR-0002): privileged engine + unprivileged admin
> - `KINTUNNEL_*` env namespace (ADR-0005)
> - Backwards compatibility: existing `peers[]` + `state.json` must continue working
> - No changes to ADR-0002, ADR-0004, ADR-0005

**Out of scope for this plan** (calling out explicitly to avoid scope creep):
- Admin-side proxy endpoints for new engine routes — flagged in §13 as a follow-up
- Phase 2 work (structured logging, metrics, deep probes aliases `/livez` `/readyz`, audit log hardening)
- Phase 3 work (Person / Device data model, group policies)

---

## 1. File ownership matrix

Every file has **exactly one** owner agent so parallel implementation work doesn't collide.

| File | Action | Owner | Purpose of change |
|---|---|---|---|
| `packages/engine/src/types.ts` | MODIFIED | `stark-architect` | Add new types for apply, networking, backup, health, capability extensions (§2, §4) |
| `packages/engine/src/env.ts` | MODIFIED | `stark-devops` | Add `KINTUNNEL_*` envs + validation for backup dir, NAT apply gate, backup retention, restore lock timeout (§3) |
| `packages/engine/src/state.ts` | MODIFIED | `stark-data` | Extract reusable atomic-write helper, add `createBackupSnapshot` / `restoreFromSnapshot` primitives, expose `withFileLock` for backup/restored concurrency (§5, §7, §12 Wave 0) |
| `packages/engine/src/runtime.ts` | MODIFIED | `stark-architect` | Extend `getCapabilities()` (§8), thread `apply` call into `reconcile()` (§5), parse additional `wg show dump` columns (Phase 2 prerequisite) |
| `packages/engine/src/app.ts` | MODIFIED | `stark-security` | Augment `/health` (§8), mount new `/v1/backups`, `/v1/backups/:id`, `/v1/backups/:id/export`, `/v1/backups/:id/restore`, `/v1/backups/restore-plan`, `/v1/capabilities` (§9); preserve existing API token gate and `safeEqual` |
| `packages/engine/src/apply.ts` | **NEW** | `stark-integration` | Bridge between intended state and WireGuard primitives — bootstrap + warm sync + per-peer set/remove (§5) |
| `packages/engine/src/networking.ts` | **NEW** | `stark-devops` | `net.ipv4.ip_forward` policy + MASQUERADE + FORWARD chain rules with idempotent `-C` check + comment-marker rollback (§6) |
| `packages/engine/src/backup.ts` | **NEW** | `stark-data` | `backup.create` / `list` / `restore` / `export` / `delete` + retention pruner + concurrency lock (§7) |
| `packages/engine/src/health.ts` | **NEW** | `stark-observability` | Probe runners for `/dev/net/tun`, `ip_forward`, interface, NAT rule, UDP port; aggregate into `HealthReport` (§8) |
| `packages/engine/src/keys.ts` | READ-ONLY | — | No changes; key generation already works |
| `packages/engine/src/peers.ts` | READ-ONLY | — | No changes; filtering/validation already complete |
| `packages/engine/src/ip.ts` | READ-ONLY | — | No changes |
| `packages/engine/src/config-render.ts` | READ-ONLY | — | No changes (consumed by `apply.ts` for wg INI rendering) |
| `packages/engine/src/index.ts` | MODIFIED | `stark-devops` | Boot order: load config → init store → wire apply/networking modules into reconcile path; mount hooks for backup restore → reconcile fan-out |
| `Dockerfile.engine` | MODIFIED | `stark-devops` | Add `iptables` (already present — confirm), `uuid-runtime`, `flock`; bake `/backups` ownership (already done); add `KINTUNNEL_BACKUP_*` defaults (§3, §10) |
| `docker-compose.yml` | MODIFIED | `stark-devops` | Engine: add `cap_add NET_ADMIN NET_RAW` (move from `minimal-vps.yml` so it's always present — `cap_drop ALL` + minimal `cap_add` IS the locked model), tighten `read_only`, add `KINTUNNEL_NAT_APPLY`, `KINTUNNEL_BACKUP_DIR`, `KINTUNNEL_BACKUP_RETENTION_COUNT`, add bind-mount for `/backups` volume, expose `KINTUNNEL_PUBLIC_ENDPOINT` mapping fix (§10) |
| `compose/minimal-vps.yml` | MODIFIED | `stark-devops` | Remove `cap_add` (now in base compose), keep `devices` `/dev/net/tun` and `sysctls` |
| `compose/dokploy-swarm.yml` | MODIFIED | `stark-devops` | Same engine security surface as base compose — `cap_add NET_ADMIN NET_RAW`, `cap_drop ALL`, no `docker.sock` |
| `.env.example` | MODIFIED | `stark-devops` | Add `KINTUNNEL_NAT_APPLY`, `KINTUNNEL_BACKUP_DIR`, `KINTUNNEL_BACKUP_RETENTION_COUNT`, `KINTUNNEL_BACKUP_LOCK_TIMEOUT_MS`, document defaults (§3) |
| `tests/engine/apply.test.ts` | **NEW** | `stark-testing` | Mock `child_process.execFile` → assert bootstrap path, warm sync path, peer removal path, dry-run, error paths (§11) |
| `tests/engine/networking.test.ts` | **NEW** | `stark-testing` | Mock `iptables` / `ip` → assert rule idempotency, rule rollback on failure, `ip_forward` persistence (§11) |
| `tests/engine/backup.test.ts` | **NEW** | `stark-testing` | Mock `fs` → assert atomic snapshot, restore safety snapshot, retention prune, lock contention (§11) |
| `tests/engine/health.test.ts` | **NEW** | `stark-testing` | Mock `/proc` reads + `iptables -C` → assert aggregate 503/200 behavior (§11) |
| `tests/engine/engine.test.ts` | MODIFIED | `stark-testing` | Update `/health` shape assertions to include `checks[]` (additive — `ok` boolean is preserved) (§8) |

> **Locking note**: any agent that needs to read the file under a different owner must use `Read` and not edit. Edits outside of the listed owner for a file require a re-plan.

---

## 2. New TypeScript types (`packages/engine/src/types.ts`)

Exact additions to the existing literal-union exports. All appended, no renames.

```ts
// ── AuditAction additions (extend existing union) ──────────────────────────
export type AuditAction =
  | "state.initialized"
  | "peer.created"
  | "peer.config.exported"
  | "peer.revoked"
  | "peer.deleted"
  | "reconcile.completed"
  // P1.1 apply path:
  | "apply.interface.created"
  | "apply.interface.reconfigured"
  | "apply.peer.added"
  | "apply.peer.removed"
  | "apply.peer.synced"
  | "apply.drift.detected"
  | "apply.rollback.executed"
  // P1.2 networking:
  | "networking.forwarding.enabled"
  | "networking.masquerade.applied"
  | "networking.forward.policy.applied"
  | "networking.rolledback"
  // P1.3 backup:
  | "backup.created"
  | "backup.create.failed"
  | "backup.pruned"
  | "backup.restored"
  | "backup.restore.failed"
  | "backup.exported"
  | "backup.imported"
  | "backup.deleted";

// ── Apply path types ────────────────────────────────────────────────────────
export interface ApplyPlan {
  /** Which actions the plan intends — drives boot vs warm path. */
  bootstrap: boolean;
  reconfigureInterface: boolean;
  addPeers: string[];        // public keys
  removePeers: string[];     // public keys
  modifyPeers: string[];     // public keys (allowed-ips / psk / keepalive change)
}

export interface ApplyRequest {
  state: EngineState;
  dryRun: boolean;
  /** Optional override — when false, skips host exec but still validates. */
  skipExec?: boolean;
}

export interface ApplyResult {
  ok: boolean;
  dryRun: boolean;
  bootstrap: boolean;
  applied: boolean;
  revision: number;
  interfaceName: string;
  actionsExecuted: string[];
  peerChanges: {
    added: string[];
    removed: string[];
    modified: string[];
  };
  drift?: {
    detected: boolean;
    fields: string[];
  };
  startedAt: string;
  finishedAt: string;
  messages: string[];
  errors: string[];
}

// ── Networking types ───────────────────────────────────────────────────────
export interface NetworkingPolicy {
  interfaceName: string;
  tunnelCidrV4: string;
  egressInterface: string;     // detected via `ip route show default` if unset
  natEnabled: boolean;
  forwardingRequired: boolean;
}

export interface NetworkingPlan {
  enableForwarding: boolean;   // net.ipv4.ip_forward = 1 if currently 0
  masqueradeRule: boolean;     // MASQUERADE for tunnel egress
  forwardRules: {
    allowTunnelNew: boolean;
    allowEstablishedRelated: boolean;
    dropInvalid: boolean;
  };
}

export interface NetworkingResult {
  ok: boolean;
  applied: boolean;
  rulesInserted: string[];     // comment markers of rules successfully applied
  rulesRolledBack: string[];   // comment markers of rules rolled back
  forwardingEnabled: boolean;
  warnings: string[];
  errors: string[];
}

// ── Backup types ───────────────────────────────────────────────────────────
export interface BackupManifest {
  kintunnel_version: string;   // semver from package.json
  format_version: 1;
  schema_version: 1;
  snapshot_id: string;         // UUID v7
  engine_revision: number;     // state.revision at snapshot time
  created_at: string;          // ISO timestamp
  trigger: "manual" | "post-restore" | "scheduled" | "pre-rotate";
  interface: {
    name: string;
    listen_port: number;
    public_key: string;
    tunnel_cidr_v4: string;
  };
  files: Array<{
    path: string;              // relative inside the snapshot dir, e.g. "state.json"
    size_bytes: number;
    sha256: string;
  }>;
  compatibility: {
    min_engine_version: string;
    max_engine_version?: string;  // absent means "no upper bound"
  };
  encrypted: false;            // explicitly plaintext v1; future field
  retention: {
    policy: "count";           // only count-based in v1
    kept_after_prune: number;
  };
}

export interface BackupSummary {
  snapshot_id: string;
  created_at: string;
  engine_revision: number;
  trigger: BackupManifest["trigger"];
  size_bytes: number;
  file_count: number;
  corrupt: boolean;            // sha256 mismatch or manifest unreadable
}

export interface BackupRestoreRequest {
  snapshot_id: string;
  apply: boolean;              // true = swap state.json + force reconcile, false = dry-run
  force?: boolean;             // skip safety snapshot if true
}

export interface BackupRestorePlan {
  snapshot_id: string;
  from_revision: number;       // state.revision in backup
  to_revision?: number;        // state.revision at plan time (current)
  peer_changes: {
    added: string[];           // peers in backup absent from current
    removed: string[];         // peers in current absent from backup
    modified: string[];        // same pubkey, different config
  };
  affected_public_keys: string[];
  warnings: string[];
  apply_blocked_reasons: string[];
}

// ── Health types ───────────────────────────────────────────────────────────
export type HealthCheckStatus = "pass" | "fail" | "warn" | "skip";

export interface HealthCheck {
  name: "tun" | "forwarding" | "interface" | "nat" | "iptables" | "port" | "state_io";
  status: HealthCheckStatus;
  detail: string;
  observed_at: string;
  required: boolean;           // when required and !pass, /health returns 503
}

export interface HealthReport {
  ok: boolean;                 // true iff all required checks pass
  service: "kintunnel-engine";
  dry_run: boolean;
  env: string;
  checks: HealthCheck[];
  messages: string[];
  checked_at: string;
}

// ── Capability extensions ──────────────────────────────────────────────────
export interface Capabilities {
  platform: NodeJS.Platform;
  dryRun: boolean;
  hasWg: boolean;
  hasWgQuick: boolean;
  hasIptables: boolean;        // NEW — was missing
  hasIpset: boolean;           // NEW — currently always false (we don't use it)
  hasTun: boolean;
  canInspectInterface: boolean;
  interfaceName: string;
  ipForward?: boolean;         // NEW — current sysctl value
  messages: string[];
}
```

> **Backwards compatibility**: every existing field on `EngineState`, `ServerSettings`, `PeerRecord`, `ReconcileResult` is preserved. `ReconcileResult` is extended by adding new optional fields `actionsExecuted?`, `peerChanges?` (default absent preserves wire shape for old admin clients).

```ts
export interface ReconcileResult {
  ok: boolean;
  dryRun: boolean;
  applied: boolean;
  revision: number;
  interfaceName: string;
  activePeerCount: number;
  startedAt: string;
  finishedAt: string;
  messages: string[];
  errors: string[];
  // NEW (optional — additive):
  apply?: ApplyResult;
  networking?: NetworkingResult;
  actionsExecuted?: string[];
}
```

---

## 3. New env vars (`packages/engine/src/env.ts`)

All new vars use the `KINTUNNEL_*` prefix. Validation lives in `loadConfig()` next to the existing guards.

| Name | Type | Default | Semantics | Validation |
|---|---|---|---|---|
| `KINTUNNEL_NAT_APPLY` | bool | `false` | When `true`, `networking.apply()` will execute `iptables`/`sysctl`. When `false`, the policy is computed and rendered but never executed (matches the existing dry-run philosophy for networking, separated from `KINTUNNEL_DRY_RUN` which gates WireGuard). | Must be `true` and `KINTUNNEL_ENABLE_HOST_NETWORKING=true` to actually touch iptables; otherwise silently no-op (deliberate so a boot in a half-configured Compose still passes). |
| `KINTUNNEL_FORWARDING_REQUIRED` (already exists) | bool | `true` | If `true`, `health.tun` & `health.forwarding` are required checks; if `false`, they're `warn`. | Already validated as bool. |
| `KINTUNNEL_BACKUP_DIR` | path string | `/backups` | Directory holding snapshot dirs. Must be on the same filesystem as `KINTUNNEL_DATA_DIR` to preserve `rename(2)` atomicity for the safety snapshot during restore. | Must be absolute path. Throw on relative. Throw if `os.statfs(backupDir) != os.statfs(dataDir)` (best-effort check — log warning, don't fail boot). |
| `KINTUNNEL_BACKUP_RETENTION_COUNT` | integer | `10` | Number of snapshots to keep before retention pruner kicks in. | Integer 1-1000. Throw if out of range. |
| `KINTUNNEL_BACKUP_LOCK_TIMEOUT_MS` | integer | `30000` | Max wait acquiring `flock` on `/backups/.lock` during create / restore. | Integer 1000-300000. |
| `KINTUNNEL_APPLY_BOOTSTRAP_TIMEOUT_MS` | integer | `15000` | Max wait for `ip link add` + `wg set` + `ip link set up` bootstrap path before declaring apply failed. | Integer 1000-120000. |
| `KINTUNNEL_WG_EGRESS_INTERFACE` | string | unset (auto-detect) | If set, MASQUERADE binds to this interface. If unset, resolve at apply time via `ip route show default` first match. | If set, must match `^[a-zA-Z0-9_.-]{1,16}$` (linux IFNAMSIZ limit). |

> **Hard rule update for `KINTUNNEL_NAT_APPLY=false` + `KINTUNNEL_DRY_RUN=false`**: do not throw — the reconcile loop will simply record that networking was skipped. The existing guard pattern (`if (!dryRun && !hostNetworkingEnabled) throw`) covers WireGuard; networking follows the same `apply`-versus-`declared` split.

---

## 4. New audit actions (`AuditAction` union)

All actions extend the existing `AuditAction` literal union in `types.ts`. Metadata schemas are enforced at the call site in `state.appendEvent()` — there is no runtime schema gate, but each call must pass a metadata object shape documented here.

| Action | Metadata keys (required → optional) | Emitted from |
|---|---|---|
| `apply.interface.created` | `interface, listen_port, public_key` | `apply.ts bootstrap()` |
| `apply.interface.reconfigured` | `interface, fields_changed[]` | `apply.ts warm()` when `ListenPort` or `PrivateKey` changed |
| `apply.peer.added` | `public_key, peer_name, address_v4` | `apply.ts` after `syncconf` |
| `apply.peer.removed` | `public_key, peer_name` | `apply.ts` after `wg set <iface> peer <pub> remove` |
| `apply.peer.synced` | `count_added, count_modified, count_unchanged` | end of warm tick |
| `apply.drift.detected` | `fields[], expected, actual` | `apply.ts` post-`wg show` |
| `apply.rollback.executed` | `reason, steps_reversed[]` | `apply.ts rollbackPlan()` |
| `networking.forwarding.enabled` | `previous_value, new_value` | `networking.ts` |
| `networking.masquerade.applied` | `egress_iface, rule_comment` | `networking.ts` |
| `networking.forward.policy.applied` | `rules[]` (comment-marker strings) | `networking.ts` |
| `networking.rolledback` | `reason, rules_removed[]` | `networking.ts rollback()` |
| `backup.created` | `snapshot_id, revision, size_bytes, file_count, trigger` | `backup.ts create()` |
| `backup.create.failed` | `error_code, error_message, lock_acquired` | `backup.ts create()` catch |
| `backup.pruned` | `snapshot_id, kept` | `backup.ts` retention pruner |
| `backup.restored` | `snapshot_id, from_revision, safety_snapshot_id, applied` | `backup.ts restore()` |
| `backup.restore.failed` | `snapshot_id, error_code, error_message, safety_snapshot_id` | `backup.ts restore()` catch |
| `backup.exported` | `snapshot_id, size_bytes, content_type` | `backup.ts exportTar()` |
| `backup.imported` | `snapshot_id, source` (`stream` \| `upload`) | `backup.ts importTar()` |
| `backup.deleted` | `snapshot_id, size_bytes` | `backup.ts delete()` |

`metadata` typing already caps values at `string | number | boolean | null` (`AuditEvent.metadata` in `types.ts`). Booleans are stored via `Boolean(value)`; arrays become CSV strings before insert (e.g. `fields_changed: "listen_port,private_key"`).

---

## 5. Apply path module — `packages/engine/src/apply.ts` (NEW)

**Owner**: `stark-integration`. **Exports**:

```ts
export function planApply(state: EngineState, runtime: RuntimeState): ApplyPlan;
export async function executeApply(req: ApplyRequest): Promise<ApplyResult>;
export async function rollbackPlan(state: EngineState, lastPlan: ApplyPlan): Promise<void>;
export function renderWgIni(state: EngineState, activeOnly: boolean): string;
export async function diffPeers(intended: PeerRecord[], currentPublicKeys: Set<string>): Promise<{ add: string[]; remove: string[]; modify: string[] }>;
```

**Helpers** (internal, not exported):
- `execWg(args: string[], opts?: { input?: string }): Promise<{ stdout: string; stderr: string }>` — wraps `child_process.execFile('wg', args, …)`. Centralizes timeouts, stderr capture, and `ENABLE_HOST_NETWORKING` gating.
- `execSysctl(path: string, value: string): Promise<void>` — used by `networking.ts`, lives here because it's host exec.
- `execIptables(args: string[], opts?: { checkOnly?: boolean }): Promise<{ exit: number; stdout: string; stderr: string }>` — same role for `iptables`.

**Error surface**: a discriminated union returned by `executeApply`:

```ts
type ApplyErrorCode =
  | "capability_missing"        // wg / wg-quick / iptables not on PATH
  | "interface_exists"          // bootstrap when interface already exists (caller can downgrade to warm)
  | "interface_missing"         // warm path but link absent (caller can run bootstrap)
  | "duplicate_address"         // matches existing reconcile pre-check
  | "duplicate_pubkey"          // matches existing reconcile pre-check
  | "key_format_invalid"
  | "bootstrap_timeout"
  | "syncconf_failed"
  | "peer_remove_failed"
  | "drift_unrecoverable"       // expected != actual on required fields
  | "dry_run_only";             // !config.dryRun requested but KINTUNNEL_ENABLE_HOST_NETWORKING=false

class ApplyError extends Error { code: ApplyErrorCode; detail: Record<string, string | number | boolean> }
```

Each error is logged with `metadata` shaped for an `apply.*` audit event when severity warrants. `ApplyError` is rethrown through `reconcile()` into the `ReconcileResult.errors[]` array — no exception escapes the engine API boundary.

**How `reconcile()` calls it (modified `runtime.ts`)**:

```ts
if (!config.dryRun) {
  const capabilities = await getCapabilities(config);
  if (!capabilities.hasWg || !capabilities.hasWgQuick || !capabilities.hasTun) {
    errors.push(...capabilities.messages);
  } else {
    const runtime = await getRuntimeState(config, state);
    try {
      const req: ApplyRequest = { state, dryRun: config.dryRun };
      const plan = planApply(state, runtime);
      const result = await executeApply(req);
      // Merge into ReconcileResult (existing fields preserved):
      applied = result.applied;
      actionsExecuted = result.actionsExecuted;
      lastApplyResult = result;
      messages.push(...result.messages);
      errors.push(...result.errors);
    } catch (error) {
      if (error instanceof ApplyError) errors.push(`${error.code}: ${error.message}`);
      else throw error;
    }
  }
}
```

**Atomicity rules**:
1. **Bootstrap path** (interface does not exist): `ip link add <name> type wireguard` → `wg setconf <name> <tempfile>` (with `[Interface] PrivateKey, ListenPort`) → `ip addr add <server_v4>/32 dev <name>` (using `replace` so reapply is idempotent) → `ip link set mtu <mtu||1420> up`. Failures between steps 1-4 call `ip link del <name>` best-effort. Audit-log the rollback.
2. **Warm path** (interface exists): render wg(8) INI to temp file → `wg syncconf <name> <tempfile>` → diff against `wg show <name> dump` and emit `apply.peer.added` for peers appearing in the diff that weren't present before, plus `apply.peer.synced` summary. For removals, iterate `wg set <name> peer <pub> remove` — best-effort with one retry before failure.
3. **Drift detection**: after syncconf, parse `wg show <name> dump` and assert `listenPort == state.server.listenPort` and `serverPublicKey == state.server.serverPublicKey`. On mismatch → `apply.drift.detected` event, `rollbackPlan()` if drift is in `ListenPort` (rotating the private key requires engine restart; not Phase 1 scope).
4. **Dry-run**: `executeApply({ state, dryRun: true })` runs `planApply` + `renderWgIni` + `diffPeers`, emits no audit events, returns `applied=false` with full diagnostics in `messages[]`.

**Concurrency**: `executeApply` takes a `flock` on `/var/run/kintunnel-apply.lock` with 5s timeout (matches existing state save queue). Two concurrent reconciles serialize. **DO NOT** share this lock with backup's `/backups/.lock` — backup restore must acquire both, in order: backup lock first, then apply lock, to avoid deadlocking reconcile ticks that already hold apply lock.

**Rollback primitives**:
- `ip link del <name>` — interface-level rollback (only safe before warm path runs)
- `wg set <name> peer <pub> remove` — per-peer rollback (safe at any point)
- `iptables -D <chain> -m comment --comment <marker>` — networking rollback (`networking.ts` owns)

`rollbackPlan()` accepts a partial `ApplyPlan` (what was applied so far) and reverses in reverse order. Always best-effort — emits `apply.rollback.executed` with a `steps_reversed` array even on partial failure.

---

## 6. Networking policy module — `packages/engine/src/networking.ts` (NEW)

**Owner**: `stark-devops`. **Exports**:

```ts
export function detectEgressInterface(): Promise<string | undefined>;
export function planNetworking(config: EngineConfig, state: EngineState): NetworkingPlan;
export async function applyNetworking(config: EngineConfig, plan: NetworkingPlan): Promise<NetworkingResult>;
export async function rollbackNetworking(rulesInserted: string[]): Promise<NetworkingResult>;
export async function checkNatRulePresent(interfaceName: string, tunnelCidrV4: string, egressIface: string): Promise<boolean>;
export async function checkForwardingEnabled(): Promise<boolean>;
```

**Comment markers** (constants in this module, used both for apply and rollback):

| Constant | Comment marker | iptables rule sketch |
|---|---|---|
| `KINTUNNEL_FWD_ESTAB_RELATED` | `"kintunnel:fwd:allow-estab-related"` | `-A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT` |
| `KINTUNNEL_FWD_TUNNEL_NEW` | `"kintunnel:fwd:allow-tunnel-new"` | `-A FORWARD -i <iface> -m conntrack --ctstate NEW -j ACCEPT` |
| `KINTUNNEL_FWD_DROP_INVALID` | `"kintunnel:fwd:drop-invalid"` | `-A FORWARD -m conntrack --ctstate INVALID -j DROP` |
| `KINTUNNEL_NAT_MASQUERADE` | `"kintunnel:nat:masquerade"` | `-t nat -A POSTROUTING -s <tunnel_cidr> -o <egress_iface> -j MASQUERADE` |

**Idempotency pattern** (mandatory before every `-A`):

```bash
iptables -C <chain> <matches> -m comment --comment "<marker>" -j <target> 2>/dev/null \
  || iptables -A <chain> <matches> -m comment --comment "<marker>" -j <target>
```

If `-C` returns 0, skip `-A`. If `-A` returns non-zero, run rollback for everything inserted so far and surface `nat.applied=false`. The `iptables` lock at `/run/xtables.lock` (iptables-internal, we don't manage it) serializes concurrent writers — `applyNetworking` may briefly block.

**Forwarding** (`/proc/sys/net/ipv4/ip_forward`):
1. Read current value: `cat /proc/sys/net/ipv4/ip_forward`.
2. If `0`, attempt `sysctl -w net.ipv4.ip_forward=1`. Requires `NET_ADMIN` (granted via `cap_add`).
3. If write fails with `EPERM`, the engine reports `forwarding: required-bypass (permission)` in the health probe; do NOT treat as fatal — engine continues. Emit `networking.forwarding.enabled` only on actual change.

**FORWARD chain rule order** (research-locked):

1. `FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`  (return traffic first, kernel-wide)
2. `FORWARD -i <tunnel> -m conntrack --ctstate NEW -j ACCEPT`  (NEW tunnel → outbound)
3. `FORWARD -m conntrack --ctstate INVALID -j DROP`  (drop invalid last)

This order matters because `ESTABLISHED,RELATED` matches first and short-circuits. The DROP rule has the lowest match priority because some kernels reject INVALID-tracking CT before rule evaluation; we accept that and let INVALID packets die in the default policy.

**MASQUERADE**:
- `-t nat -A POSTROUTING -s <tunnel_cidr> -o <egress_iface> -j MASQUERADE`
- No `! -d <tunnel_cidr>` for v1 — research showed this complicates tunnel-to-tunnel traffic without clear win for the MVP family-scale workload. Open question tracked in §13.

**Detecting egress**: when `KINTUNNEL_WG_EGRESS_INTERFACE` is unset, run `ip -4 route show default | awk '{print $5; exit}'` once at apply time and cache in `NetworkingResult.egress_interface_used`.

**Error surface** (mirrors `apply.ts`):

```ts
class NetworkingError extends Error {
  code: "iptables_missing" | "rule_insert_failed" | "rule_check_failed" | "forwarding_write_failed" | "egress_unresolvable"
  detail: Record<string, string>
}
```

Rollback reverts in reverse insertion order using `iptables -D <chain> <matches> -m comment --comment "<marker>" -j <target>`. If `-D` reports "rule does not exist" (idempotent rollback), log and continue. Final state must be either fully applied or fully cleaned — partial state is reported as `ok=false, rollback_partial=true` for operator attention.

---

## 7. Backup module — `packages/engine/src/backup.ts` (NEW)

**Owner**: `stark-data`. **Exports**:

```ts
export interface BackupStorage {
  backupCreate(req: { trigger: BackupManifest["trigger"]; actor: string }): Promise<BackupSummary>;
  backupList(): Promise<BackupSummary[]>;
  backupRestore(req: BackupRestoreRequest, actor: string): Promise<{ applied: boolean; safety_snapshot_id?: string }>;
  backupExport(snapshotId: string): Promise<NodeJS.ReadableStream & { contentLength: number; sha256: string; filename: string }>;
  backupImport(stream: NodeJS.ReadableStream, source: string, actor: string): Promise<BackupSummary>;
  backupDelete(snapshotId: string, actor: string): Promise<void>;
  backupRestorePlan(snapshotId: string): Promise<BackupRestorePlan>;
}

export function createBackupStorage(config: EngineConfig, store: StateStore): BackupStorage;
```

**File layout** (under `KINTUNNEL_BACKUP_DIR`, default `/backups`, MUST be same filesystem as `KINTUNNEL_DATA_DIR`):

```
/backups/
  snap-<uuidv7>/
    manifest.json        # BackupManifest
    state.json           # snapshot of EngineState at trigger time
  tmp/
    snap-<uuidv7>.<randomHex(8)>.staging/
      manifest.json
      state.json
  .lock                  # flock target
  .retention             # last-prune timestamp + kept count
  exports/
    snap-<uuidv7>.tar.gz # streaming exports; build on demand from canonical dirs
```

**Atomic snapshot creation** (uses the shared atomic-write helper, see §12 Wave 0):

1. Acquire `flock(/backups/.lock, LOCK_EX, timeoutMs = KINTUNNEL_BACKUP_LOCK_TIMEOUT_MS)`.
2. Generate `snapshot_id = uuidv7()`.
3. `mkdir staging/`.
4. `await fs.writeFile(staging/manifest.json, manifest)` — manifest is built **before** the state copy so it reflects what the user *will* see on `backup.list()`.
5. `await fs.writeFile(staging/state.json, JSON.stringify(state, null, 2) + "\n")`.
6. `await atomicWrite(staging/manifest.json, manifest)` to refresh after SHA-256 of state is known — recompute manifest's `files[0].size_bytes` and `sha256`, re-emit. **OR** compute SHA on a streamed write into `state.json` so the manifest is correct first time. Prefer the streamed approach to avoid a re-write race.
7. `rename(staging → snap-<uuidv7>/)` — atomic on POSIX same-filesystem.
8. Run retention pruner (count-based, idempotent).
9. Release lock.

**Manifest schema**: see §2 `BackupManifest`. SHA-256 over the exact bytes that ship in `state.json`. `kintunnel_version` is read from `package.json` at module load (cached).

**Restore algorithm**:

1. Acquire backup lock.
2. If `force !== true`, take a safety snapshot of the current `state.json` (same as `backupCreate(trigger: "pre-rotate")`). Return its `snapshot_id` in the response.
3. Read the target snapshot, validate `kintunnel_version` against `KINTUNNEL_*_VERSION` from `package.json`. Reject with `412 PRECONDITION_FAILED` if `compatibility.min_engine_version` exceeds current.
4. If `apply=false` (dry-run): compute `peer_changes` (added / removed / modified) and return `BackupRestorePlan`. No state mutation.
5. If `apply=true`: 
   a. Stop the running reconcile if any (the engine's reconcile loop acquires a `withApplyLock`-style guard — see §12 Wave 5 / §13 open question).
   b. `fs.copyFile(snapshot/state.json, <dataDir>/state.json.tmp.<rand>)`.
   c. `fs.rename → state.json` (atomic — uses the same primitive as `StateStore.save`).
   d. Issue `reconcile()` to apply new state.
   e. Emit `backup.restored` with `applied=true`.
6. Release lock.

**Restore safety guarantee**: a restore that fails after step 5b but before 5d leaves a `state.json.tmp.<rand>` file which the next `StateStore.load()` would conflict with. **Pre-condition**: `StateStore.load()` must silently remove `.tmp.*` files at startup (idempotent), or the load must atomically read+rename. **Resolution**: add a startup-cleanup hook in `state.ts` that removes files matching `^.+\.tmp\.[a-f0-9]+$` under `dataDir`. Owned by `stark-data`.

**Retention pruner**:
- Sort snapshots by `created_at DESC`, keep first `KINTUNNEL_BACKUP_RETENTION_COUNT`, delete the rest.
- Manifest must validate before delete (sha256 re-check). Corrupt snapshots are kept (flagged `corrupt: true` in `list()`), NOT deleted by retention.
- Lock-free; runs at end of every `create()`. Failures logged, do not block create.

**Error table** (research-locked):

| Error | HTTP | Recovery |
|---|---|---|
| `lock_stale` | 503 | mtime > 5m → log + don't stomp |
| `manifest_sha_mismatch` | 409 on restore | mark `corrupt: true` in list |
| `version_too_old` | 412 | reject before touching anything |
| `engine_version_too_old` | 412 | reverse of above |
| `lock_timeout` | 409 | caller retries |
| `disk_full_mid_write` | 500 | cleanup staging |
| `restore_post_replace_fail` | 500 with `safety_snapshot_id` | operator can `backupRestore(safety_snapshot_id)` |

**Audit emission**: every public method emits via `store.appendEvent(state, …)` — the actor is `caller.actor` passed through (admin propagates admin user id; reconcile-driven calls use `"engine"`).

---

## 8. Health checks

### `getCapabilities()` augmentation (`runtime.ts`)

Add these probes (in order, all skipped when `dryRun=true`):

| Check | What it tests | Pass criterion | Fail response |
|---|---|---|---|
| `hasIptables` | `iptables --version` exits 0 | exit code 0 | `messages` warning: "iptables not available; networking policy will be skipped" |
| `ipForward` | `cat /proc/sys/net/ipv4/ip_forward` | value is `1` | `ipForward=false` in capability report — does NOT throw |
| `iptables -C` smoke | `iptables -t nat -L -n` exits 0 | exit 0 | `messages` warning: cannot inspect NAT table |
| Existing `hasWg`, `hasWgQuick`, `hasTun`, `canInspectInterface` | unchanged | unchanged | unchanged |

Add `hasIptables: boolean`, `hasIpset: boolean` (default false), `ipForward?: boolean` to `Capabilities` interface (see §2).

### Deep health module — `packages/engine/src/health.ts` (NEW)

**Owner**: `stark-observability`. **Exports**:

```ts
export async function runHealthChecks(config: EngineConfig, state: EngineState): Promise<HealthReport>;
export async function checkTun(): Promise<HealthCheck>;
export async function checkForwarding(): Promise<HealthCheck>;
export async function checkInterface(state: EngineState): Promise<HealthCheck>;
export async function checkNatRule(state: EngineState): Promise<HealthCheck>;
export async function checkIptables(): Promise<HealthCheck>;
export async function checkPortReachability(config: EngineConfig): Promise<HealthCheck>;
export async function checkStateIo(config: EngineConfig): Promise<HealthCheck>;
```

**Required vs warn**:

| Check | Required when | HealthCheck.required |
|---|---|---|
| `tun` | `!dryRun && forwardingRequired` | true |
| `forwarding` | `!dryRun && natEnabled && forwardingRequired` | true |
| `interface` | `!dryRun` | true |
| `nat` | `!dryRun && natEnabled && KINTUNNEL_NAT_APPLY=true` | true |
| `iptables` | `!dryRun && (natEnabled || KINTUNNEL_NAT_APPLY=true)` | true |
| `port` | `!dryRun` | false (warn-only) |
| `state_io` | always | true |

`runHealthChecks()` returns `HealthReport.ok = checks.filter(c => c.required).every(c => c.status === "pass")`.

### `/health` augmentation (`app.ts`)

Replace the existing `app.get("/health", …)` body (keep the route and the `ok: boolean` contract — that's the locked wire shape):

```ts
app.get("/health", async (_req, res, next) => {
  try {
    const state = await store.load().catch(() => null);
    if (!state) return res.status(503).json({ ok: false, service: "kintunnel-engine", checks: [...minimalStubChecks(config)] });
    const report = await runHealthChecks(config, state);
    res.status(report.ok ? 200 : 503).json(report);
  } catch (error) {
    next(error);
  }
});
```

The `/v1/health` (token-gated) endpoint also returns the same `HealthReport`. Adding a new field to a JSON response is forward-compatible — existing admin clients reading `ok` are unaffected.

### `GET /v1/capabilities` (NEW on the API router)

Returns the raw `Capabilities` object from `getCapabilities()`. Distinct from `/health` because capabilities is informational and never fails the response code; `/health` enforces 503 on required failures.

---

## 9. New API endpoints

All mount on the **engine** API router (`api` in `app.ts`) at both `/v1/*` and `/api/v1/*`. Auth is `Bearer KINTUNNEL_ENGINE_API_TOKEN` (existing `requireApiToken` middleware). Body schemas are JSON objects validated inline before calling the storage layer — validation errors throw `ValidationError` and return the existing `400/404` shape.

| Method | Path | Auth | Request | Response (200 / 201) | Error codes |
|---|---|---|---|---|---|
| `GET` | `/v1/health` | yes | — | `HealthReport` | 503 |
| `GET` | `/v1/capabilities` | yes | — | `Capabilities` | 200 (informational) |
| `POST` | `/v1/backups` | yes | `{ trigger?: "manual"\|"scheduled" }` | `BackupSummary` | 409 (lock held), 500 |
| `GET` | `/v1/backups` | yes | `?corrupt_only=true` | `{ backups: BackupSummary[] }` | 200 |
| `GET` | `/v1/backups/:id` | yes | — | `{ backup: BackupSummary, manifest: BackupManifest }` | 404, 409 (corrupt) |
| `GET` | `/v1/backups/:id/export` | yes | `?format=tar.gz` (default) | `application/gzip` stream, headers `X-Backup-SHA256`, `X-Backup-Size`, `Content-Disposition: attachment; filename="snap-<id>.tar.gz"` | 404, 409, 500 |
| `POST` | `/v1/backups/restore-plan` | yes | `{ snapshot_id }` | `BackupRestorePlan` | 404, 412 (version), 409 (corrupt) |
| `POST` | `/v1/backups/:id/restore` | yes | `{ apply: boolean; force?: boolean }` | `{ applied: boolean; safety_snapshot_id?: string }` | 404, 409, 412, 500 with `safety_snapshot_id` |
| `DELETE` | `/v1/backups/:id` | yes | — | `{ deleted: true, snapshot_id }` | 404 |

**Validation surfaces** (kept inline with `peers.ts` style):
- `POST /v1/backups` — `trigger` defaults to `"manual"`. Unknown fields → `400 validation_failed` with `unknown_fields`.
- `POST /v1/backups/:id/restore` — `apply` must be boolean. `force` optional boolean. `snapshot_id` resolved from URL.

**Audit emission from each endpoint**:

```ts
store.appendEvent(state, { action: "backup.created", targetName: snapshotId, metadata: { ... } });
```

after a successful state mutation. The `appendEvent` call goes inside the `store.update(...)` so it commits with the mutation.

**Streaming export contract** (`GET /v1/backups/:id/export`):
1. Build a single-snapshot tar.gz in memory? NO — too large for big states.
2. Stream the tar: open a Readable that wraps `tar.pack()` and emits `manifest.json` + `state.json` entries in order. Pre-compute SHA-256 over each entry's bytes and emit a trailing `manifest.verify.json` only if requested — but the **per-entry** SHA is in the manifest already.
3. Set `X-Backup-SHA256` to the SHA-256 of `state.json` (the only meaningful integrity check for the engine today).
4. Use `res.writeHead(200, headers); stream.pipe(res);` so backpressure is respected.

**Concurrency on endpoints**:
- `POST /v1/backups` and `POST /v1/backups/:id/restore` serialize via the `flock`. A second concurrent backup returns 409 with `error.code = "lock_held"`.
- `GET /v1/backups/:id/export` does NOT take the write lock — it streams the canonical directory form. Concurrent reads while a snapshot is being created are safe because the canonical dir is only visible after `rename(staging → snap-…)`.

---

## 10. Compose / Dockerfile changes

### `Dockerfile.engine` (MODIFIED — `stark-devops`)

Add (confirming what's already present and adding the missing pieces):

```dockerfile
# Confirmed present (line 24): iproute2 iptables wireguard-tools
# Add:
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libc-bin libc6 libcap2 libsystemd0 libudev1 \
        curl iproute2 iptables wireguard-tools \
        flock uuid-runtime ca-certificates \
    && rm -rf /var/lib/apt/lists/*
```

- `flock` — for the per-apply and per-backup locks
- `uuid-runtime` — for `uuidgen -t` sanity in shell scripts (engine uses `crypto.randomUUID()` for UUID v4, plus a UUID v7 implementation we'll vendor for snapshot_id)
- `ca-certificates` — for any future HTTPS validation in tooling

No other Dockerfile changes. `/var/lib/kintunnel`, `/etc/kintunnel`, `/backups` already exist (line 36).

### `docker-compose.yml` (MODIFIED — `stark-devops`)

Move `cap_add` from `compose/minimal-vps.yml` into the **base** compose so production is hardened by default (and overlays can further tighten). The locked model is `cap_drop ALL + cap_add NET_ADMIN NET_RAW`. Overlay files still set `devices /dev/net/tun` because Docker Compose `cap_add` does not require device passthrough — the kernel checks `CAP_NET_ADMIN` on the open(2) of `/dev/net/tun`, not the device bind.

Engine service changes:

```yaml
services:
  engine:
    init: true
    read_only: true
    cap_drop: [ALL]
    cap_add: [NET_ADMIN, NET_RAW]    # <-- moved from minimal-vps.yml
    security_opt: [no-new-privileges:true]
    tmpfs: [/tmp, /run]
    environment:
      # (all existing entries remain)
      KINTUNNEL_NAT_APPLY: ${KINTUNNEL_NAT_APPLY:-false}
      KINTUNNEL_BACKUP_DIR: ${KINTUNNEL_BACKUP_DIR:-/backups}
      KINTUNNEL_BACKUP_RETENTION_COUNT: ${KINTUNNEL_BACKUP_RETENTION_COUNT:-10}
      KINTUNNEL_BACKUP_LOCK_TIMEOUT_MS: ${KINTUNNEL_BACKUP_LOCK_TIMEOUT_MS:-30000}
      KINTUNNEL_APPLY_BOOTSTRAP_TIMEOUT_MS: ${KINTUNNEL_APPLY_BOOTSTRAP_TIMEOUT_MS:-15000}
      # Default detect via `ip route show default` (no env override shipped)
    volumes:
      - ./config:/etc/kintunnel:ro
      - kintunnel-data:/var/lib/kintunnel
      - kintunnel-backups:/backups    # <-- already present, ownership 0:0 (node uid inside container)
    # ports unchanged
```

Admin service: **no changes**. Its hardened profile (`cap_drop ALL`, `read_only`, no `NET_ADMIN`) is already correct.

Networks / secrets / volumes: unchanged.

### `compose/minimal-vps.yml` (MODIFIED — `stark-devops`)

```yaml
services:
  engine:
    restart: unless-stopped
    environment:
      KINTUNNEL_DRY_RUN: ${KINTUNNEL_DRY_RUN:-false}    # promote to false here
      KINTUNNEL_NAT_APPLY: ${KINTUNNEL_NAT_APPLY:-true}  # turn on here
    devices:
      - /dev/net/tun:/dev/net/tun
    sysctls:
      net.ipv4.ip_forward: "1"
      net.ipv4.conf.all.src_valid_mark: "1"
    # cap_add REMOVED — now in base compose
```

### `compose/dokploy-swarm.yml` (MODIFIED — `stark-devops`)

Mirror the engine service: add `cap_drop: ALL`, `cap_add: [NET_ADMIN, NET_RAW]`, `read_only: true`, `security_opt: [no-new-privileges:true]`, `tmpfs: [/tmp, /run]`. Do NOT add `docker.sock` mounts, host PID namespace, or `network_mode: host`. Keep `replicas: 1` (ADR-0004).

### `.env.example` (MODIFIED — `stark-devops`)

Add at the bottom:

```
# ── Phase 1 production engine tuning ──────────────────────────────────────
# Engine will request net.ipv4.ip_forward=1 and MASQUERADE rules.
KINTUNNEL_NAT_APPLY=false
# Where snapshots are kept. Must be on same filesystem as KINTUNNEL_DATA_DIR.
KINTUNNEL_BACKUP_DIR=/backups
KINTUNNEL_BACKUP_RETENTION_COUNT=10
KINTUNNEL_BACKUP_LOCK_TIMEOUT_MS=30000
KINTUNNEL_APPLY_BOOTSTRAP_TIMEOUT_MS=15000
# Optional egress override; engine auto-detects from default route if unset.
# KINTUNNEL_WG_EGRESS_INTERFACE=eth0
```

---

## 11. Tests to add

Each new test file uses `node:test` (matches existing `tests/engine/engine.test.ts` style — verify before writing). Mocking strategy: `mock` from `node:test/mock` for `child_process.execFile` and `node:fs/promises`. **No real `iptables`/`wg` invocation in unit tests** — that's reserved for the live VPS validation wave (P1.5, also §13 open question).

### `tests/engine/apply.test.ts` (NEW — `stark-testing`)

| Test | Assertions | Mock |
|---|---|---|
| `planApply detects bootstrap when interface absent` | `plan.bootstrap === true`, `actionsExecuted` empty | `getRuntimeState` mocked → `exists=false` |
| `planApply emits warm path on interface present with diff` | `plan.bootstrap === false`, `addPeers = [newPub]`, `removePeers = [gonePub]` | `getRuntimeState` mocked → `exists=true, peers=[existingPub]` |
| `executeApply in dry-run mode makes no exec calls` | `execaFile` never called, `result.applied=false`, `result.actionsExecuted` populated | mock execFile — call count 0 |
| `executeApply in live mode runs bootstrap sequence in order` | Order: `ip link add` → `wg setconf` → `ip addr` → `ip link set up` | mock execFile — record args |
| `apply rolls back interface on bootstrap failure` | After `ip link add` succeeds but `wg setconf` throws, `ip link del <name>` invoked | mock execFile — throw on second call |
| `peer removal uses wg set <iface> peer <pub> remove` | After syncconf, removals iterate `wg set` not `syncconf` | mock execFile — record args |
| `drift detection after syncconf` | mismatched listenPort → returns `drift.detected=true`, emits `apply.drift.detected` event | mock execFile — `wg show dump` returns wrong port |
| `ApplyError.code` correctly assigned | "capability_missing", "interface_exists", "interface_missing", "duplicate_address", "duplicate_pubkey", "key_format_invalid", "bootstrap_timeout", "syncconf_failed", "peer_remove_failed", "drift_unrecoverable", "dry_run_only" | each from a distinct mock failure |

### `tests/engine/networking.test.ts` (NEW — `stark-testing`)

| Test | Assertions | Mock |
|---|---|---|
| `applyNetworking inserts 3 FORWARD rules + 1 MASQUERADE on fresh host` | 4 `iptables -C` then 4 `iptables -A` calls | mock execFile — first `-C` returns 1 each |
| `applyNetworking is idempotent on second call` | All 4 `iptables -C` return 0, no `-A` calls | mock execFile — `-C` returns 0 |
| `applyNetworking rolls back partial apply on MASQUERADE failure` | After 3 FORWARD rules succeed and MASQ fails, 3 `iptables -D` calls | mock execFile — throw on MASQ `-A` |
| `detectEgressInterface reads default route` | Returns first match from `ip -4 route show default` | mock execFile — return canned route |
| `forwarding writes sysctl only when current is 0` | When `/proc/sys/net/ipv4/ip_forward` reads `0`, `sysctl -w net.ipv4.ip_forward=1` is issued | mock `fs.readFile` + mock execFile |
| `forwarding silent skip when already enabled` | When `/proc/sys/net/ipv4/ip_forward` reads `1`, no `sysctl -w` call | mock `fs.readFile` |
| `comment markers used consistently in apply and rollback` | The marker strings in `NetworkingPolicy` constants appear verbatim in mocked `iptables` args | mock execFile — capture args |

### `tests/engine/backup.test.ts` (NEW — `stark-testing`)

| Test | Assertions | Mock |
|---|---|---|
| `create writes staging dir, then renames to snap-*/` | After create, `snap-<uuidv7>/manifest.json` + `state.json` exist, staging dir is removed | mock `node:fs` |
| `manifest sha256 matches state.json bytes` | Recomputing SHA-256 of the stored state.json yields the SHA in `manifest.files[0].sha256` | mock `node:fs` |
| `rename uses atomic temp-then-rename` | Failure on the final `rename` leaves staging intact | mock `rename` to throw |
| `retention pruner keeps the most recent N snapshots` | Create 12, set retention=10 → list() returns 10 sorted by `created_at DESC` | mock `node:fs` |
| `restore dry-run computes correct peer_changes` | Backup with peer X, current without X → plan.peer_changes.added = ["X"], removed = [] | mock `node:fs` |
| `restore apply takes a safety snapshot, then swaps state.json` | `backup.restore({apply:true})` calls `create` with `trigger:pre-rotate` BEFORE the state copy | mock `node:fs` — call order |
| `restore version incompatibility rejected with 412-shape` | `compatibility.min_engine_version = "99.0.0"`, current = `"0.x.y"` → throws `EIncompatibleVersion` | mock `node:fs` |
| `lock contention surfaces 409` | When `flock` cannot be acquired within timeout, throws `ELockHeld` | mock flock — block |
| `restore on corrupt manifest fails before touching state.json` | Manifest's `files[0].sha256` doesn't match actual file → throws, `state.json` is unchanged | mock `node:fs` |
| `state startup-cleanup removes stray .tmp.*` | StateStore.load() called when `dataDir/.state.<rand>.tmp` exists → it is removed | mock `node:fs` |

### `tests/engine/health.test.ts` (NEW — `stark-testing`)

| Test | Assertions | Mock |
|---|---|---|
| `runHealthChecks 200 when all required pass` | `ok=true`, no required check fails | mock execFile + fs — all pass |
| `runHealthChecks 503 when tun missing and required` | `ok=false`, `checks.find(c => c.name === "tun").status === "fail"` | mock `pathExists` → false |
| `runHealthChecks 503 when forwarding required but ip_forward=0` | `ok=false`, `check.forwarding.status === "fail"` | mock `fs.readFile` of proc |
| `port reachability is warn, not required` | `check.port.required === false`, `ok=true` even if port.warn | mock UDP probe |
| `state_io fail returns 503` | `state_io.required=true`, throwing → 503 | mock StateStore.load |
| `reports include checks order: tun,forwarding,interface,nat,iptables,port,state_io` | `array order matches` | n/a |

### `tests/engine/engine.test.ts` (MODIFIED — `stark-testing`)

Add (additive):
- Assert `GET /health` response has `checks: HealthCheck[]` after `runHealthChecks` integration.
- Assert `GET /v1/capabilities` returns `Capabilities` with new fields (`hasIptables`, `ipForward`).
- Existing `ok: boolean` assertions pass unchanged.

---

## 12. Implementation order (waves)

Each wave names the agents whose owned files are touched, in parallel where no collisions exist. **Wave N+1 must NOT start before Wave N's gate is green** (the gate = the listed test file passes + the listed audit/check is observable).

### Wave 0 — Foundation (sequential gate, no parallelism inside)

| Step | Agent | Files | Test | Gate |
|---|---|---|---|---|
| 1 | `stark-architect` | `packages/engine/src/types.ts` | `tests/engine/types.test.ts` (light: compile only) | `npm run build` green |
| 2 | `stark-devops` | `packages/engine/src/env.ts`, `.env.example` | `tests/engine/env.test.ts` | unit passes, no validation regressions |
| 3 | `stark-data` | `packages/engine/src/state.ts` (add `atomicWriteFile`, `withFileLock` helpers; remove-stray-tmp hook; backup primitive) | `tests/engine/backup.test.ts` first 3 tests | primitive compiles, state.save regression test green |

> **Why sequential**: `types.ts` types flow into `env.ts` (`EngineConfig` extension), which flows into `state.ts` (helpers use config fields). Doing these serially catches type errors early.

### Wave 1 — Capability extension

| Step | Agent | Files | Test | Gate |
|---|---|---|---|---|
| 1 | `stark-architect` | `packages/engine/src/runtime.ts` (`getCapabilities` + parse new dump cols) | `tests/engine/runtime.test.ts` | existing /health contract preserved |

### Wave 2 — Apply path

| Step | Agent | Files | Test | Gate |
|---|---|---|---|---|
| 1 | `stark-integration` | `packages/engine/src/apply.ts` (NEW) | `tests/engine/apply.test.ts` | all 8 tests green |
| 2 | `stark-architect` | `packages/engine/src/runtime.ts` (reconcile calls apply) | `tests/engine/runtime.test.ts` extends | reconcile unit + dry-run + apply unit green |

### Wave 3 — Networking

| Step | Agent | Files | Test | Gate |
|---|---|---|---|---|
| 1 | `stark-devops` | `packages/engine/src/networking.ts` (NEW) | `tests/engine/networking.test.ts` | all 7 tests green |
| 2 | `stark-architect` | `packages/engine/src/runtime.ts` (reconcile calls networking) | `tests/engine/runtime.test.ts` extends | reconcile unit green |

> **Wave 2 and Wave 3 can run in parallel** — different new files, no collision. But **Wave 2 step 2 / Wave 3 step 2 both modify `runtime.ts`** — those MUST run sequentially. Order: Wave 2 step 2 first, then Wave 3 step 2.

### Wave 4 — Backup

| Step | Agent | Files | Test | Gate |
|---|---|---|---|---|
| 1 | `stark-data` | `packages/engine/src/backup.ts` (NEW) | `tests/engine/backup.test.ts` (all 10) | all green |
| 2 | `stark-security` | `packages/engine/src/app.ts` (mount new routes) | `tests/engine/app.test.ts` extends | route registration + 401 + 404 cases |

> **Wave 2 (apply) + Wave 4 (backup) run in parallel**; both eventually touch `state.ts` (`restorePlan` uses `appendEvent`) and `app.ts`. **Schedule**: Wave 4 step 2 (`app.ts`) starts after Wave 2 step 1 + Wave 4 step 1 are both green, to avoid two agents editing `app.ts`.

### Wave 5 — Health

| Step | Agent | Files | Test | Gate |
|---|---|---|---|---|
| 1 | `stark-observability` | `packages/engine/src/health.ts` (NEW) | `tests/engine/health.test.ts` | all 6 green |
| 2 | `stark-security` | `packages/engine/src/app.ts` (augment `/health`, `/v1/health`, `/v1/capabilities`) | `tests/engine/engine.test.ts` extend | existing locked `/health` shape preserved, new fields additive |

> **Wave 5 step 2 collides with Wave 4 step 2 on `app.ts`** — stagger. Run Wave 4 step 2 first, then Wave 5 step 2.

### Wave 6 — Containers

| Step | Agent | Files | Test | Gate |
|---|---|---|---|---|
| 1 | `stark-devops` | `Dockerfile.engine`, `docker-compose.yml`, `compose/minimal-vps.yml`, `compose/dokploy-swarm.yml` | `docker compose config --quiet` clean, `docker compose build` clean, `node:22-bookworm` available | docker-compose parses + base image builds |

### Wave 7 — CI / live VPS validation (out of unit scope but blocks tag)

| Step | Agent | Files | Test | Gate |
|---|---|---|---|---|
| 1 | `stark-devops` | `.github/workflows/ci.yml` (or equivalent) — add live VPS smoke job | manual run on a tag | `wg show <iface> dump` shows expected peer public key after `docker compose --profile admin up -d` |

> **Wave 7 is intentionally NOT enumerated as a unit-test wave.** The research explicitly deferred live VPS validation to CI. The implementation owner needs to wire the job from the existing CI surface — if no CI file exists, this becomes its own prep task. Confirmed in §13.

### Parallel-safety summary

| File | Owners across waves | Conflict-free resolution |
|---|---|---|
| `types.ts` | Wave 0 only | single-agent, no contention |
| `env.ts` | Wave 0 only | single-agent, no contention |
| `state.ts` | Wave 0 (only step that touches) | single-agent, no contention |
| `runtime.ts` | Wave 1, Wave 2 step 2, Wave 3 step 2 | serialize all three |
| `app.ts` | Wave 4 step 2, Wave 5 step 2 | serialize: Wave 4 step 2 first |
| `apply.ts` | Wave 2 step 1 only | no contention |
| `networking.ts` | Wave 3 step 1 only | no contention |
| `backup.ts` | Wave 4 step 1 only | no contention |
| `health.ts` | Wave 5 step 1 only | no contention |
| Compose / Dockerfile | Wave 6 only | no contention |

---

## 13. Risks and open questions

These are explicit ambiguities that the research surfaced but did not fully resolve. They MUST land in `PLAN.md` § Risks before Wave 0 starts.

| # | Risk / question | Why unresolved | Action |
|---|---|---|---|
| 1 | **Live VPS validation in CI (P1.5)** — research named a real VPS needed. We don't know if GH Actions self-hosted runner exists for kintunnel, or whether to use a disposable cloud VM, or whether the user's IGD VPS is reachable from CI. | Outside this plan's file scope; needs deployment topology decision. | Hand off to `stark-devops` for runner + sudo / SSH config; not a blocker for unit-test waves 0-6. |
| 2 | **`-d <tunnel_cidr>` MASQUERADE exclusion** — research showed the `! -d` form prevents MASQUERADING tunnel-to-tunnel. Convenient for "tunnel sees server's view". But the existing reconcile does NOT enforce peer AllowedIPs to be a strict subset of tunnel_cidr (peers can have arbitrary `AllowedIPs` set per-peer). | Could break legitimate peer setups where a peer's `AllowedIPs` extends beyond tunnel CIDR. | **Default v1**: no `-d` flag. Surface as `NetworkingPlan.masquerade_exclude_tunnel_cidr = false` constant. Document in `docs/networking.md` and let operators flip it once we have a peer-shaped deployment. |
| 3 | **Reconcile ↔ restore race** — `restore.apply=true` swaps `state.json` and triggers `reconcile()`. If a reconcile is already in flight, two writers race on `state.save()`. | `state.ts writeQueue` is in-process only. A long-running reconcile holding the queue starves the restore's `save`. | Strategy: introduce a `withApplyLock` guard that pauses the reconcile ticker during restore. Implementation: extract a `LockableQueue` from `writeQueue` and bridge it to the backup `flock`. **Defer to Plan §13 followup** if too invasive — the `flock` alone plus "reconcile tick runs at most every 30s" gives enough slack for a manual restore in v1. |
| 4 | **UUID v7 for snapshot_id** — Node's `crypto.randomUUID()` is v4. v7 is required for time-sortable backup IDs. | Need to vendor a small UUID v7 generator. ~50 LOC. | Vendor `uuidv7()` from `github.com/uuid-rs/uuid` algorithms — write a minimal `packages/engine/src/uuidv7.ts` (no deps). Owned by `stark-data`. |
| 5 | **`privateKeyRef` storage in `ServerSettings`** — currently `serverPrivateKey` is in plaintext in `state.json`. ADR-0002 says engine owns host networking but doesn't pin key-at-rest model. | Backup manifest will then include the SHA of a state.json that **contains the private key**. Restoring that backup onto a different host exposes the key. | Plan §13 tracks encryption-at-rest for Phase 2. v1 backups are explicit operator action — document in `docs/backup.md`. |
| 6 | **`KINTUNNEL_PUBLIC_ENDPOINT` is set in compose but never consumed by `env.ts`** — the audit report flagged this. | Not in scope for Phase 1 networking — admin constructs client configs. | Owner: future admin-side proxy work; defer. |
| 7 | **`KINTUNNEL_CONFIG_FILE` is set in compose but never consumed** — same issue. | Defer. | Defer. |
| 8 | **Admin-side proxy endpoints** — `specs/api.md` lists `/api/v1/backups` under the admin API. The engine exposes `/v1/backups`. Two options: (a) admin proxies straight through with a token forward, (b) admin duplicates logic. | Out of scope here, but breaks the "admin = single ingress" story. | Flag for follow-up plan: `stark-integration` writes a thin Express proxy in `packages/admin/src/app.ts` that forwards `/api/v1/backups/*` to the engine and adds admin-level authorization on top. |
| 9 | **`HEALTHCHECK` in Dockerfile + compose healthcheck are both `curl /health`** — both will report the same 503 if a deep check fails. That's intentional, but on a fresh boot the engine has no `state.json` yet, so `state_io` and `interface` will be `fail` for the first 30s. | Docker `start_period: 30s` covers it but operators may extend the period. | Document `start_period: 30s` minimum in `README.md` and `docs/health.md`. |
| 10 | **`apply.kt` `rollbackPlan` is best-effort** — if the engine is in mid-bootstrap and `iptables` rollback fires, we may leave inconsistent `net.ipv4.ip_forward=1`. | Research does not propose restoring ip_forward because host iptables can't enforce that policy. | Decision: ip_forward is a host-level toggle, **NOT** rolled back automatically. `restorePlan` only rolls back interface + peers + iptables rules. Operators can `sysctl -w net.ipv4.ip_forward=0` if needed. |
| 11 | **`wg-quick` cold start vs `ip link add` bootstrap** — research recommended bootstrap without `wg-quick`. But the engine's existing `runtime.ts` calls `wg-quick`. | Replacing `wg-quick` cold-start requires updating `keys.ts` and the listener bring-up. The plan uses `wg-quick` for cold start (constraint says so) AND a manual `ip link add + wg setconf` path for idempotency. | Plan uses: `wg-quick up /etc/wireguard/wg0.conf` for cold start IF a wg-quick config exists; otherwise the manual bootstrap path. The wg-quick config is generated on-demand to `/etc/wireguard/wg0.conf` from `state.server` at first reconcile. This is a clarification of the constraint "wg-quick for cold start" — the engine writes the wg-quick config rather than running a hand-rolled ip+wg+iptables stack from cold. |
| 12 | **`Dockerfile.engine` runs as `USER node`** — `node` user cannot raw-open `/dev/net/tun` even with `NET_ADMIN` because `setcap` was not run on `node`. | Need to verify: does `cap_add NET_ADMIN` transfer capabilities to the running UID, or do we need `setcap cap_net_admin=+ep` on the node binary? | Plan: use `init: true` + `cap_add: NET_ADMIN NET_RAW` (no setcap needed because capabilities are ambient in the container by default since Docker 20.10). Confirm against `Dockerfile.engine:39 USER node` + `docker-compose.yml`. If `node` cannot open `/dev/net/tun`, switch to: keep `USER node` and add `RUN setcap cap_net_admin,cap_net_raw+ep /usr/local/bin/node` in the Dockerfile. This is a one-line addition owned by `stark-devops`. |
| 13 | **No admin-side changes are part of this plan.** The admin service still consumes the same engine endpoints. New endpoints appear in `/v1/backups`; admin will surface them via a follow-up plan (see #8). | Plan scope locked. | Document as plan-known limitation. |
| 14 | **CI workflow file** — no `.github/workflows/*.yml` file was found in the read set. Wave 7 assumes one exists. | Need to confirm during plan execution. | If absent, Wave 7 becomes a setup task (write a `ci.yml` from scratch) and depends on operator review. |
| 15 | **`reconcile` no longer in `dry-run` mode after a successful apply** — what does the next reconcile do? `planApply` should detect no diff and return early. | Need a fast path test. | Add to `apply.test.ts`: `planApply returns empty actions when state matches runtime`. |
| 16 | **`packages/engine/src/index.ts`** in scope was not in the original read set — the boot order description in Wave 0 step 3 references it. | Discover before Wave 0 step 3. | Wave 0 agent must Read `index.ts` first and confirm it's a thin `app.listen()` shell; if more complex, escalate before touching `state.ts`. |

---

## Acceptance gate for "Phase 1 production-ready" (mirrors `PLAN.md`)

All of the following must be true before Phase 2 begins:

- [ ] `npm run build` clean for both packages
- [ ] `npm test --workspace @kintunnel/engine` green (all new test files in §11 + existing)
- [ ] `docker compose -f docker-compose.yml -f compose/minimal-vps.yml --profile admin build` clean
- [ ] `docker compose ... config` validates (no port conflicts, no missing secrets)
- [ ] On a fresh VPS that satisfies host prereqs (`/dev/net/tun`, `ip_forward=1`, UDP/51820 open):
  - [ ] `docker compose --profile admin up -d` brings engine + admin to healthy
  - [ ] `POST /v1/peers` creates a peer; `GET /v1/status` shows it active; `wg show wg0 dump` (from inside the engine container via `docker exec`) shows its public key as a peer
  - [ ] `POST /v1/reconcile` returns `ok=true, applied=true`
  - [ ] `curl /v1/health` returns 200 with all `checks[].status === "pass"`
  - [ ] `POST /v1/backups` returns 201 with a `snapshot_id`; `GET /v1/backups` shows it
  - [ ] Modify state (add a second peer), `POST /v1/backups` again; `POST /v1/backups/restore-plan` against the FIRST backup shows the second peer in `peer_changes.removed`
  - [ ] `POST /v1/backups/<id>/restore { "apply": true }` returns `{ applied: true, safety_snapshot_id: "snap-..." }`; engine stays healthy
  - [ ] `audit-log` queryable via `GET /v1/events?limit=50` shows `apply.peer.added`, `networking.masquerade.applied`, `backup.created`, `backup.restored` events
- [ ] `cap_add NET_ADMIN NET_RAW + cap_drop ALL` confirmed by `docker exec kintunnel-engine capsh --print | grep -E 'Current|Bounding'`
- [ ] No `/var/run/docker.sock` mounts anywhere in the running stack: `docker inspect kintunnel-engine | jq '.[0].Mounts'`
- [ ] No `network_mode: host` for the engine except UDP/51820 (which uses `mode: host` for the port mapping, not full host networking): `docker inspect kintunnel-engine | jq '.[0].HostConfig.NetworkMode'`
