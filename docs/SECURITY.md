# Security

## Rules

1. No API key, secret, access or refresh token, PIN, TOTP or password in the repository, in frontend code, in any `VITE_`-prefixed variable, in browser storage, in tests, fixtures or docs.
2. The browser never receives a broker secret. Broker authentication will be handled server-side only, after FYERS account verification and explicit authorization.
3. Only `.env.example` is committed. It holds names and non-secret defaults. Real `.env` files are git-ignored.
4. `LIVE_ORDERS_ENABLED` must be `false`. The server refuses to start otherwise, and the only order provider (`DisabledOrderProvider`) rejects every call with `LIVE_ORDERS_DISABLED`.
5. The web app makes network requests only to this project's own `/api` endpoints. No other host appears anywhere in production source.
6. No localStorage, sessionStorage or IndexedDB is used. V2 never reads the legacy `niftyAiTrader.*` browser storage.
7. The API binds to the loopback interface and accepts cross-origin requests (GET, POST and the preflight) only from the local Vite dev origin. Any other origin receives no CORS permission.
8. **Phase 1B has no authentication.** It is a single-user, local tool. The API must never be exposed beyond the loopback interface.
9. Paper-trading routes accept only `application/json`. Other content types are not parsed and are refused, and bodies over 256 KB are rejected.
10. The paper-trade journal is local runtime data in `data/paper-journal.json`. It is git-ignored and is never committed. It holds paper-trade records only: no credentials.
11. **The file journal is not guaranteed durable storage.** It is for controlled development and paper-trading use and must not be relied on on serverless or ephemeral hosting, where the filesystem can be discarded. The JSON export (`GET /api/paper/export`) exists for backups.
12. There is no order, broker, login or authentication route. A guard test checks the exact list of routes.

## Planned multi-user model (not built in Phase 1A)

App-level broker identifiers live as server-side secrets. Each user's broker token is obtained through the broker's OAuth flow, stored server-side keyed to that user, and never sent to Web or Android. Clients hold only an application session. The developer's own broker credentials are never part of the application.

## Enforcement

`tests/architecture/security.test.ts` scans the repository for broker names outside the allowed zones, non-local URLs, storage APIs, credential-like strings, secret-like `VITE_` variables, stray `.env` files, and strategy math.
