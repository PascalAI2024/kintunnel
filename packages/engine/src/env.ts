import path from "node:path";
import fs from "node:fs";
import type { LogLevel } from "./logger.js";
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

function intEnvInRange(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  if (value < min || value > max) {
    throw new Error(`${name} must be an integer in the range [${min}, ${max}] (got ${value})`);
  }
  return value;
}

const EGRESS_IFACE_REGEX = /^[a-zA-Z0-9_.-]{1,16}$/;

function egressIfaceEnv(): string | undefined {
  const raw = process.env.KINTUNNEL_WG_EGRESS_INTERFACE;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!EGRESS_IFACE_REGEX.test(trimmed)) {
    throw new Error(
      `KINTUNNEL_WG_EGRESS_INTERFACE must match ${EGRESS_IFACE_REGEX.source} (linux IFNAMSIZ limit); got "${raw}"`
    );
  }
  return trimmed;
}

function absolutePathEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  const value = raw && raw.trim().length > 0 ? raw.trim() : fallback;
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path; got "${value}"`);
  }
  return value;
}

/**
 * Best-effort check that two paths live on the same filesystem, so a
 * cross-fs `rename(2)` doesn't lose the atomicity guarantee for the
 * restore safety snapshot. Logs a warning when they differ but does
 * NOT fail boot — operators may legitimately split volumes.
 */
function warnIfDifferentFilesystem(a: string, b: string): void {
  try {
    const aStat = fs.statfsSync(a);
    const bStat = fs.statfsSync(b);
    if (aStat.type !== bStat.type) {
      // eslint-disable-next-line no-console
      console.warn(
        `[kintunnel] WARNING: KINTUNNEL_BACKUP_DIR (${b}) is on a different filesystem than KINTUNNEL_DATA_DIR (${a}); restore's atomic rename may not be preserved.`
      );
    }
  } catch {
    // best-effort: don't fail boot if statfs fails
  }
}

function listEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const VALID_LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error", "silent"];

function logLevelEnv(overrides: Partial<EngineConfig>): LogLevel {
  const fromOverride = (overrides as { logLevel?: LogLevel }).logLevel;
  if (fromOverride) {
    if (!VALID_LOG_LEVELS.includes(fromOverride)) {
      throw new Error(
        `KINTUNNEL_LOG_LEVEL must be one of ${VALID_LOG_LEVELS.join(", ")}; got "${fromOverride}"`
      );
    }
    return fromOverride;
  }
  const raw = process.env.KINTUNNEL_LOG_LEVEL;
  if (!raw) return "info";
  const normalized = raw.toLowerCase() as LogLevel;
  if (!VALID_LOG_LEVELS.includes(normalized)) {
    throw new Error(
      `KINTUNNEL_LOG_LEVEL must be one of ${VALID_LOG_LEVELS.join(", ")}; got "${raw}"`
    );
  }
  return normalized;
}

/**
 * The resolved engine config carries extra fields that are not yet in the
 * shared `EngineConfig` type. The intersection keeps backwards compatibility
 * with existing call sites typed as `EngineConfig` while surfacing the
 * logger level and audit-store settings to callers like `index.ts` and
 * `app.ts`.
 */
export type ResolvedEngineConfig = EngineConfig & {
  logLevel: LogLevel;
  auditLogDir: string;
  auditLogMaxBytes: number;
  auditLogRetentionCount: number;
  // NEW (P3.4) — expiry automation knobs. Additive; EngineConfig consumers
  // that pre-date P3.4 still see the optional audit-store fields.
  expiryAutoRevoke: boolean;
  expiryWarnDays: number;
};

export function loadConfig(overrides: Partial<EngineConfig> = {}): ResolvedEngineConfig {
  const auditOverrides = overrides as Partial<EngineConfig> & {
    auditLogDir?: string;
    auditLogMaxBytes?: number;
    auditLogRetentionCount?: number;
  };
  const env = overrides.env ?? process.env.KINTUNNEL_ENV ?? "production";
  // NEW (P3.4) — read the expiry automation knobs BEFORE we resolve the rest
  // so the override chain mirrors the other env-derived fields.
  const expiryAutoRevoke = boolEnv(process.env.KINTUNNEL_EXPIRY_AUTO_REVOKE, false);
  const expiryWarnDays = intEnvInRange("KINTUNNEL_EXPIRY_WARN_DAYS", 7, 0, 365);
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

  // NEW (P1.2 / P1.3): resolve and validate the new env vars.
  // `overrides.* ?? env(...)` so unit tests can pin a value without touching process.env.
  const backupDir = overrides.backupDir ?? absolutePathEnv("KINTUNNEL_BACKUP_DIR", "/backups");
  const natApply = overrides.natApply ?? boolEnv(process.env.KINTUNNEL_NAT_APPLY, false);
  // Warn (don't fail) if backup dir crosses filesystem boundary from data dir.
  warnIfDifferentFilesystem(dataDir, backupDir);

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
    forwardingRequired: overrides.forwardingRequired ?? boolEnv(process.env.KINTUNNEL_FORWARDING_REQUIRED, true),
    natApply,
    backupDir,
    backupRetentionCount:
      overrides.backupRetentionCount ?? intEnvInRange("KINTUNNEL_BACKUP_RETENTION_COUNT", 10, 1, 1000),
    backupLockTimeoutMs:
      overrides.backupLockTimeoutMs ?? intEnvInRange("KINTUNNEL_BACKUP_LOCK_TIMEOUT_MS", 30000, 1000, 300000),
    applyBootstrapTimeoutMs:
      overrides.applyBootstrapTimeoutMs ?? intEnvInRange("KINTUNNEL_APPLY_BOOTSTRAP_TIMEOUT_MS", 15000, 1000, 120000),
    wgEgressInterface: overrides.wgEgressInterface ?? egressIfaceEnv(),
    logLevel: logLevelEnv(overrides),
    auditLogDir:
      auditOverrides.auditLogDir ?? absolutePathEnv("KINTUNNEL_AUDIT_LOG_DIR", path.join(dataDir, "audit")),
    auditLogMaxBytes:
      auditOverrides.auditLogMaxBytes ??
      intEnvInRange("KINTUNNEL_AUDIT_LOG_ROTATION_BYTES", 10485760, 1024, 1073741824),
    auditLogRetentionCount:
      auditOverrides.auditLogRetentionCount ??
      intEnvInRange("KINTUNNEL_AUDIT_LOG_RETENTION_COUNT", 5, 1, 100),
    expiryAutoRevoke,
    expiryWarnDays
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
