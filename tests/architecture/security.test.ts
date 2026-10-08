import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, allProductionSources, isSource, read, rel, stripComments, walk } from "./helpers.js";

// Broker names are assembled from fragments so this file itself never contains them.
const BROKER_NAMES = new RegExp(["\\bfy" + "ers\\b", "\\bup" + "stox\\b", "\\bdh" + "an\\b", "\\bangel ?" + "one\\b", "\\bzero" + "dha\\b"].join("|"), "i");

function textFilesOutsideAllowedBrokerZones(): string[] {
  const allowedPrefixes = ["packages/adapters/", "docs/", "README.md", "package-lock.json"];
  return walk(ROOT, (f) => /\.(ts|tsx|js|json|html|css|webmanifest|md|example|gitignore)$/.test(f) || f.endsWith(".env.example") || f.endsWith(".gitignore"))
    .filter((f) => !allowedPrefixes.some((p) => rel(f).startsWith(p)));
}

describe("broker-agnostic core", () => {
  it("broker names appear only in packages/adapters, docs/ and README.md", () => {
    for (const file of textFilesOutsideAllowedBrokerZones()) {
      expect(read(file), rel(file)).not.toMatch(BROKER_NAMES);
    }
  });

  it("no package.json depends on a broker SDK", () => {
    for (const file of walk(ROOT, (f) => f.endsWith("package.json"))) {
      const pkg = JSON.parse(read(file)) as { dependencies?: object; devDependencies?: object };
      const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
      for (const name of names) expect(name, `${rel(file)} -> ${name}`).not.toMatch(BROKER_NAMES);
    }
  });

  it("the deferred broker adapter directory contains documentation only", () => {
    const dir = join(ROOT, "packages/adapters/src", "fy" + "ers");
    expect(readdirSync(dir)).toEqual(["README.md"]);
  });
});

describe("no external network access", () => {
  it("no non-local URL appears in any production source", () => {
    for (const file of allProductionSources()) {
      const urls = stripComments(read(file)).match(/https?:\/\/[^\s"'`)]+/g) ?? [];
      for (const url of urls) expect(url, rel(file)).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/);
    }
  });

  it("fetch is used only by the web app's own API client; no other network client exists", () => {
    for (const file of allProductionSources()) {
      const code = stripComments(read(file));
      expect(code, rel(file)).not.toMatch(/\b(axios|XMLHttpRequest|WebSocket|EventSource|node-fetch|undici)\b/);
      if (rel(file) !== "apps/web/src/apiClient.ts") expect(code, rel(file)).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("the web API client builds URLs only from its own base + /api paths", () => {
    const code = stripComments(read(join(ROOT, "apps/web/src/apiClient.ts")));
    expect(code).toMatch(/fetch\(`\$\{BASE\}\$\{path\}`\)/);
    expect(code).not.toMatch(/https?:\/\//);
  });
});

describe("no browser storage, no legacy storage", () => {
  it("no localStorage / sessionStorage / indexedDB in any production source", () => {
    for (const file of allProductionSources()) {
      expect(stripComments(read(file)), rel(file)).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\b/);
    }
  });

  it("no production source references the legacy niftyAiTrader.* storage namespace", () => {
    for (const file of allProductionSources()) {
      expect(read(file), rel(file)).not.toMatch(/niftyAiTrader/i);
    }
  });
});

describe("no secrets", () => {
  const scanned = (): string[] =>
    walk(ROOT, (f) => /\.(ts|tsx|js|json|html|css|webmanifest|md)$/.test(f) || f.endsWith(".env.example"))
      .filter((f) => !rel(f).endsWith("package-lock.json"));

  it("no credential-like values anywhere in the repo", () => {
    const patterns: Array<[string, RegExp]> = [
      ["JWT-like token", /eyJ[A-Za-z0-9_-]{10,}\./],
      ["bearer token", /Bearer\s+[A-Za-z0-9._~+/-]{12,}/],
      ["assigned secret", /(secret|token|password|passwd|api[_-]?key|totp)\s*[:=]\s*["'][^"'\s]{8,}["']/i],
    ];
    for (const file of scanned()) {
      const text = read(file);
      for (const [label, pattern] of patterns) expect(text, `${label} in ${rel(file)}`).not.toMatch(pattern);
    }
  });

  it("no secret-like VITE_ variable exists anywhere", () => {
    const secretLike = /VITE_[A-Z0-9_]*(SECRET|TOKEN|KEY|PIN|TOTP|PASSWORD)/;
    for (const file of scanned().filter((f) => !rel(f).startsWith("tests/architecture/"))) {
      expect(read(file), rel(file)).not.toMatch(secretLike);
    }
  });

  it("no real .env file exists; only .env.example", () => {
    const envFiles = readdirSync(ROOT).filter((n) => n === ".env" || n.startsWith(".env."));
    expect(envFiles).toEqual([".env.example"]);
  });

  it(".gitignore excludes env files and build output but keeps .env.example", () => {
    const lines = read(join(ROOT, ".gitignore")).split(/\r?\n/).map((l) => l.trim());
    for (const required of [".env", ".env.*", "node_modules/", "dist/", "coverage/", "!.env.example"]) {
      expect(lines, required).toContain(required);
    }
  });

  it(".env.example contains only the approved keys with the approved values", () => {
    const approved: Record<string, string> = {
      APP_ENV: "development",
      API_PORT: "8787",
      BROKER_PROVIDER: "none",
      LIVE_ORDERS_ENABLED: "false",
      VITE_API_BASE_URL: "http://localhost:8787",
    };
    const active = read(join(ROOT, ".env.example"))
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"))
      .map((l) => l.split("=") as [string, string]);
    expect(Object.fromEntries(active)).toEqual(approved);
  });

  it("the reserved broker-auth variables are commented out, never active", () => {
    const text = read(join(ROOT, ".env.example"));
    for (const name of ["SESSION_SECRET", "TOKEN_ENCRYPTION_KEY", "BROKER_APP_ID", "BROKER_APP_SECRET", "BROKER_REDIRECT_URI"]) {
      expect(text).toMatch(new RegExp(`^# ${name}=\\s*$`, "m"));
    }
  });
});

describe("no strategy math in Phase 1A", () => {
  it("no math functions or strategy calculation names in any production source", () => {
    const forbidden = /Math\.(sqrt|log|exp|pow)|\b(computeExpectedMove|computeImpliedMove|computeRV\w*|computeScore|computeEdge|calculateEdge|calculateScore|calculateRV\w*|classifyRisk|computeRisk)\b/;
    for (const file of allProductionSources()) {
      expect(stripComments(read(file)), rel(file)).not.toMatch(forbidden);
    }
  });

  it("no live order implementation exists besides the disabled provider", () => {
    const orderImpls = walk(ROOT, (f) => isSource(f) && /implements\s+OrderProvider/.test(read(f)) && !f.includes("/tests/"));
    expect(orderImpls.map(rel)).toEqual(["packages/adapters/src/none/DisabledOrderProvider.ts"]);
  });

  it("the API exposes exactly the approved routes (Phase 1A: 2 GET; Phase 1B: paper trading). See phase1b.test.ts for the full route guard", () => {
    // Phase 1B superseded the original "only two GET routes" assertion: it scanned app.ts alone, which would
    // have stayed green while routes lived in a router file. The exact approved list is checked there, across
    // every file that registers routes.
    const code = stripComments(read(join(ROOT, "apps/api/src/app.ts")));
    expect([...code.matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual(["get /api/health", "get /api/markets"]);
  });
});
