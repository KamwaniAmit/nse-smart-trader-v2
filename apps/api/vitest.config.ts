import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@nsest\/core\/contracts$/, replacement: at("../../packages/core/src/contracts/index.ts") },
      { find: /^@nsest\/core$/, replacement: at("../../packages/core/src/index.ts") },
      { find: /^@nsest\/adapters$/, replacement: at("../../packages/adapters/src/index.ts") },
    ],
  },
  test: { name: "api", include: ["tests/**/*.test.ts"], environment: "node" },
});
