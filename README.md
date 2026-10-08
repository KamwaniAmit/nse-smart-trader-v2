# NSE Smart Trader V2

Broker-agnostic options research and paper-trading platform.
**Phase 1B: Risk Engine, paper trading and journal.** There is still no broker connection, no live market data and no order placement. Paper trading runs on prices you enter yourself.

> The legacy Upstox/Vercel application is frozen at `FROZEN-UPSTOX-434-PASS`. V2 is a clean rebuild. No legacy code or legacy browser storage is used.

## What exists

**Phase 1A (frozen at tag `phase-1a-frozen`):** the monorepo, broker-independent contracts, market definitions (all `NOT_CONFIGURED`), a disabled broker adapter, the Express/React shell and the architecture guards.

**Phase 1B:**

- A deterministic **Risk Engine** (LOW / MEDIUM / HIGH, or unknown) with a documented rule table: `docs/RISK_ENGINE.md`.
- **Paper trading** for LONG VOL and Best Opportunities: candidate → review → *explicit confirmation* → open → monitor → exit, with expiry and safety closure. See `docs/PAPER_TRADING.md`.
- An immutable **entry snapshot**, entry risk kept separately from current risk, and P&L from executable bids only (`DATA_INSUFFICIENT` when a price is missing).
- A **journal** behind a `JournalRepository` interface, with a file-backed implementation (`data/paper-journal.json`, git-ignored) and a JSON export for backups.
- Ten paper-trading API routes under `/api/paper` (plus the two Phase 1A routes) and the web pages to use them.

Paper trading is broker-independent: there are no live orders, no broker routes and no credentials.

> **Persistence warning.** The file journal is for controlled development and paper-trading use. It is not guaranteed durable storage and must not be relied on on serverless or ephemeral hosting. Use the Export button regularly.

## Commands

```bash
npm install
npm run check     # typecheck + lint + all tests
npm run test      # all tests (core, adapters, api, web, architecture)
npm run build     # builds core, adapters, api and web
npm run dev:api   # API on 127.0.0.1:8787   (run in one terminal)
npm run dev:web   # web on 127.0.0.1:5173   (run in a second terminal)
```

Requires Node.js >= 22.22.2.

## Configuration

Copy `.env.example` to `.env` for local use. **Never commit `.env`.** Only `BROKER_PROVIDER=none` and `LIVE_ORDERS_ENABLED=false` are accepted; the server refuses to start with anything else.

## Dependency rules

```
web -> core/contracts only      api -> core + adapters
adapters -> core                core -> nothing
```

Broker names may appear only in `packages/adapters/`, `docs/` and this README. See `docs/ARCHITECTURE.md` and `docs/SECURITY.md`.

## Not built yet

Broker connection or authentication, live or historical market data, a scanner, calculation of Score / Expected Move / Implied Move / Expected Net Edge (they are entered, not computed), live orders, user accounts and deployment. See `docs/DECISIONS.md` for what is decided and what is still open.
