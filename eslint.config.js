import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Architecture boundaries, enforced at lint time:
//   web -> @nsest/core/contracts only
//   api -> core + adapters
//   adapters -> core
//   core -> nothing
const FORBIDDEN_IN_CORE = ["window", "document", "fetch", "XMLHttpRequest", "WebSocket", "localStorage", "sessionStorage", "indexedDB", "process"];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // core: pure. No other package, no Node built-ins, no DOM/network/storage globals.
  {
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@nsest/*", "node:*", "express", "react", "react-*", "axios"], message: "core must not depend on anything." }] },
      ],
      "no-restricted-globals": ["error", ...FORBIDDEN_IN_CORE],
    },
  },

  // adapters: may import @nsest/core only.
  {
    files: ["packages/adapters/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@nsest/api", "@nsest/web", "@nsest/adapters", "express", "react", "react-*"], message: "adapters may import @nsest/core only." }] },
      ],
      "no-restricted-globals": ["error", "window", "document", "localStorage", "sessionStorage", "indexedDB"],
    },
  },

  // api: core + adapters. No DOM or browser storage.
  {
    files: ["apps/api/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["@nsest/web", "react", "react-*"], message: "api must not import web code." }] }],
      "no-restricted-globals": ["error", "window", "document", "localStorage", "sessionStorage", "indexedDB"],
    },
  },

  // web: contracts only; the only allowed @nsest import is @nsest/core/contracts.
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { regex: "^@nsest/(?!core/contracts$)", message: "web may import only @nsest/core/contracts." },
            { group: ["**/packages/**", "**/apps/api/**"], message: "web must not import package or api source by path." },
          ],
        },
      ],
      "no-restricted-globals": ["error", "localStorage", "sessionStorage", "indexedDB"],
    },
  },
);
