# Phase 1B Report: Risk Engine, Paper Trading and Journal

**Status:** implemented and verified by real command execution on top of the frozen Phase 1A tag (`phase-1a-frozen`, commit `5fda879`).
Phase 2 (FYERS), live trading and a scanner are **not** started.

## Verification (clean start: `node_modules` and build output deleted first)

| Command | Exit code | Result |
|---|---|---|
| `npm install` | 0 | 318 packages, **0 vulnerabilities**, lockfile unchanged (no dependency added) |
| `npm run check` (typecheck + lint + tests) | 0 | typecheck clean in all workspaces and `tests/`; ESLint clean; **474 / 474 tests passed**, 22 / 22 files |
| `npm run test` | 0 | 474 / 474 |
| `npm run build` | 0 | core, adapters and api compiled; web built (47 modules) |

| Project | Phase 1A tests | Phase 1B tests | New |
|---|---|---|---|
| core | 36 | 321 | 285 |
| adapters | 9 | 9 | 0 |
| api | 13 | 65 | 52 |
| web | 10 | 29 | 19 |
| architecture | 30 | 50 | 20 |
| **Total** | **98** | **474** | **376** |

Failures: 0. Many of the new core tests are table-driven (for example one test per rule-table boundary), so the count overstates the number of distinct behaviours. The tests were not padded: each case asserts a value in `RISK_ENGINE.md`.

### Additional verification

- **Frozen tests:** 97 of the 98 Phase 1A tests are unchanged, and 11 of the 12 frozen test files are byte-identical. One test was replaced (see "Conflicts").
- **Real server:** the compiled API was run with its default file location. Verified over HTTP: assess stores nothing; review does not open; confirmation is required; monitor, refused exit (LTP only, trade stays open), valid exit; the journal file appears only at the first write; a **fresh server process re-read the same journal**; the JSON export downloads; order, broker and auth routes return 404.
- **Tests that must fail, do fail:** 21 deliberate bugs were planted one at a time (an order route, a DELETE route, `node:fs` in core, a second file writing to disk, the Risk Engine reading the Score, a changed risk weight, an LTP fallback, a zero bid accepted, loosened instrument matching, confirmation not enforced, a candidate opening directly, snapshot immutability removed, the `constructor`-id guard removed, expiry-day and holding-limit changes, the risk filter admitting unknown risk, an invented zero P&L, an external fetch, `data/` un-ignored, and others). **All 21 were caught.** Every file was restored.

## Files changed

- **Modified (18):** `.gitignore`, `README.md`, `apps/api/src/app.ts`, `apps/web/src/apiClient.ts`, three web pages (`LongVol`, `BestOpportunities`, `PaperTrading`), `styles.css`, four docs (`ARCHITECTURE`, `DECISIONS`, `LEGACY_BOUNDARY`, `SECURITY`), four barrel files (`contracts/index.ts`, `journal/index.ts`, `paper/index.ts`, `risk/index.ts`; exports appended only), `tests/architecture/helpers.ts`, `tests/architecture/security.test.ts`.
- **Added (42):** core (risk engine, paper domain, journal, Phase 1B contracts, and their tests), api (file repository, routes, service, tests), web (components, tests), docs (`RISK_ENGINE.md`, `PAPER_TRADING.md`, this report), and `tests/architecture/phase1b.test.ts`.
- **Deleted:** none. `package.json` files, `package-lock.json` and `.env.example` are unchanged.

## API endpoints added (10, all under `/api/paper`)

`GET /trades`, `GET /trades/:id`, `GET /journal`, `GET /export`, `POST /assess`, `POST /review`, `POST /trades/:id/confirm`, `POST /trades/:id/monitor`, `POST /trades/:id/exit`, `POST /trades/:id/safety-check`.
The Phase 1A routes (`/api/health`, `/api/markets`) are unchanged. There is no order, broker, login, authentication, delete or edit route (a guard test checks the exact list).

## Persistence implementation

`JournalRepository` (interface, core) → `InMemoryJournalRepository` (core) and `FileJournalRepository` (**apps/api only**). Both run on one shared rules engine (`JournalState`).
The file store writes `data/paper-journal.json` (git-ignored) atomically (temporary file, then rename), serializes operations, and **fails closed** on corrupt or unsupported data (never overwrites it). JSON export is provided.
**It is for controlled development and paper-trading use. It is not guaranteed durable storage and must not be relied on on serverless or ephemeral hosting.**

## Risk rules (full table in `RISK_ENGINE.md`, rules v1.0.0)

Twelve scored inputs with weights summing to 100, three required inputs (spread, days to expiry, capital utilization), five critical factors, equal-thirds level cutoffs (34 / 67), escalation rules, and `null` / `INSUFFICIENT` whenever a required input is unavailable.
Every number is labelled LEGACY, SPEC, STRUCTURAL or DEFAULT. **The DEFAULT values have no source in the specification and the whole table is uncalibrated; it awaits owner approval.**
Risk never reads the Score, the Status or a raw Expected Net Edge (only `expectedNetEdgeQuality`, as decided), and a test and a code guard enforce that.

## Lifecycle states

`CANDIDATE → PAPER_REVIEW → PAPER_OPEN → PAPER_EXITED`, plus `PAPER_EXPIRED`, `PAPER_AUTO_CLOSED` and `DATA_INSUFFICIENT` (terminal). Only an explicit `confirmed: true` opens a trade.

## Conflicts with the frozen Phase 1A, and how each was handled

1. **Lifecycle vocabulary.** The frozen `PaperTradeStatus` (`PAPER_SELECTED`, `PAPER_CLOSED`) differs from the Phase 1B names. The frozen contract and its test are unchanged; the new lifecycle is a separate type. The old paper-trade and journal contracts are now unused beside the new ones.
2. **One frozen test replaced.** "The API exposes only the two Phase 1A GET routes" was replaced by an exact approved-route guard. The old test would have kept passing while routes lived in a router file.
3. **Additive edits to frozen files** are listed above. No frozen line was removed except where a Phase 1A statement became untrue (docs, the three web pages, `app.ts` CORS and error handling).
4. **Frozen web tests** forced two details: the "Not available in Phase 1A" notice stays on the live-scanning sections, and the Best Opportunities risk filter is disabled until a candidate exists.
5. **The web app repeats the 3-line risk-filter rule**, because it may import only `@nsest/core/contracts`.
6. `/api/health` and the startup banner still say "phase 1A": a frozen test asserts that literal.

## Defects found and fixed during the build

- The first `capitalUtilization` bands (35 / 70) would have made every full-size trade HIGH and contradicted their own rationale. Corrected to 50 / 100 and recorded in `RISK_ENGINE.md`.
- An impossible date (such as month 13) made the parser **throw**; it is now rejected as invalid.
- A trade id such as `constructor` or `__proto__` matched an inherited object member; lookups are now own-property only (11 regression tests).
- A broad guard flagged the word "score" inside message text; messages now say "risk score", and the guard checks identifiers and string keys, not prose.

## Not done, by design

No broker or FYERS integration, no live or historical market data, no scanner, no calculation of Score / Expected Move / Implied Move / Expected Net Edge (they are entered by hand), no live orders, no authentication, no database, no deployment.

## Confirmations

No FYERS or Upstox API was called and none exists in the code. No credential, token or secret was added (a guard test scans the whole repository). No new dependency was added. No live-order path exists. Legacy `niftyAiTrader.*` storage and old Upstox paper trades are never read or imported. Phase 2 was not started.

## Git

The `phase-1a-frozen` tag is untouched. The Phase 1B changes are delivered as an overlay package for the project owner to review and commit as a new commit; nothing was committed or pushed from the build environment.
