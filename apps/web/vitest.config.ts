import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const coreContracts = fileURLToPath(new URL("../../packages/core/src/contracts/index.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: [{ find: /^@nsest\/core\/contracts$/, replacement: coreContracts }] },
  test: {
    name: "web",
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["tests/setup.ts"],
  },
});
