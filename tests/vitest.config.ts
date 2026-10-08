import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "architecture", include: ["architecture/**/*.test.ts"], environment: "node" },
});
