import { defineConfig } from "vitest/config";

// One command, every project: core, adapters, api, web and the architecture guards.
export default defineConfig({
  test: {
    projects: [
      "packages/core/vitest.config.ts",
      "packages/adapters/vitest.config.ts",
      "apps/api/vitest.config.ts",
      "apps/web/vitest.config.ts",
      "tests/vitest.config.ts",
    ],
  },
});
