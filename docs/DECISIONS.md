# Decisions (open and decided)

Each numbered item shows its status. Items marked **DECIDED** were settled by the project owner; **OPEN** items are deliberately not pre-empted.

1. **Persistence / storage: DECIDED for Phase 1B; the wider question stays OPEN.**
   Phase 1B uses a backend-managed `FileJournalRepository` behind a `JournalRepository` interface, with a JSON export for backups. No PostgreSQL, Redis, Firebase, Supabase, AWS storage or browser storage is used.
   The file store is **not guaranteed durable** and must not be relied on on serverless or ephemeral hosting (see `PAPER_TRADING.md`). Still open: durable storage for multi-user sessions and stored broker tokens, which must be decided before the broker-authentication phase.
2. **Hosting / server architecture: OPEN.** The API is a local Express server. A hosted environment may prefer serverless functions (handlers and the paper-trading service are plain functions), but the file journal needs a persistent disk, so hosting and persistence must be decided together.
3. **PAPER_EXPIRED vs PAPER_AUTO_CLOSED: DECIDED in Phase 1B.** Both are kept. `PAPER_EXPIRED` = the expiry date passed. `PAPER_AUTO_CLOSED` = closed by the holding-limit safety rule (2 completed sessions). If both apply, expiry wins.
4. **Best Opportunities exit rule: OPEN.** Phase 1B gives Best Opportunities the same user-driven exit and the same expiry and holding-limit safety rules as LONG VOL. No strategy-specific exit rule is defined.
5. **Commodity underlying definition: OPEN.** Gold, silver and crude options normally sit on futures, not a spot index. Which instrument is "spot", and which series feeds RV20, is unresolved. The market definition keeps `underlyingKind` UNRESOLVED.
6. **FYERS authentication implementation: OPEN (deferred).** Deferred until FYERS account verification and explicit authorization. Use the current FYERS API v3 auth-code flow, server-side only.
7. **Small Cap instrument definition: OPEN.** SMALL CAP is not defined. It must be resolved against a real broker-supported instrument or stay NOT_CONFIGURED.

## Decided

1. **Risk may use the quality of Expected Net Edge as an input.** `expectedNetEdgeQuality` is an accepted Risk input.
   - Expected Net Edge remains a separate strategy/opportunity output, produced by the strategy layer.
   - Risk may use the *quality* of Expected Net Edge as one input among others.
   - Risk must **not** calculate, replace or override Expected Net Edge, and must not be derived from the opportunity Score.
2. **Persistence for Phase 1B is a backend-managed file journal** behind a repository interface (see item 1 above).
3. **The paper-trade lifecycle is** `CANDIDATE → PAPER_REVIEW → PAPER_OPEN → PAPER_EXITED`, with `PAPER_EXPIRED`, `PAPER_AUTO_CLOSED` and `DATA_INSUFFICIENT` as safety/terminal states. Only an explicit confirmation opens a trade.

## Open notes and known limitations (Phase 1B)

- **Risk rules are an uncalibrated first table.** `RISK_ENGINE.md` (rules v1.0.0) labels every number as LEGACY, SPEC, STRUCTURAL or DEFAULT. The DEFAULT values have no source in the specification and are proposals awaiting owner approval. No outcome data exists to validate any of them.
- **Candidates are entered by hand.** There is no broker, so there is no scanner. Score, Expected Move, Implied Move and Expected Net Edge are recorded as typed, not computed.
- **A zero or negative bid is treated as "no price"**, not as a price of zero. A genuinely worthless option at expiry therefore records `DATA_INSUFFICIENT` P&L rather than an assumed zero. Revisit if you would rather record zero.
- **Discarding a reviewed candidate has no state.** A `PAPER_REVIEW` trade that is never confirmed simply stays in review. No state was invented for it.
- **Completed sessions and trading days to expiry are supplied by the user**, because no trading calendar exists. The holding limit is "not evaluated" when they are absent.
- **The expiry day itself is not treated as expired**, because market hours are not configured.
- **Phase 1A contracts for paper trades and the journal (`PaperTrade`, `PaperTradeStatus`, `JournalStore`) are unchanged and now unused**, beside the Phase 1B types. Retire them in a deliberate re-freeze rather than editing a frozen contract.
- **The web app repeats the 3-line risk-filter rule**, because it may import only `@nsest/core/contracts` (types and constants). A web test mirrors the core test cases.
- **The "Not available in Phase 1A" notice** is kept on the live-scanning sections (the scanner genuinely does not exist), because a frozen test asserts that text.
- **Best Opportunities risk filter.** Single selection `ALL`, `LOW`, `MEDIUM`, `HIGH`, default `ALL`. It is disabled until at least one candidate exists.
- **PWA.** A web manifest only. A service worker is deferred, because caching API responses needs a deliberate design.
- **CORS.** The API allows only the local Vite dev origin (GET, POST and the preflight). Revisit with the hosting decision.
- **No authentication.** Phase 1B is single-user and local; the API binds to loopback only.
