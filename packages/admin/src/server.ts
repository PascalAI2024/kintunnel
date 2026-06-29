import { createApp } from "./app";
import { loadConfig } from "./config";
import { createLogger, type LogLevel } from "./logger";

const VALID_LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error", "silent"];

function resolveLogLevel(): LogLevel {
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

const config = loadConfig();
const logger = createLogger({
  service: "kintunnel-admin",
  level: resolveLogLevel()
});
const app = createApp({ config });

app.listen(config.port, config.bind, () => {
  logger.info("listening", {
    bind: config.bind,
    port: config.port
  });
});

export { logger };