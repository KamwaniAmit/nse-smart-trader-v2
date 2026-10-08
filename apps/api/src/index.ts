import { loadServerConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadServerConfig();
const app = createApp(config);

// Bind to loopback only: Phase 1A has no reason to be reachable from other machines.
app.listen(config.apiPort, "127.0.0.1", () => {
  console.log(`NSE Smart Trader V2 API (phase 1A) listening on http://127.0.0.1:${config.apiPort}`);
});
