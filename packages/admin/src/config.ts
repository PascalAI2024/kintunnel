import fs from "node:fs";

export interface AdminConfig {
  bind: string;
  port: number;
  engineUrl: string;
  engineApiToken: string;
  engineTimeoutMs: number;
  adminToken: string;
  env: string;
}

function readTokenFromFile(path: string): string {
  return fs.readFileSync(path, "utf8").trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const appEnv = env.KINTUNNEL_ENV ?? "production";
  const token = env.KINTUNNEL_ADMIN_TOKEN
    ?? (env.KINTUNNEL_ADMIN_TOKEN_FILE ? readTokenFromFile(env.KINTUNNEL_ADMIN_TOKEN_FILE) : undefined);
  const engineApiToken = env.KINTUNNEL_ENGINE_API_TOKEN
    ?? (env.KINTUNNEL_ENGINE_API_TOKEN_FILE ? readTokenFromFile(env.KINTUNNEL_ENGINE_API_TOKEN_FILE) : undefined);

  if (!token) {
    throw new Error("KINTUNNEL_ADMIN_TOKEN or KINTUNNEL_ADMIN_TOKEN_FILE is required.");
  }
  if (!engineApiToken) {
    throw new Error("KINTUNNEL_ENGINE_API_TOKEN or KINTUNNEL_ENGINE_API_TOKEN_FILE is required.");
  }
  validateProductionToken("KINTUNNEL_ADMIN_TOKEN", token, appEnv);
  validateProductionToken("KINTUNNEL_ENGINE_API_TOKEN", engineApiToken, appEnv);

  return {
    bind: env.KINTUNNEL_ADMIN_BIND ?? "0.0.0.0",
    port: Number.parseInt(env.KINTUNNEL_ADMIN_PORT ?? "8080", 10),
    engineUrl: env.KINTUNNEL_ENGINE_URL ?? "http://engine:9090",
    engineApiToken,
    engineTimeoutMs: Number.parseInt(env.KINTUNNEL_ENGINE_TIMEOUT_MS ?? "5000", 10),
    adminToken: token,
    env: appEnv
  };
}

function validateProductionToken(name: string, value: string, env: string): void {
  if (env !== "production") return;
  const weakValues = new Set(["change-me", "change-me-local-only", "password", "admin", "test-token", "engine-token"]);
  if (value.length < 24 || weakValues.has(value)) {
    throw new Error(`${name} must be at least 24 characters and not a placeholder in production.`);
  }
}
