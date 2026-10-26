# Phase 1B.2 report: paper-trading safety

**Branch:** `fix/phase-1b.2-safety`, created from `b91fa26` (Phase 1B.1 head) as decided (A13). Phase 1B.1 was not merged into `main` first.
**Pull request:** draft PR #1 into `main` (`1d21f06`). It contains the four Phase 1B.1 commits and the Phase 1B.2 commits.
**Frozen tag:** `phase-1a-frozen` still points to `5fda879ca29ea9b214cafd05adcd6a407cae1b95`. No history or tag was rewritten.
**Scope:** paper trading only. No broker, live market data, order endpoint, order execution, credentials or secrets were added.
**Status:** not production-ready; not independently reviewed. Most of the code and this report were written by an AI assistant
(Claude) under the owner's approvals. A human review is still required before merging.

## Summary

Phase 1B.2 closes the safety findings of the read-only review of `b91fa26` (HIGH-1 expiry gate, HIGH-2 bid/ask validation,
HIGH-3 expiry valuation, MEDIUM-1 manual-price times) under the owner-approved decisions A1 to A13 and D1 to D9 (see `DECISIONS.md`,
Decided item 5), plus two later review corrections:

- **Safety-review correction:** at or after the cutoff the server clock alone decides; an unacceptable or malformed client `asOf`, or a
  quote for another instrument, cannot block the required unpriced expiry closure (it is ignored and noted, never used).
- **M1 (review of PR #1):** an open trade read at or after its cutoff no longer shows its old unrealized P&L as a checked valuation.
- **Final review:** explicit leg instruments must match market, expiry, option type and strike exactly; older records that are not consistent
  stay readable but are never priced again (closed unpriced only); the post-cutoff snapshot has its own derived level `HISTORICAL_SNAPSHOT`;
  the stale-age warning before the cutoff is explicitly deferred.

## Phase 1B.1 fixes included in this pull request

| Commit | Content |
|---|---|
| `817a5d4` | D1 quote freshness at confirmation (60 s), D2 expiry without executable bids, D3 untrusted client times, D4 IST expiry dates, D5 no implicit one-lot assumption |
| `6637e77` | Journal export URL test made environment-aware |
| `c788650` | Review corrections R1 to R4 (per-price entry times, client time as metadata only, server time is not a quote-observation time) |
| `b91fa26` | Phase 1B.1 report test totals corrected |

Details: `PHASE_REPORTS/PHASE_1B1.md`.

## Safety rules (Phase 1B.2) and their limits

| Rule | Behaviour | Limitation |
|---|---|---|
| Expiry cutoff (A3) | A contract is expired **at and after 15:30:00.000 Asia/Kolkata on its expiry date** (inclusive). | **Provisional.** It is not a verified exchange calendar: no exchange holidays, special sessions or changed market hours. The expiry date is the one the user typed. |
| Actions after the cutoff (A6, A12) | assess, review, confirm, monitor and exit are refused with `CONTRACT_EXPIRED` (HTTP 409). Confirm and exit refusals are journaled (`CONFIRM_REJECTED_EXPIRED`, `EXIT_REJECTED_EXPIRED`). An open trade is closed by the safety check. | An expired review stays `PAPER_REVIEW` (derived status `EXPIRED_REVIEW`); no new lifecycle state exists (A7). |
| Expiry closure (A4) | Always unpriced: basis `NONE`, `exitPremium: null`, valuation and P&L `DATA_INSUFFICIENT`. Supplied prices are never used; an earlier monitored bid is kept only as `staleReference`. | There is no approved settlement-price source, so a worthless or settled contract records no P&L. |
| Server clock first | At or after the cutoff, a bad client `asOf` or a foreign quote cannot block the expiry closure; both are ignored and noted. Before the cutoff they are still refused (`INVALID_REQUEST`). | A structurally malformed request (for example a non-numeric bid or a fractional `completedSessions`) is still refused, even at the cutoff. |
| Manual prices (A1, A2, A9) | Monitor, exit and holding-limit prices need, per leg, a valid bid and ask and a user-entry time (`asOf`) at most 60,000 ms old and at most 30,000 ms ahead of server time (both inclusive). A quote for another instrument is `INVALID_REQUEST` (D1). A passing valuation is labelled `MANUAL_ENTRY_CHECKED`. | **Manual entry times are not exchange timestamps** and are not independent price verification. `MANUAL_ENTRY_CHECKED` only means the application's input rules passed; the prices are typed by the user. |
| Bad monitor price (A8) | Recorded as a `DATA_INSUFFICIENT` snapshot; it never replaces the last valid bids. | |
| Holding limit (A5) | Priced only from checked manual prices before the cutoff; otherwise unpriced. | The completed-session count is typed by the user; there is no trading calendar. |
| Price quality and expiry status (A10, D2 to D4, D8) | Every trade-returning response carries derived `priceQuality` (level, flags, warnings, note) and `expiryStatus`. They are computed when read and never stored. | Ambiguous older records are never upgraded. |
| Historical snapshot (M1, final review) | An open trade read at or after its cutoff with a recorded valid unrealized P&L: level `HISTORICAL_SNAPSHOT`, flag `UNREALIZED_SNAPSHOT_AFTER_CUTOFF`; the UI labels it "historical snapshot ... not a current or executable price, not exchange-verified, not realized P&L". Without a recorded valid figure the level stays `NO_PRICE`. Decided by the server read time and the approved cutoff only; display-only. | **Before the cutoff, an old snapshot is not flagged by age** (deferred: no approved threshold; stored times show when an update was recorded, not when prices were observed). The UI shows the recording time and never says "now". |
| Instrument identity (final review) | An explicit leg instrument must be `{ provider: "manual", id: "<market>\|<YYYY-MM-DD>\|<CE or PE>\|<strike>" }` with every part equal to the structured fields (strike as `String(strike)`); anything else is refused (`INVALID_REQUEST`, 400). Older records are not rewritten: `expiryStatus` reports `instrumentCheck`, `instrumentReasons` and `expiryUsed` (earliest readable expiry). A record that is not `CONSISTENT` cannot be confirmed, monitored or exited (`DATA_INSUFFICIENT`, 422, nothing written); it is closed only unpriced (holding limit or expiry) and its price quality is flagged `INSTRUMENT_IDENTITY_UNVERIFIED`. | Exact-text comparison: a strike written another way (`22900.0`) is refused. An `UNVERIFIABLE` older open trade's true expiry is unknown; it uses the candidate expiry for the cutoff, shown as not verified, and nothing is priced meanwhile. |
| Raw journal export | Unchanged: stored records only, without derived fields. No enriched export exists. | |
| Legacy label | Priced exits keep `basis: "CURRENT_QUOTE"` (legacy label, schema unchanged); the method is identified by `valuationStatus` and `priceProvenance`. | |

## Validation (actual results)

Run on `6f1fd0b` plus the final-review change, in a clean checkout (Linux, Node 22.22.2, npm 10.9.4), by the AI assistant:

| Command | Exit | Result |
|---|---|---|
| `npm ci --ignore-scripts` | 0 | `package-lock.json` unchanged |
| `npm run check` (typecheck, lint, tests) | 0 | **813 / 813** tests passed, **26 / 26** test files |
| `npm run build` | 0 | core, adapters, api, web |
| `git diff --check` | 0 | clean |

The owner reported Windows results for `6efbeeb` (742 / 742) and `6f1fd0b` (754 / 754), each with the build OK and `git diff --check`
clean, and should re-run `npm.cmd run check`, `npm.cmd run build` and `git diff --check` after applying the final-review change.

**GitHub CI has not run.** The repository has no workflow under `.github/workflows`, and PR #1 shows 0 checks. All results above are local.

### Test inventory

| | Phase 1B.1 (`b91fa26`) | Phase 1B.2 (this branch) |
|---|---|---|
| Tests | 573 (23 files) | **814** (26 files) |

- 567 of the 573 Phase 1B.1 test names are unchanged. Some of them had approved minimal input changes (for example the six approved test
  corrections: an ask and an entry time added to bid-only exit quotes, a later fixture expiry for the 10-day stale-quote case, the
  `MANUAL_ENTRY_CHECKED` expectation, and the derived fields excluded from a stored-record comparison).
- **5 tests in `phase1b1Fixes.test.ts` were rewritten one for one** because the approved behaviour changed: expiry closures are no longer
  priced from typed bids (A4), and expiry is at 15:30 IST on the expiry date instead of 00:00 IST the next day (A3).
- **1 test in `paperParse.test.ts` was rewritten** (final review): "keeps a supplied instrument identity exactly" used an opaque instrument
  (`{ provider: "p", id: "abc" }`) whose expiry cannot be verified, which is now refused. It now keeps a consistent manual instrument exactly;
  the opaque case has its own refusal test.
- **241 tests are new:** `packages/core/tests/phase1b2Safety.test.ts` 171, `apps/api/tests/phase1b2Api.test.ts` 27,
  `apps/web/tests/phase1b2.test.tsx` 21, `packages/core/tests/paperParse.test.ts` 22.
- 814 = 567 unchanged names + 6 rewritten + 241 new.
- Final review against `6f1fd0b` (754): 746 names unchanged, 8 renamed because their expectation changed intentionally (5 core and 2 web M1
  tests now expect `HISTORICAL_SNAPSHOT` / the "when recorded" wording; 1 parse test above), 60 new.
- The Phase 1A test files are unchanged against `main`.
- `packages/core/src/paper/pricing.ts` (LONG VOL formulas) and `package-lock.json` are unchanged against `main`.

## Known limitations

- The 15:30 IST cutoff is provisional (see above). Holidays, special sessions and changed hours are not handled.
- Instrument identity is compared by exact text with the parser's own builder; no other notation of a strike is accepted.
- An older `UNVERIFIABLE` open trade's true expiry is unknown. It uses the candidate expiry for the cutoff (shown as not verified); until then it
  can only be closed unpriced by a holding-limit safety check, and it cannot be monitored or exited.
- **No stale-age warning for unrealized P&L before the cutoff: deferred** (no approved threshold; no evidence of when prices were observed).
- Expiry closures are unpriced while no approved settlement-price source exists.
- Session counts and trading days to expiry are user-supplied (no trading calendar).
- Single-user, local only; no authentication. The file journal is not guaranteed durable storage (see `PAPER_TRADING.md`).
- The web form's per-price entry time is taken from the browser clock when each price is typed; the server checks it against its own clock.

## Rollback and frozen-tag notes

- Do **not** run an older build (Phase 1B or 1B.1) against a journal written by Phase 1B.2. Take a JSON export (or copy
  `data/paper-journal.json`) before any rollback, and keep it (D7).
- Historical journal records are never rewritten; older labels are shown with price-quality warnings.
- `phase-1a-frozen` must stay at `5fda879`. No document or script in this phase moves or deletes it.
- Nothing has been merged into `main` or deployed.
