import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, importSpecifiers, read, rel, sourcesIn, srcDir, stripComments } from "./helpers.js";

const isRelative = (spec: string): boolean => spec.startsWith(".");

describe("package dependency direction: web -> core/contracts, api -> core+adapters, adapters -> core, core -> nothing", () => {
  it("core has zero runtime dependencies", () => {
    const pkg = JSON.parse(read(join(ROOT, "packages/core/package.json"))) as Record<string, unknown>;
    for (const key of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      expect(Object.keys((pkg[key] as object | undefined) ?? {}), key).toEqual([]);
    }
  });

  it("core imports only its own files (relative imports) - no packages, no Node built-ins", () => {
    for (const file of sourcesIn("packages/core")) {
      for (const spec of importSpecifiers(read(file))) {
        expect(isRelative(spec), `${rel(file)} imports "${spec}"`).toBe(true);
      }
    }
  });

  it("core has no DOM, network or storage access", () => {
    const forbidden = /\b(window|document|navigator|fetch|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|process)\b/;
    for (const file of sourcesIn("packages/core")) {
      expect(stripComments(read(file)), rel(file)).not.toMatch(forbidden);
    }
  });

  it("core does not import adapters (or api, or web)", () => {
    for (const file of sourcesIn("packages/core")) {
      for (const spec of importSpecifiers(read(file))) {
        expect(spec, rel(file)).not.toMatch(/@nsest\/|adapters|apps\//);
      }
    }
  });

  it("adapters import only core (and their own files)", () => {
    for (const file of sourcesIn("packages/adapters")) {
      for (const spec of importSpecifiers(read(file))) {
        expect(isRelative(spec) || spec === "@nsest/core", `${rel(file)} imports "${spec}"`).toBe(true);
      }
    }
  });

  it("api imports only core, adapters, express and Node built-ins", () => {
    for (const file of sourcesIn("apps/api")) {
      for (const spec of importSpecifiers(read(file))) {
        const ok = isRelative(spec) || spec.startsWith("node:") || spec === "express" || spec === "@nsest/core" || spec === "@nsest/adapters";
        expect(ok, `${rel(file)} imports "${spec}"`).toBe(true);
      }
    }
  });

  it("web imports only @nsest/core/contracts from the workspace, plus React libraries", () => {
    const allowedExternal = new Set(["react", "react-dom", "react-dom/client", "react-router-dom", "@nsest/core/contracts"]);
    const webSrc = srcDir("apps/web");
    for (const file of sourcesIn("apps/web")) {
      for (const spec of importSpecifiers(read(file))) {
        if (isRelative(spec)) {
          const target = resolve(dirname(file), spec);
          expect(target.startsWith(webSrc), `${rel(file)} reaches outside web/src via "${spec}"`).toBe(true);
        } else {
          expect(allowedExternal.has(spec), `${rel(file)} imports "${spec}"`).toBe(true);
        }
      }
    }
  });

  it("the web app never imports from @nsest/core directly (contracts only)", () => {
    for (const file of sourcesIn("apps/web")) {
      expect(importSpecifiers(read(file)).filter((s) => s === "@nsest/core"), rel(file)).toEqual([]);
    }
  });
});
