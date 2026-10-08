# NSE Smart Trader V2

Broker-agnostic options research and paper-trading platform.
**Phase 1A: architecture foundation only.** There is no market data, no strategy calculation, no broker connection and no order placement in this phase.

> The legacy Upstox/Vercel application is frozen at `FROZEN-UPSTOX-434-PASS`. V2 is a clean rebuild. No legacy code or legacy browser storage is used.

## What exists in Phase 1A

- A TypeScript npm-workspaces monorepo: `packages/core`, `packages/adapters`, `apps/api`, `apps/web`.
- Contracts (types and interfaces) for markets, instruments, normalized market data, broker ports, risk, LONG VOL, Best Opportunities, paper trading and the journal.
- A disabled broker adapter (`none`) and an empty placeholder for the deferred FYERS adapter.
- An Express API with two read-only routes: `GET /api/health` and `GET /api/markets`.
- A React/Vite shell with six pages, all clearly marked "Not available in Phase 1A" where nothing is implemented.
- Architecture and security guard tests that scan the repository.

## Commands

```bash
npm install
npm run check     # typecheck + lint + all tests
npm run test      # all tests (core, adapters, api, web, architecture)
npm run build     # builds core, adapters, api and web
npm run dev:api   # API on 127.0.0.1:8787   (run in one terminal)
npm run dev:web   # web on 127.0.0.1:5173   (run in a second terminal)
```

Requires Node 20 or newer.

## Configuration

Copy `.env.example` to `.env` for local use. **Never commit `.env`.** Only `BROKER_PROVIDER=none` and `LIVE_ORDERS_ENABLED=false` are accepted; the server refuses to start with anything else.

## Dependency rules

```
web -> core/contracts only      api -> core + adapters
adapters -> core                core -> nothing
```

Broker names may appear only in `packages/adapters/`, `docs/` and this README. See `docs/ARCHITECTURE.md` and `docs/SECURITY.md`.

## Not in this phase

Broker connection or authentication, live or historical market data, RV / Expected Move / Implied Move / Edge / Score / Risk calculations, paper-trade logic, persistence, deployment, live orders. See `docs/DECISIONS.md` for the open decisions that must be settled first.
