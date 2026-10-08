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
- `risk` — risk contract only (no thresholds in Phase 1A).
- `strategy` — LONG VOL and Best Opportunities type boundaries only.
- `paper`, `journal` — paper-trade and journal contracts only.

## Markets

NIFTY, BANKNIFTY, SMALLCAP, GOLD, SILVER, CRUDEOIL. All are `NOT_CONFIGURED`. SMALLCAP additionally requires explicit resolution against a real, broker-supported instrument; no other index is ever substituted.

## Phase 1A scope

Foundation, contracts, guards, shell. **Phase 1B is intentionally not implemented** (paper-trade behaviour, journal implementation, risk engine behaviour).

## Android

Web and Android will both consume the same backend API. Broker secrets never reach either client.
