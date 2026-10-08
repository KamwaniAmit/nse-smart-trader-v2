# Security

## Rules

1. No API key, secret, access or refresh token, PIN, TOTP or password in the repository, in frontend code, in any `VITE_`-prefixed variable, in browser storage, in tests, fixtures or docs.
2. The browser never receives a broker secret. Broker authentication will be handled server-side only, after FYERS account verification and explicit authorization.
3. Only `.env.example` is committed. It holds names and non-secret defaults. Real `.env` files are git-ignored.
4. `LIVE_ORDERS_ENABLED` must be `false`. The server refuses to start otherwise, and the only order provider (`DisabledOrderProvider`) rejects every call with `LIVE_ORDERS_DISABLED`.
5. The web app makes network requests only to this project's own `/api` endpoints. No other host appears anywhere in production source.
6. No localStorage, sessionStorage or IndexedDB is used. V2 never reads the legacy `niftyAiTrader.*` browser storage.
7. The API binds to the loopback interface and accepts cross-origin requests only from the local Vite dev origin, read-only (GET).

## Planned multi-user model (not built in Phase 1A)

App-level broker identifiers live as server-side secrets. Each user's broker token is obtained through the broker's OAuth flow, stored server-side keyed to that user, and never sent to Web or Android. Clients hold only an application session. The developer's own broker credentials are never part of the application.

## Enforcement

`tests/architecture/security.test.ts` scans the repository for broker names outside the allowed zones, non-local URLs, storage APIs, credential-like strings, secret-like `VITE_` variables, stray `.env` files, and strategy math.
