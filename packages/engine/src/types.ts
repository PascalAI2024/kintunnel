export type PeerStatus = "active" | "disabled" | "revoked" | "deleted";
export type AuditAction =
  | "state.initialized"
  | "peer.created"
  | "peer.config.exported"
  | "peer.revoked"
  | "peer.deleted"
  | "reconcile.completed"
  // P3.4 expiry automation:
  | "peer.expired.auto_revoked"
  | "peer.expired.warned"
  | "peer.expiring.warned"
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
  | "backup.deleted"
  // P3.1 person/device family-scale data model:
  | "person.created"
  | "person.updated"
  | "person.archived"
  | "person.deleted"
  | "person.device.added"
  | "person.device.removed"
  | "person.devices.revoked";

export interface ServerSettings {
  interfaceName: string;
  listenPort: number;
  endpointHost: string;
  endpointPort: number;
  tunnelCidrV4: string;
  serverAddressV4: string;
  serverPublicKey: string;
  serverPrivateKey: string;
  defaultAllowedIps: string[];
  defaultDnsServers: string[];
  persistentKeepalive: number;
  mtu?: number;
  natEnabled: boolean;
  forwardingRequired: boolean;
  updatedAt: string;
}

export interface PeerRecord {
  id: string;
  name: string;
  publicKey: string;
  privateKey?: string;
  addressV4: string;
  allowedIps: string[];
  dnsServers: string[];
  persistentKeepalive: number;
  status: PeerStatus;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  deletedAt?: string;
  // NEW (P3.1) — links a peer to a Person and a human-readable device label.
  // Both fields are optional; existing peers continue to work unassigned.
  personId?: string;
  deviceLabel?: string;
}

export type ApiPeerStatus = PeerStatus | "expired";

// ── Person types (P3.1) ─────────────────────────────────────────────────────
// A Person is a human member of the trusted group. Soft-deleted via
// status="archived"; cannot have new devices created while archived.
export type PersonStatus = "active" | "archived";

export interface PersonRecord {
  id: string;                  // UUID v4 (crypto.randomUUID())
  displayName: string;         // 1-120 chars; same pattern as PeerRecord.name
  notes?: string;              // 0-2000 chars; no control chars
  status: PersonStatus;        // active or archived (soft-deleted)
  createdAt: string;           // ISO 8601 UTC
  updatedAt: string;           // ISO 8601 UTC
}

export interface EngineState {
  version: 1;
  revision: number;
  server: ServerSettings;
  peers: PeerRecord[];
  // NEW (P3.1) — persons registered for family/group membership. Empty
  // until persons are created; persisted across upgrades via migration
  // in StateStore.load().
  persons: PersonRecord[];
  events?: AuditEvent[];
  lastReconcile?: ReconcileResult;
}

export interface AuditEvent {
  id: string;
  action: AuditAction;
  actor: string;
  targetId?: string;
  targetName?: string;
  revision: number;
  createdAt: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface EngineConfig {
  env: string;
  port: number;
  dataDir: string;
  statePath: string;
  dryRun: boolean;
  apiToken: string;
  interfaceName: string;
  listenPort: number;
  endpointHost: string;
  endpointPort: number;
  tunnelCidrV4: string;
  defaultAllowedIps: string[];
  defaultDnsServers: string[];
  persistentKeepalive: number;
  natEnabled: boolean;
  forwardingRequired: boolean;
  // NEW (P1.2 networking + P1.3 backup) — see env.ts validation:
  natApply: boolean;
  backupDir: string;
  backupRetentionCount: number;
  backupLockTimeoutMs: number;
  applyBootstrapTimeoutMs: number;
  wgEgressInterface?: string;
}

export interface KeyPair {
  privateKey: string;
  publicKey: string;
}

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
  // NEW (optional — additive, preserves wire shape for old admin clients):
  apply?: ApplyResult;
  networking?: NetworkingResult;
  actionsExecuted?: string[];
}

// ── Apply path types (P1.1) ────────────────────────────────────────────────
export interface ApplyPlan {
  /** Which actions the plan intends — drives boot vs warm path. */
  bootstrap: boolean;
  reconfigureInterface: boolean;
  addPeers: string[]; // public keys
  removePeers: string[]; // public keys
  modifyPeers: string[]; // public keys (allowed-ips / psk / keepalive change)
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

// ── Networking types (P1.2) ────────────────────────────────────────────────
export interface NetworkingPolicy {
  interfaceName: string;
  tunnelCidrV4: string;
  egressInterface: string; // detected via `ip route show default` if unset
  natEnabled: boolean;
  forwardingRequired: boolean;
}

export interface NetworkingPlan {
  enableForwarding: boolean; // net.ipv4.ip_forward = 1 if currently 0
  masqueradeRule: boolean; // MASQUERADE for tunnel egress
  forwardRules: {
    allowTunnelNew: boolean;
    allowEstablishedRelated: boolean;
    dropInvalid: boolean;
  };
}

export interface NetworkingResult {
  ok: boolean;
  applied: boolean;
  rulesInserted: string[]; // comment markers of rules successfully applied
  rulesRolledBack: string[]; // comment markers of rules rolled back
  forwardingEnabled: boolean;
  warnings: string[];
  errors: string[];
}

// ── Backup types (P1.3) ────────────────────────────────────────────────────
export interface BackupManifest {
  kintunnel_version: string; // semver from package.json
  format_version: 1;
  schema_version: 1;
  snapshot_id: string; // UUID v7
  engine_revision: number; // state.revision at snapshot time
  created_at: string; // ISO timestamp
  trigger: "manual" | "post-restore" | "scheduled" | "pre-rotate";
  interface: {
    name: string;
    listen_port: number;
    public_key: string;
    tunnel_cidr_v4: string;
  };
  files: Array<{
    path: string; // relative inside the snapshot dir, e.g. "state.json"
    size_bytes: number;
    sha256: string;
  }>;
  compatibility: {
    min_engine_version: string;
    max_engine_version?: string; // absent means "no upper bound"
  };
  encrypted: false; // explicitly plaintext v1; future field
  retention: {
    policy: "count"; // only count-based in v1
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
  corrupt: boolean; // sha256 mismatch or manifest unreadable
}

export interface BackupRestoreRequest {
  snapshot_id: string;
  apply: boolean; // true = swap state.json + force reconcile, false = dry-run
  force?: boolean; // skip safety snapshot if true
}

export interface BackupRestorePlan {
  snapshot_id: string;
  from_revision: number; // state.revision in backup
  to_revision?: number; // state.revision at plan time (current)
  peer_changes: {
    added: string[]; // peers in backup absent from current
    removed: string[]; // peers in current absent from backup
    modified: string[]; // same pubkey, different config
  };
  affected_public_keys: string[];
  warnings: string[];
  apply_blocked_reasons: string[];
}

// ── Health types (P1.4) ────────────────────────────────────────────────────
export type HealthCheckStatus = "pass" | "fail" | "warn" | "skip";

export interface HealthCheck {
  name: "tun" | "forwarding" | "interface" | "nat" | "iptables" | "port" | "state_io";
  status: HealthCheckStatus;
  detail: string;
  observed_at: string;
  required: boolean; // when required and !pass, /health returns 503
}

export interface HealthReport {
  ok: boolean; // true iff all required checks pass
  service: "kintunnel-engine";
  dry_run: boolean;
  env: string;
  checks: HealthCheck[];
  messages: string[];
  checked_at: string;
}

// ── Capability extensions (P1.1 / P1.2) ────────────────────────────────────
export interface Capabilities {
  platform: NodeJS.Platform;
  dryRun: boolean;
  hasWg: boolean;
  hasWgQuick: boolean;
  hasIptables: boolean; // NEW — was missing
  hasIpset: boolean; // NEW — currently always false (we don't use it)
  hasTun: boolean;
  canInspectInterface: boolean;
  interfaceName: string;
  ipForward?: boolean; // NEW — current sysctl value
  messages: string[];
}
