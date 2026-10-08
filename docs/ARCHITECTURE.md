# Architecture

## Layers

```
Web UI (and later Android)
        |   HTTP, same-origin /api only
        v
apps/api   -- thin handlers, config loading, no business logic
        |
        v
packages/core      <----  packages/adapters  -->  [broker, deferred]
(contracts, domain,        (implements core's ports;
 strategy boundaries)       the only place broker names may appear)
```

## Dependency rules (enforced by ESLint and by `tests/architecture`)

| Package | May import |
|---|---|
| `packages/core` | nothing (relative imports only; zero runtime dependencies) |
| `packages/adapters` | `@nsest/core` |
| `apps/api` | `@nsest/core`, `@nsest/adapters`, `express`, Node built-ins |
| `apps/web` | `@nsest/core/contracts` (types and constants only), React libraries |

Strategy and risk code never know which broker is in use. Brokers are reached only through the ports in `packages/core/src/ports`.

## Core modules

- `contracts` — shared types and constants (market IDs, risk levels, statuses, API DTOs). The only part the web app imports.
- `market` — market definitions. Every instrument field starts `UNRESOLVED`; nothing is guessed.
- `instruments` — `BrokerRef`, `InstrumentResolver`, `NotConfiguredResolver`, `assertNoSubstitution`.
- `marketdata` — normalized quote / option leg / chain / candle types and `assessQuote`.
- `ports` — broker-facing interfaces and `BrokerAdapter`.
- `risk` — risk contract only (no thresholds in Phase 1A). Risk is a separate output from Score and from Expected Net Edge. It may take the *quality* of Expected Net Edge as one input, but it never calculates, replaces or overrides Expected Net Edge.
- `strategy` — LONG VOL and Best Opportunities type boundaries only.
- `paper` — the Phase 1A paper-trade contracts (unchanged) plus the Phase 1B domain: lifecycle table, strict request parsing, pricing and capital, risk-input building, safety rules and `createPaperTradingService`. Pure: no I/O, no broker, no clock (time and ids are injected).
- `journal` — the Phase 1A contract (unchanged) plus the Phase 1B `JournalRepository` interface, the shared rules engine `JournalState`, and `InMemoryJournalRepository`.
- `risk` — also contains the Phase 1B engine (`rules.ts`, `engine.ts`, `filter.ts`).

## Markets

NIFTY, BANKNIFTY, SMALLCAP, GOLD, SILVER, CRUDEOIL. All are `NOT_CONFIGURED`. SMALLCAP additionally requires explicit resolution against a real, broker-supported instrument; no other index is ever substituted.

## Persistence layout (Phase 1B)

```
paper-trading service (core)  ──►  JournalRepository (interface, core)
                                        ├── InMemoryJournalRepository   (core, tests)
                                        └── FileJournalRepository       (apps/api only: the only code that touches the disk)
```

`core` has no `node:` imports, so file access lives in `apps/api/src/persistence`. Both repositories run on the same rules engine (`JournalState`).
A guard test fails if any other code touches the filesystem.

## Scope

Phase 1A (frozen at `phase-1a-frozen`): foundation, contracts, guards, shell. Phase 1B: Risk Engine, paper trading, journal, and the API and web pages for them.
Still not built: broker adapters, live market data, a scanner, strategy calculations, live orders. Phase 1B did **not** add a broker, a database or any credential.

## Android

Web and Android will both consume the same backend API. Broker secrets never reach either client.
