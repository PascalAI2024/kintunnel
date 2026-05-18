export type PeerStatus = "active" | "disabled" | "revoked" | "deleted";
export type AuditAction =
  | "state.initialized"
  | "peer.created"
  | "peer.config.exported"
  | "peer.revoked"
  | "peer.deleted"
  | "reconcile.completed";

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
}

export type ApiPeerStatus = PeerStatus | "expired";

export interface EngineState {
  version: 1;
  revision: number;
  server: ServerSettings;
  peers: PeerRecord[];
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
}
