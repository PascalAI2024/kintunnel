export type PeerStatus = "active" | "disabled" | "revoked" | "deleted";

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

export interface EngineState {
  version: 1;
  revision: number;
  server: ServerSettings;
  peers: PeerRecord[];
  lastReconcile?: ReconcileResult;
}

export interface EngineConfig {
  port: number;
  dataDir: string;
  statePath: string;
  dryRun: boolean;
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
