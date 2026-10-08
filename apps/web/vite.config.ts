import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const coreContracts = fileURLToPath(new URL("../../packages/core/src/contracts/index.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: [{ find: /^@nsest\/core\/contracts$/, replacement: coreContracts }] },
  server: { port: 5173, host: "127.0.0.1" },
});
