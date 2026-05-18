import path from "node:path";
import fs from "node:fs";
import type { EngineConfig } from "./types.js";

const MIN_PRODUCTION_API_TOKEN_LENGTH = 32;
const PLACEHOLDER_API_TOKEN_PARTS = [
  "change-me",
  "changeme",
  "default",
  "engine-token",
  "example",
  "password",
  "secret",
  "token"
];

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
  const env = overrides.env ?? process.env.KINTUNNEL_ENV ?? "production";
  const dataDir = overrides.dataDir ?? process.env.KINTUNNEL_DATA_DIR ?? path.resolve(".", "data", "engine");
  const listenPort = overrides.listenPort ?? intEnv("KINTUNNEL_WG_LISTEN_PORT", 51820);
  const dryRun = overrides.dryRun ?? boolEnv(process.env.KINTUNNEL_DRY_RUN, true);
  const hostNetworkingEnabled = boolEnv(process.env.KINTUNNEL_ENABLE_HOST_NETWORKING, false);
  const apiToken = overrides.apiToken ?? readSecret("KINTUNNEL_ENGINE_API_TOKEN", "KINTUNNEL_ENGINE_API_TOKEN_FILE");

  if (!dryRun && !hostNetworkingEnabled) {
    throw new Error("Set KINTUNNEL_ENABLE_HOST_NETWORKING=true before running with KINTUNNEL_DRY_RUN=false.");
  }
  if (!apiToken) {
    throw new Error("KINTUNNEL_ENGINE_API_TOKEN or KINTUNNEL_ENGINE_API_TOKEN_FILE is required.");
  }
  assertStrongEngineApiToken(apiToken, env);

  return {
    env,
    port: overrides.port ?? intEnv("KINTUNNEL_ENGINE_PORT", 9090),
    dataDir,
    statePath: overrides.statePath ?? path.join(dataDir, "state.json"),
    dryRun,
    apiToken,
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

export function assertStrongEngineApiToken(apiToken: string, env: string): void {
  if (!isProductionEnv(env)) return;

  const lowerToken = apiToken.toLowerCase();
  const hasPlaceholderPart = PLACEHOLDER_API_TOKEN_PARTS.some((part) => lowerToken.includes(part));
  const hasWhitespace = /\s/.test(apiToken);
  const uniqueCharacters = new Set(apiToken).size;

  if (
    apiToken.length < MIN_PRODUCTION_API_TOKEN_LENGTH ||
    hasWhitespace ||
    uniqueCharacters < 8 ||
    hasPlaceholderPart
  ) {
    throw new Error(
      "KINTUNNEL_ENGINE_API_TOKEN must be a generated secret with at least 32 non-whitespace characters in production."
    );
  }
}

function isProductionEnv(env: string): boolean {
  return ["prod", "production"].includes(env.toLowerCase());
}

function readSecret(envName: string, fileEnvName: string): string | undefined {
  const direct = process.env[envName]?.trim();
  if (direct) return direct;
  const file = process.env[fileEnvName];
  if (!file) return undefined;
  return fs.readFileSync(file, "utf8").trim();
}
