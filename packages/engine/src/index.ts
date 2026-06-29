import { createApp } from "./app.js";
import { loadConfig } from "./env.js";
import { createLogger } from "./logger.js";

const config = loadConfig();
const logger = createLogger({
  service: "kintunnel-engine",
  level: config.logLevel
});
const app = createApp(config);

app.listen(config.port, () => {
  logger.info("listening", {
    port: config.port,
    dry_run: config.dryRun,
    data_dir: config.dataDir
  });
});

export { logger };