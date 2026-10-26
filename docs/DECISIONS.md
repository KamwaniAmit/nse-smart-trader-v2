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

4. **Phase 1B.1 defect policies (owner-approved after the audit of `1d21f06`).**
   - **D1 Quote freshness:** at confirmation every leg needs a fresh executable quote for the exact instrument, at most **60 seconds** old by server time; missing, invalid, stale or future-dated quotes are refused, and entry values are recalculated from them.
   - **D2 Expiry without executable bids:** an old monitored bid is never a valid exit price. Closure is recorded, valuation and P&L are `DATA_INSUFFICIENT`, and the old bid is kept for reference only.
   - **D3 Timestamps:** client times are untrusted (format, ordering and skew are validated); expiry and safety use server time.
   - **D4 Expiry timezone:** expiry dates are judged in Asia/Kolkata; the documented convention (expiry day not expired; expired from 00:00 IST the next day) is unchanged.
   - **D5 Lot count:** no implicit one-lot assumption in risk inputs.
   - The allowed clock skew (5 s) was not specified; it was a DEFAULT awaiting owner review (replaced by Phase 1B.2 A1).

5. **Phase 1B.2 safety decisions (owner-approved; branch `fix/phase-1b.2-safety` from `b91fa26`).**
   - **A1** Client-clock tolerance: a time may be up to **30,000 ms** ahead of server time (inclusive).
   - **A2** Manual monitor, exit and holding-limit prices must have been entered at most **60,000 ms** before the server processes them (inclusive).
   - **A3** Expiry cutoff: **15:30 Asia/Kolkata on the expiry date** (inclusive). Provisional; **not a verified exchange calendar** (no holidays, special sessions or changed hours).
   - **A4** Expiry closure: basis `NONE`, P&L `DATA_INSUFFICIENT`. No settlement price is invented.
   - **A5** Holding-limit closure: priced only from validated manual prices before the cutoff (`MANUAL_ENTRY_CHECKED`), otherwise unpriced.
   - **A6** `CONTRACT_EXPIRED` maps to HTTP **409**.
   - **A7** No new lifecycle state. An expired review stays `PAPER_REVIEW`; its derived expiry status is `EXPIRED_REVIEW`.
   - **A8** An invalid monitor price records a `DATA_INSUFFICIENT` snapshot and never replaces the last valid bids.
   - **A9** Valuation label `MANUAL_ENTRY_CHECKED`: only the application's manual-input rules passed; never exchange-verified.
   - **A10** Derived `priceQuality` on responses and in the UI; the raw journal export is unchanged; no enriched export without approval.
   - **A11** Only tests whose expected behaviour intentionally changed are rewritten.
   - **A12** `assess` is also gated by the cutoff.
   - **A13** Branch from `b91fa26`; Phase 1B.1 is not merged first.
   - **D1** A quote for an instrument that is not a leg of the trade is `INVALID_REQUEST` on monitor, exit and safety check.
   - **D2** Derived fields are on every trade-returning response, including monitor and exit.
   - **D3** `expiryStatus` is derived, never stored.
   - **D4** Price-quality classification never infers exchange verification; ambiguous records are not upgraded.
   - **D7** Older builds must not be run against a Phase 1B.2 journal; a backup is required before any rollback.
   - **D8** Names as proposed, plus `PROVENANCE_INCOMPLETE`, `PROVENANCE_INCONSISTENT` and `priceQuality.note`.
   - **D9** Tests are kept with the implementation when a test-only commit would not compile.

6. **Phase 1B.2 final review (owner instruction, after the review of PR #1).**
   - **Instrument identity:** an explicit leg instrument must be the manual format whose market, expiry, option type and strike equal the
     structured fields exactly; anything else (including opaque providers) is refused (`INVALID_REQUEST`). Older records are not rewritten; the
     cutoff uses the earliest readable expiry; a record that is not `CONSISTENT` cannot be confirmed, monitored, exited or priced, and can only be
     closed unpriced by the safety check (holding limit or expiry).
   - **Historical snapshot:** a dedicated derived level `HISTORICAL_SNAPSHOT` for an open trade's recorded unrealized P&L read at or after the cutoff.
   - **Stale-age warning before the cutoff: DEFERRED.** No threshold is approved, and the stored times do not show when prices were observed.
     The UI no longer describes a recorded exit premium as "now". Decide a threshold (and its evidence) before adding an age warning.

## Open notes and known limitations (Phase 1B)

- **Risk rules are an uncalibrated first table.** `RISK_ENGINE.md` (rules v1.0.0) labels every number as LEGACY, SPEC, STRUCTURAL or DEFAULT. The DEFAULT values have no source in the specification and are proposals awaiting owner approval. No outcome data exists to validate any of them.
- **Candidates are entered by hand.** There is no broker, so there is no scanner. Score, Expected Move, Implied Move and Expected Net Edge are recorded as typed, not computed.
- **A zero or negative bid is treated as "no price"**, not as a price of zero. A genuinely worthless option at expiry therefore records `DATA_INSUFFICIENT` P&L rather than an assumed zero. Revisit if you would rather record zero.
- **Discarding a reviewed candidate has no state.** A `PAPER_REVIEW` trade that is never confirmed simply stays in review. No state was invented for it.
- **Completed sessions and trading days to expiry are supplied by the user**, because no trading calendar exists. The holding limit is "not evaluated" when they are absent.
- **Expiry cutoff is provisional.** Since Phase 1B.2 a contract expires at 15:30 Asia/Kolkata on its expiry date (server time). There is no exchange holiday or session calendar.
- **Manual prices are checked, not verified.** Since Phase 1B.2 monitor, exit and holding-limit prices need a bid, an ask and a user-entry time within 60 s; this proves only that the input rules passed (`MANUAL_ENTRY_CHECKED`), not that the prices came from the exchange.
- **Phase 1A contracts for paper trades and the journal (`PaperTrade`, `PaperTradeStatus`, `JournalStore`) are unchanged and now unused**, beside the Phase 1B types. Retire them in a deliberate re-freeze rather than editing a frozen contract.
- **The web app repeats the 3-line risk-filter rule**, because it may import only `@nsest/core/contracts` (types and constants). A web test mirrors the core test cases.
- **The "Not available in Phase 1A" notice** is kept on the live-scanning sections (the scanner genuinely does not exist), because a frozen test asserts that text.
- **Best Opportunities risk filter.** Single selection `ALL`, `LOW`, `MEDIUM`, `HIGH`, default `ALL`. It is disabled until at least one candidate exists.
- **PWA.** A web manifest only. A service worker is deferred, because caching API responses needs a deliberate design.
- **CORS.** The API allows only the local Vite dev origin (GET, POST and the preflight). Revisit with the hosting decision.
- **No authentication.** Phase 1B is single-user and local; the API binds to loopback only.
