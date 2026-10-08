import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const coreSrc = (p: string) => fileURLToPath(new URL(`../core/src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@nsest\/core\/contracts$/, replacement: coreSrc("contracts/index.ts") },
      { find: /^@nsest\/core$/, replacement: coreSrc("index.ts") },
    ],
  },
  test: { name: "adapters", include: ["tests/**/*.test.ts"], environment: "node" },
});
