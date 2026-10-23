# Phase 1B.1 report: controlled defect fix (D1 to D5)

**Baseline:** Phase 1B commit `1d21f06` (parent `5fda879`, tag `phase-1a-frozen` unchanged).
**Branch:** `fix/phase-1b.1-defects`, created from `1d21f06`. History and tags are not rewritten.
**Source of the defects:** the read-only audit of `1d21f06` (probe tests P1 to P5), and the owner's approved policies (`DECISIONS.md`, Decided item 4).
**Scope:** only the five defects. No broker, authentication, live data, order or Phase 2 work. Risk thresholds are not touched.

## Results

| Command (Node 22.22.2, npm 10.9.4) | Exit | Result |
|---|---|---|
| `npm ci` | 0 | lockfile unchanged |
| `npm run typecheck` | 0 | all workspaces and `tests/` |
| `npm run lint` | 0 | ESLint clean |
| `npm run test` | 0 | **543 / 543** passed, 23 / 23 files |
| `npm run build` | 0 | core, adapters, api, web |
| `npm run check` | 0 | 543 / 543 |

| | Phase 1A (`5fda879`) | Phase 1B (`1d21f06`) | Phase 1B.1 |
|---|---|---|---|
| Tests | 98 | 474 | **543** |

- All 98 Phase 1A tests still run and pass; no Phase 1A test file was changed. (One Phase 1A test title was already renamed by Phase 1B with an identical assertion.)
- Of the 474 Phase 1B tests, 471 are unchanged in name. **3 were rewritten** because they asserted the defective behaviour (listed below). 69 tests are new.
- The 60 tests in `packages/core/tests/phase1b1Fixes.test.ts` were written first: **45 of them failed on `1d21f06`**, reproducing each defect; the other 15 pin boundaries that must keep passing.

## Defects, corrections and evidence

### D1: stale entry price at confirmation
- **Defect:** `confirm()` opened at the review-time asks with no age limit; the snapshot did not record the quote time.
- **Correction:** `confirm` now requires fresh executable quotes (bid and ask) for the exact legs, each with its own `asOf`, checked against the server clock: at most **60 s** old (`TIME_RULES.maxQuoteAgeMs`) and not future-dated beyond the allowed skew. Entry premium, capital (gate re-checked) and entry risk are recalculated from them. A refused confirmation is journaled (`CONFIRM_REJECTED_QUOTE`) and the trade stays in `PAPER_REVIEW`. The snapshot (`snapshotVersion: 2`) records each leg's `quoteAsOf` and `quoteAgeMs`, the rule applied and `candidateAsOf`. New error code `QUOTE_NOT_FRESH` (HTTP 422).
- **Files:** `packages/core/src/paper/service.ts` (`resolveFreshEntryQuotes`, `confirm`), `packages/core/src/paper/time.ts` (new), `packages/core/src/paper/parse.ts` (`parseConfirmRequest`), `packages/core/src/contracts/paperContracts.ts`, `apps/api/src/paperRoutes.ts`, `apps/web/src/components/QuoteForm.tsx`, `apps/web/src/components/TradeDetail.tsx`.
- **Tests (23 core + 3 API + 2 web):** 5-day and 10-day stale re-send refused; quotes omitted refused; 59 s / 60 s accepted, 61 s refused; future within skew accepted, beyond refused; missing, invalid, impossible, date-only and zoneless times refused; another strike/expiry refused; missing ask, LTP-only and conflicting quotes refused; recalculation 70.50 + 51.25 = 121.75 (capital 8163.75); fresh price can fail the capital gate; missing depth not carried from review; snapshot records quote times; the UI sends quotes stamped when typed and shows a `QUOTE_NOT_FRESH` refusal.

### D2: expiry priced from an old monitored bid
- **Defect:** with no current bid, `runSafetyCheck` priced the closure from the last monitored bid and reported P&L `VALID`.
- **Correction:** the closure is valued only from valid current CE/PE bids. Otherwise basis `NONE`, `valuationStatus: DATA_INSUFFICIENT`, exit price null and P&L `DATA_INSUFFICIENT`; the old bid is kept as `staleReference` (historical reference only). The lifecycle event is still recorded. `LAST_VALID_MONITOR_BID` is no longer produced (kept in the type so Phase 1B journals load).
- **Files:** `packages/core/src/paper/service.ts` (`runSafetyCheck`), `packages/core/src/contracts/paperContracts.ts`, `apps/web/src/components/TradeDetail.tsx`.
- **Tests (5 core + 1 API + 1 web):** about-one-day and about-nine-days-old monitored bids at expiry; the holding-limit closure; valid current bids still value the exit (unchanged); state, valuation and P&L kept separate.
- **Rewritten Phase 1B test:** `paperService.test.ts` "EXPIRY with last valid monitored bids: PAPER_EXPIRED, priced from them…" now asserts the approved rule (not priced from it; reference only; `DATA_INSUFFICIENT`).

### D3: client timestamps trusted
- **Defect:** `asOf` on monitor, exit and safety check was accepted without ordering or skew checks; an exit before entry was accepted and a future `asOf` forced expiry.
- **Correction:** the service clock (`now`) is the trusted time and is injectable (`createDefaultPaperService(path, { now })`). A client `asOf` must be a full timestamp with a zone, not earlier than the trade's last recorded update, and not later than server time + **5 s** (`TIME_RULES.maxFutureSkewMs`, a DEFAULT awaiting owner review); otherwise `INVALID_REQUEST` and nothing changes. Expiry and safety are decided on server time; a client `asOf` there is validated and only recorded (`clientAsOf`). The safety-check `asOf` is now optional, and the web form no longer asks for a date.
- **Files:** `packages/core/src/paper/time.ts`, `service.ts`, `parse.ts`, `apps/api/src/paperService.ts`, `apps/web/src/components/TradeDetail.tsx`.
- **Tests (10 core + 2 API + 1 web):** exit before entry refused; out-of-order monitor refused; future exit refused, within-skew accepted; invalid and ambiguous times refused; future `asOf` cannot force expiry; expiry follows server time; event stamped with server time.
- **Rewritten Phase 1B tests:** `paperParse.test.ts` safety-check parsing (asOf now optional; a bare date is rejected) and the web test "a safety check sends asOf…" (now: no client date is sent).

### D4: expiry date taken by slicing an ISO string
- **Defect:** `dateOf()` used the first ten characters of the timestamp, so UTC and other offsets gave the wrong calendar date.
- **Correction:** `istDateOf()` computes the date in **Asia/Kolkata** with `Intl.DateTimeFormat`. The documented convention is unchanged and is now explicit in `EXPIRY_CONVENTION`: the expiry day is not expired; expired from 00:00 IST on the next day. No holiday, expiry calendar or market-hours cutoff is invented.
- **Files:** `packages/core/src/paper/safety.ts`.
- **Tests (14 core):** `18:29:59Z` vs `18:30:00Z` on the expiry day (IST midnight), the audited `22:30Z` case, an early-morning IST time whose UTC date is the previous day, a `+09:00` time whose written date is the next day, a `-05:00` time; unparseable time throws.

### D5: implicit one-lot assumption
- **Defect:** `buildRiskInputs` used `capital.lots ?? 1` for `contractLiquidity`.
- **Correction:** an unknown, zero or invalid lot count leaves `contractLiquidity` null (risk stays `INSUFFICIENT` where the contract requires it). Explicit lots are unchanged.
- **Files:** `packages/core/src/paper/riskInputs.ts`.
- **Tests (7 core):** lots unknown, 0, −1, 1.5, NaN give null; 2 lots give 50; 1 lot keeps 100.

## Test infrastructure changes (no assertion weakened)

- `packages/core/tests/fixtures.ts`: the service clock is injectable (`clock.peek / set / advance`, same tick as before); `confirmBody()` / `freshQuotes()` supply fresh quotes for the exact legs. `opened()` uses them.
- Existing tests that confirmed with `{ confirmed: true }` now send `confirmBody(...)`; safety tests move the server clock instead of passing a client date. Expected numbers are unchanged; the snapshot test now also checks `snapshotVersion: 2`, `quoteAsOf` and `quoteAgeMs`.
- `apps/api/tests/paperApi.test.ts` injects a monotonic test clock; `fileJournalRepository.test.ts` sends fresh quotes.

## Unchanged (verified by diff)

Frozen LONG VOL formulas (`pricing.ts`), Score / Expected Net Edge separation, risk rules and engine (`rules.ts`, `engine.ts`, `filter.ts`) and `RISK_ENGINE.md`, the journal repository and file store, JSON export, broker adapters (`NullBrokerAdapter`, `DisabledOrderProvider`), the API route list, and all architecture tests.

## Review corrections (R1 to R4)

Found in the Phase 1B.1 reviews of `817a5d4` / `6637e77`. Tests were written before each correction. R1–R3 add 19 tests (R1: 5 web; R2: 6 core; R3: 8 core). Run on `6637e77` before the corrections, 15 of them failed (all 5 R1, 4 of 6 R2 and 6 of 8 R3); the other 4 guard behaviour that was already correct (client-time validation, server-time expiry, an identical duplicate accepted, a foreign instrument refused) and passed before and after. R4 adds 9 tests (5 core, 4 web), all of which failed before R4, and updates one R2 assertion. All pass after the corrections.

- **R1: manual quote entry times (web).** `QuoteForm` kept one entry time per leg, refreshed by editing any field (including volume, OI and depth). It now keeps a user-entry time per **price** (bid, ask); depth, volume and OI never change it; clearing a price removes its time. The leg is sent with the **older** of its two price times, or with no time if either price has none (the server then refuses it). The confirm contract (one `asOf` per quote) is unchanged: sending the older time cannot make a quote look newer, so no wider contract change was needed. The form labels these as user-entry times, not exchange timestamps, and states that they do not prove market freshness. Files: `apps/web/src/components/QuoteForm.tsx`. Tests: 5 (`apps/web/tests/phase1b.test.tsx`, "R1").
- **R2: client times persisted as authoritative.** `monitor()` and `exit()` wrote a tolerated client `asOf` into `updatedAt`, journal event times and the monitor/exit records, so a slightly-future client time could make a later normal request look out of order. Server time is now authoritative for all of them (including a refused exit's event); a validated client `asOf` is kept as `clientAsOf` metadata. Validation (format, ordering, skew) and server-time expiry are unchanged. Files: `packages/core/src/paper/service.ts`, `packages/core/src/contracts/paperContracts.ts` (optional `clientAsOf`). Tests: 6.
- **R3: conflicting duplicate entry quotes.** `resolveFreshEntryQuotes()` compared only bid, ask and time, so duplicates differing in depth, volume, OI or LTP were accepted and the first copy used. All of those fields are now compared; any difference is `DATA_INSUFFICIENT` (ambiguous). Identical duplicates are still accepted; the exact-instrument rule is unchanged. File: `packages/core/src/paper/service.ts`. Tests: 8.

- **R4: server processing time shown as a quote time.** Exit records set `priceAsOf` to server processing time and the UI showed it (and the monitor time and the stale reference time) as "as of", implying the market quote was observed then. Monitor, exit and safety quotes carry no observation time, so `priceAsOf` is now `null` (not available) for new exits and closures; `timestamp` remains the authoritative server event time. `lastMonitor.asOf` and `lastValidExit.asOf` keep their names and types and are documented and labelled as "recorded by the server at". No schema or version change: `priceAsOf` was already `string | null`, and older records still load (a non-null `priceAsOf` from an older record is labelled as not a verified quote-observation time). Valid P&L and lifecycle behaviour are unchanged. Files: `packages/core/src/paper/service.ts`, `packages/core/src/contracts/paperContracts.ts` (comments only), `apps/web/src/components/TradeDetail.tsx`. Tests: 5 core + 4 web (written first; all failed before the correction), and one R2 assertion updated (`priceAsOf` is now null).

## Remaining limitations

- The 5 s clock skew is a DEFAULT, not a specified value.
- Exit, monitor and safety quotes have no per-quote freshness rule (only the event time is validated); the approved 60 s rule covers confirmation.
- Manual quote times come from the user's browser clock at the moment of typing; they are checked against the server clock but are not exchange-verified.
- Spot, trading days to expiry and the strategy outputs are review-time values at confirmation (recorded with `candidateAsOf`).
- Monitor and exit quotes: duplicates for one leg are still checked on the bid only (`resolveLegBids`, and the monitor's current-risk inputs use the first matching copy). R3 covered entry quotes only, as scoped.
- Records written by Phase 1B (`snapshotVersion: 1`, basis `LAST_VALID_MONITOR_BID`) are left as they are; they are not rewritten.
