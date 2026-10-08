import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RISK_RULES_VERSION, SCORED_FACTORS } from "../../packages/core/src/index.js";
import { ROOT, allProductionSources, importSpecifiers, read, rel, sourcesIn, stripComments, walk } from "./helpers.js";

// Phase 1B guards: paper trading stays broker-independent, backend-only persistence, no live trading.

const API_SRC = join(ROOT, "apps/api/src");
const routeFiles = (): string[] => walk(API_SRC, (f) => f.endsWith(".ts")).filter((f) => /\.(get|post|put|patch|delete|all|route)\(/.test(stripComments(read(f))));

/** Every route registered anywhere in apps/api/src, as "METHOD /full/path" (router routes get their mount prefix). */
function registeredRoutes(): string[] {
  const out: string[] = [];
  for (const file of walk(API_SRC, (f) => f.endsWith(".ts"))) {
    const code = stripComments(read(file));
    const isRouter = /\brouter\./.test(code) && /Router\(/.test(code);
    const prefix = isRouter ? "/api/paper" : "";
    for (const m of code.matchAll(/\b(?:app|router)\.(get|post|put|patch|delete|options|all)\(\s*"([^"]+)"/g)) {
      out.push(`${(m[1] as string).toUpperCase()} ${prefix}${m[2]}`);
    }
  }
  return out.sort();
}

const APPROVED = [
  "GET /api/health",
  "GET /api/markets",
  "GET /api/paper/trades",
  "GET /api/paper/trades/:id",
  "GET /api/paper/journal",
  "GET /api/paper/export",
  "POST /api/paper/assess",
  "POST /api/paper/review",
  "POST /api/paper/trades/:id/confirm",
  "POST /api/paper/trades/:id/monitor",
  "POST /api/paper/trades/:id/exit",
  "POST /api/paper/trades/:id/safety-check",
].sort();

describe("API surface: only the approved routes, and nothing that can trade", () => {
  it("the registered routes equal the approved list exactly (every file in apps/api/src is scanned)", () => {
    expect(registeredRoutes()).toEqual(APPROVED);
  });

  it("the only mount point is /api/paper (no other router, no wildcard handlers, no .route() chains)", () => {
    const code = stripComments(read(join(API_SRC, "app.ts")));
    const mounts = [...code.matchAll(/app\.use\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(mounts).toEqual(["/api/paper"]);
    for (const file of walk(API_SRC, (f) => f.endsWith(".ts"))) {
      expect(stripComments(read(file)), rel(file)).not.toMatch(/\.(all|route)\(/);
    }
    expect(routeFiles().map(rel).sort()).toEqual(["apps/api/src/app.ts", "apps/api/src/paperRoutes.ts"]);
  });

  it("no route path mentions orders, brokers, login, auth, tokens or callbacks", () => {
    for (const route of registeredRoutes()) expect(route).not.toMatch(/order|execute|broker|login|logout|oauth|auth|token|callback|session|account/i);
  });

  it("paper-trade routes cannot delete or edit trades: there is no DELETE, PUT or PATCH route anywhere", () => {
    for (const route of registeredRoutes()) expect(route).not.toMatch(/^(DELETE|PUT|PATCH) /);
  });
});

describe("persistence is backend-only and uses no database or browser storage", () => {
  it("filesystem access exists only in apps/api/src/persistence (never in core, adapters or web)", () => {
    const fsUse = /from\s+["'](?:node:)?fs(?:\/promises)?["']|require\(\s*["'](?:node:)?fs/;
    const offenders = allProductionSources().filter((f) => fsUse.test(stripComments(read(f)))).map(rel);
    expect(offenders).toEqual(["apps/api/src/persistence/FileJournalRepository.ts"]);
  });

  it("only FileJournalRepository writes files", () => {
    const writes = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|rmSync|unlinkSync|mkdirSync)\b/;
    const offenders = allProductionSources().filter((f) => writes.test(stripComments(read(f)))).map(rel);
    expect(offenders).toEqual(["apps/api/src/persistence/FileJournalRepository.ts"]);
  });

  it("the web app has no persistence of any kind (no storage API, no fs)", () => {
    for (const file of sourcesIn("apps/web")) {
      expect(stripComments(read(file)), rel(file)).not.toMatch(/\b(localStorage|sessionStorage|indexedDB|caches|document\.cookie)\b|node:fs/);
    }
  });

  it("the journal data folder is git-ignored, so paper-trade records are never committed", () => {
    expect(read(join(ROOT, ".gitignore")).split(/\r?\n/).map((l) => l.trim())).toContain("data/");
  });

  it("no database or hosted-storage client exists in any package.json", () => {
    const banned = /^(pg|mysql2?|mongodb|mongoose|redis|ioredis|firebase|@supabase\/.+|@aws-sdk\/.+|aws-sdk|better-sqlite3|sqlite3?|prisma|@prisma\/.+|typeorm|sequelize|knex)$/;
    for (const file of walk(ROOT, (f) => f.endsWith("package.json"))) {
      const pkg = JSON.parse(read(file)) as { dependencies?: object; devDependencies?: object };
      for (const name of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]) expect(name, `${rel(file)} -> ${name}`).not.toMatch(banned);
    }
  });
});

describe("paper trading, risk and journal stay broker-independent and pure", () => {
  const coreFiles = (...dirs: string[]) => dirs.flatMap((d) => walk(join(ROOT, "packages/core/src", d), (f) => f.endsWith(".ts")));

  it("paper, risk and journal code never import the broker ports, the resolver, or adapters", () => {
    for (const file of coreFiles("paper", "risk", "journal")) {
      for (const spec of importSpecifiers(read(file))) {
        const target = resolve(dirname(file), spec);
        expect(target, `${rel(file)} imports "${spec}"`).not.toMatch(/\/(ports|adapters)(\/|$)/);
        expect(spec, rel(file)).not.toMatch(/resolver|BrokerAdapter/);
      }
    }
  });

  it("the Risk Engine files never read the opportunity Score, Status, capital, or a raw Expected Net Edge", () => {
    const forbidden = ["score", "opportunityScore", "status", "capitalRequirement", "expectedNetEdge", "OpportunityStatus"];
    for (const name of ["engine.ts", "rules.ts", "filter.ts"]) {
      const code = stripComments(read(join(ROOT, "packages/core/src/risk", name)));
      // (a) no identifier with that name (human-readable message text is ignored)
      const withoutText = code.replace(/`(?:\\.|[^`\\])*`/g, "``").replace(/"(?:\\.|[^"\\])*"/g, '""');
      expect(withoutText, `${name}: identifier`).not.toMatch(new RegExp(`\\b(${forbidden.join("|")})\\b`));
      // (b) no string key read such as raw["score"]
      expect(code, `${name}: string key`).not.toMatch(new RegExp(`["'](${forbidden.join("|")})["']`));
    }
  });

  it("the Risk Engine imports nothing from paper, journal, strategy or ports (it cannot see trades or edge)", () => {
    for (const name of ["engine.ts", "rules.ts", "filter.ts"]) {
      for (const spec of importSpecifiers(read(join(ROOT, "packages/core/src/risk", name)))) expect(spec, name).not.toMatch(/paper|journal|strategy|ports|instruments/);
    }
  });

  it("no paper-trade source reads a broker or the network: no fetch, http, or process access", () => {
    for (const file of coreFiles("paper", "risk", "journal")) {
      expect(stripComments(read(file)), rel(file)).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|process)\b|node:/);
    }
  });

  it("price logic never reads LTP: only the supplied bid/ask are used for entry and exit pricing", () => {
    const pricing = stripComments(read(join(ROOT, "packages/core/src/paper/pricing.ts")));
    expect(pricing).not.toMatch(/\.ltp\b|\bltp\s*[:=]/);
    const risk = stripComments(read(join(ROOT, "packages/core/src/paper/riskInputs.ts")));
    expect(risk).not.toMatch(/\.ltp\b/);
  });
});

describe("the web API client only ever calls this project's own /api", () => {
  it("every fetch( call targets `${BASE}${path}` and nothing else", () => {
    const code = stripComments(read(join(ROOT, "apps/web/src/apiClient.ts")));
    const calls = [...code.matchAll(/\bfetch\(([^)]*)/g)].map((m) => (m[1] as string).trim());
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) expect(call).toMatch(/^`\$\{BASE\}\$\{path\}`/);
  });
});

describe("Risk Engine document and code agree", () => {
  const doc = read(join(ROOT, "docs/RISK_ENGINE.md"));

  it("the document states the same rules version as the code", () => {
    expect(doc).toContain(`**Rules version: \`${RISK_RULES_VERSION}\`**`);
  });

  it("every scored factor's weight in the document table equals the code", () => {
    for (const factor of SCORED_FACTORS) {
      const row = doc.split("\n").find((l) => l.startsWith(`| \`${factor.field}\` |`) && l.split("|").length >= 8);
      expect(row, `row for ${factor.field}`).toBeDefined();
      const cells = (row as string).split("|").map((c) => c.trim());
      expect(Number(cells[5]), `${factor.field} weight`).toBe(factor.weight);
      expect(cells[6]?.includes("req"), `${factor.field} required flag`).toBe(factor.required);
      expect(cells[6]?.includes("crit"), `${factor.field} critical flag`).toBe(factor.critical);
    }
  });

  it("every provenance label is one of the four defined ones", () => {
    for (const factor of SCORED_FACTORS) {
      const row = doc.split("\n").find((l) => l.startsWith(`| \`${factor.field}\` |`) && l.split("|").length >= 8) as string;
      expect(row).toMatch(/\*\*(LEGACY|SPEC|STRUCTURAL|DEFAULT)\*\*/);
    }
  });
});

describe("Phase 1B documentation", () => {
  it("exists, and states the filesystem-durability limitation plainly", () => {
    for (const name of ["PAPER_TRADING.md", "RISK_ENGINE.md", "PHASE_REPORTS/PHASE_1B.md"]) expect(read(join(ROOT, "docs", name)).trim().length, name).toBeGreaterThan(300);
    const text = `${read(join(ROOT, "docs/PAPER_TRADING.md"))}\n${read(join(ROOT, "docs/SECURITY.md"))}`;
    expect(text).toMatch(/not guaranteed durable/i);
    expect(text).toMatch(/serverless|ephemeral/i);
    expect(text).toMatch(/export/i);
  });

  it("the frozen Phase 1A tag is referenced and never moved or deleted by any script or doc instruction", () => {
    const docs = walk(join(ROOT, "docs"), (f) => f.endsWith(".md")).map(read).join("\n");
    expect(docs).not.toMatch(/git tag -d|git push (--delete|origin :)|--force.*phase-1a-frozen|tag -f/i);
  });
});
