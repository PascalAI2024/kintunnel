export interface EngineStatus {
  ok?: boolean;
  ready?: boolean;
  dry_run?: boolean;
  revision?: number;
  engine?: string;
  version?: string;
  interface?: {
    name?: string;
    listen_port?: number;
    public_key?: string;
    up?: boolean;
  };
  peers?: {
    total?: number;
    active?: number;
    disabled?: number;
    revoked?: number;
    deleted?: number;
  };
  server?: {
    interfaceName?: string;
    listenPort?: number;
    serverPublicKey?: string;
  };
  message?: string;
  checked_at?: string;
  [key: string]: unknown;
}

export interface Peer {
  id: string;
  name: string;
  status?: string;
  public_key?: string;
  address_v4?: string;
  address_v6?: string;
  allowed_ips?: string[] | string;
  dns_servers?: string[] | string;
  expires_at?: string | null;
  created_at?: string;
  updated_at?: string;
  last_handshake_at?: string | null;
  transfer_rx_bytes?: number;
  transfer_tx_bytes?: number;
  // P3.1 — links a peer to a Person + a human-readable device label.
  person_id?: string;
  device_label?: string;
  [key: string]: unknown;
}

export interface AdminPerson {
  id: string;
  display_name: string;
  notes?: string;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface AuditEvent {
  id: string;
  action: string;
  actor?: string;
  target_id?: string;
  target_name?: string;
  revision?: number;
  created_at?: string;
  metadata?: Record<string, unknown>;
}

export interface PeerCreateInput {
  name: string;
  public_key?: string;
  generate_keys?: boolean;
  allowed_ips?: string[];
  dns_servers?: string[];
  expires_at?: string;
}
