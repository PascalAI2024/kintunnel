import fs from "node:fs";

export interface AdminConfig {
  bind: string;
  port: number;
  engineUrl: string;
  adminToken: string;
  env: string;
}

function readTokenFromFile(path: string): string {
  return fs.readFileSync(path, "utf8").trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const token = env.KINTUNNEL_ADMIN_TOKEN
    ?? (env.KINTUNNEL_ADMIN_TOKEN_FILE ? readTokenFromFile(env.KINTUNNEL_ADMIN_TOKEN_FILE) : undefined);

  if (!token) {
    throw new Error("KINTUNNEL_ADMIN_TOKEN or KINTUNNEL_ADMIN_TOKEN_FILE is required.");
  }

  return {
    bind: env.KINTUNNEL_ADMIN_BIND ?? "0.0.0.0",
    port: Number.parseInt(env.KINTUNNEL_ADMIN_PORT ?? "8080", 10),
    engineUrl: env.KINTUNNEL_ENGINE_URL ?? "http://engine:9090",
    adminToken: token,
    env: env.KINTUNNEL_ENV ?? "production"
  };
}
