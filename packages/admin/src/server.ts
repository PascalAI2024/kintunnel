import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = createApp({ config });

app.listen(config.port, config.bind, () => {
  console.log(`KinTunnel admin listening on ${config.bind}:${config.port}`);
});
