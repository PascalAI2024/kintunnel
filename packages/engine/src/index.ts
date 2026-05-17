import { createApp } from "./app.js";
import { loadConfig } from "./env.js";

const config = loadConfig();
const app = createApp(config);

app.listen(config.port, () => {
  console.log(
    JSON.stringify({
      service: "kintunnel-engine",
      event: "listening",
      port: config.port,
      dry_run: config.dryRun,
      data_dir: config.dataDir
    })
  );
});
