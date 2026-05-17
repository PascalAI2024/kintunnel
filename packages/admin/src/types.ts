export interface EngineStatus {
  ok?: boolean;
  ready?: boolean;
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
  [key: string]: unknown;
}

export interface PeerCreateInput {
  name: string;
  public_key?: string;
  generate_keys?: boolean;
  allowed_ips?: string[];
  dns_servers?: string[];
  expires_at?: string;
}
