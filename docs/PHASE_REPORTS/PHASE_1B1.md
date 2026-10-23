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

## Remaining limitations

- The 5 s clock skew is a DEFAULT, not a specified value.
- Exit, monitor and safety quotes have no per-quote freshness rule (only the event time is validated); the approved 60 s rule covers confirmation.
- Manual quote times come from the user's browser clock at the moment of typing; they are checked against the server clock but are not exchange-verified.
- Spot, trading days to expiry and the strategy outputs are review-time values at confirmation (recorded with `candidateAsOf`).
- Records written by Phase 1B (`snapshotVersion: 1`, basis `LAST_VALID_MONITOR_BID`) are left as they are; they are not rewritten.
