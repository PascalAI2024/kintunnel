import path from "node:path";
import type { EngineConfig } from "./types.js";

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function listEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  const dataDir = overrides.dataDir ?? process.env.KINTUNNEL_DATA_DIR ?? path.resolve(".", "data", "engine");
  const listenPort = overrides.listenPort ?? intEnv("KINTUNNEL_WG_LISTEN_PORT", 51820);

  return {
    port: overrides.port ?? intEnv("KINTUNNEL_ENGINE_PORT", 9090),
    dataDir,
    statePath: overrides.statePath ?? path.join(dataDir, "state.json"),
    dryRun: overrides.dryRun ?? boolEnv(process.env.KINTUNNEL_DRY_RUN, false),
    interfaceName: overrides.interfaceName ?? process.env.KINTUNNEL_WG_INTERFACE ?? "wg0",
    listenPort,
    endpointHost: overrides.endpointHost ?? process.env.KINTUNNEL_ENDPOINT_HOST ?? "localhost",
    endpointPort: overrides.endpointPort ?? intEnv("KINTUNNEL_ENDPOINT_PORT", listenPort),
    tunnelCidrV4: overrides.tunnelCidrV4 ?? process.env.KINTUNNEL_WG_ADDRESS ?? "10.8.0.0/24",
    defaultAllowedIps: overrides.defaultAllowedIps ?? listEnv("KINTUNNEL_ALLOWED_IPS", ["0.0.0.0/0"]),
    defaultDnsServers: overrides.defaultDnsServers ?? listEnv("KINTUNNEL_DNS_SERVERS", ["1.1.1.1"]),
    persistentKeepalive: overrides.persistentKeepalive ?? intEnv("KINTUNNEL_PERSISTENT_KEEPALIVE", 25),
    natEnabled: overrides.natEnabled ?? boolEnv(process.env.KINTUNNEL_NAT_ENABLED, true),
    forwardingRequired: overrides.forwardingRequired ?? boolEnv(process.env.KINTUNNEL_FORWARDING_REQUIRED, true)
  };
}
