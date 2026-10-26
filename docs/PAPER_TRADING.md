# Paper Trading (Phase 1B, 1B.1, 1B.2)

Paper trading is **broker-independent**. It never contacts a broker, never uses credentials, and never places an order.
It works on prices that **you supply** (manual entry), and it records everything in a local journal.

## Lifecycle

```
CANDIDATE ──► PAPER_REVIEW ──► PAPER_OPEN ──┬──► PAPER_EXITED        (you exit, with valid bids)
    │                │  explicit             ├──► PAPER_EXPIRED       (contract expired)
    │                │  confirmation         └──► PAPER_AUTO_CLOSED   (safety rule closed it)
    └──► DATA_INSUFFICIENT                        (no executable entry price; final)
```

| State | Meaning |
|---|---|
| `CANDIDATE` | Evaluated only. Lives in memory; nothing is stored. Never advances by itself. |
| `PAPER_REVIEW` | You opened it for review (stored). **Not a position.** Shows entry premium, capital and risk. |
| `PAPER_OPEN` | You explicitly confirmed (`confirmed: true`). The immutable entry snapshot is recorded. |
| `PAPER_EXITED` | You exited and **every** leg had a valid executable bid. |
| `PAPER_EXPIRED` | The expiry date passed. Priced only from real bids (see "Expiry and safety"). |
| `PAPER_AUTO_CLOSED` | Closed by the holding-limit safety rule. |
| `DATA_INSUFFICIENT` | A candidate had no executable entry price. Final; it can never be opened. |

Terminal states are final: a stored record in one of them cannot change. There is **no automatic path** into `PAPER_OPEN`:
review never opens a trade, and only an explicit confirmation does. (The Phase 1A `PaperTradeStatus` contract is unchanged and
separate; this lifecycle sits beside it.)

## Where candidates come from

There is no broker yet, so a candidate is **typed in** on the LONG VOL or Best Opportunities page and labelled `MANUAL`
(never presented as live data). Score, Expected Move, Implied Move and Expected Net Edge are recorded **as typed**; Phase 1B
does not calculate them, so the frozen LONG VOL mathematics is untouched. Instrument identity for a typed leg is
`{ provider: "manual", id: "<market>|<expiry>|<CE or PE>|<strike>" }`. It is **not** broker-verified.

**Instrument identity (Phase 1B.2 final review).** A leg may carry an explicit instrument only if it identifies exactly that leg's contract,
because the expiry cutoff and every price are attached to it. It must use the manual format above, and each part must equal what the parser's
own builder writes from the structured fields: market = `marketId`, expiry = `expiry` (a real `YYYY-MM-DD` date), option type = the leg's
`optionType`, strike = the leg's `strike` as written by `String(strike)` (no other normalisation: `22900.0` is not `22900`). A mismatch in any
part, a missing or malformed part, or an opaque instrument of another provider (none of whose fields can be verified) is refused with
`INVALID_REQUEST` (HTTP 400). Nothing is rewritten.

Older stored records are never rewritten and stay readable. The response's `expiryStatus` reports `instrumentCheck` (`CONSISTENT`, `MISMATCH`,
`UNVERIFIABLE`), `instrumentReasons` and `expiryUsed` (the earliest readable expiry, so an inconsistent instrument can never move the cutoff later;
for `UNVERIFIABLE` it is the candidate expiry, shown as not verified). A record that is not `CONSISTENT` is never priced again:

| Action on a record that is not `CONSISTENT` | Rule |
|---|---|
| Confirm (review) | refused, `DATA_INSUFFICIENT` (422); nothing written |
| Monitor, exit | refused, `DATA_INSUFFICIENT` (422); nothing written (at or after the cutoff `CONTRACT_EXPIRED` comes first) |
| Holding-limit closure (safety check) | allowed, always **unpriced** (basis `NONE`, P&L `DATA_INSUFFICIENT`); supplied prices are not used |
| Expiry closure (safety check) | allowed at the cutoff of `expiryUsed`, unpriced as for every expiry closure |
| Price quality | flagged `INSTRUMENT_IDENTITY_UNVERIFIED`; never `MANUAL_ENTRY_CHECKED` |

- LONG VOL: `STRADDLE` (CE and PE at the same strike) or `STRANGLE` (CE strike above PE strike). Two legs, same expiry and lot size.
- Best Opportunities: `SINGLE_CALL` (one CE) or `SINGLE_PUT` (one PE).
- The same lifecycle, journal and rules apply to both.

## Pricing rules (frozen definitions, applied exactly)

- **Entry premium = sum of executable asks** (LONG VOL: CE Ask + PE Ask). Entry needs a full executable quote on every leg: valid bid **and** ask, ask not below bid.
- **Exit premium = sum of executable bids** (LONG VOL: CE Bid + PE Bid). Every leg needs a positive bid.
- **LTP, midpoint, theoretical or model prices are never used.** A quote that carries only an LTP gives no price.
- Exit and monitor prices are matched to the **exact stored instrument**. A quote for another strike, expiry, or provider is **ignored**, never substituted.
- A **zero or negative bid is "no price"**, not a price of zero. (A worthless option therefore records P&L as `DATA_INSUFFICIENT` rather than an assumed zero.)
- All arithmetic is in integer paise, so there is no floating-point drift (69.8 + 50.95 is exactly 120.75).

### Capital (frozen formulas)

`premiumRequirement = combinedEntryPremium × lotSize` · `totalCapitalRequirement = premiumRequirement + entryCosts` ·
`numberOfLots = floor(maxCapitalAllocation / totalCapitalRequirement)`. Capital is a **gate**: it can block confirmation, and it never
hides candidates. Unknown costs or allocation are **not guessed** (the gate is `NOT_EVALUATED`); you can still give an explicit number of lots.

### P&L

`gross = (exitPremium − entryPremium) × lotSize × lots`. `net = gross − entryCosts − exitCosts`, only when **both** costs are known;
otherwise net is null and labelled `COSTS_UNAVAILABLE`. If any required executable price is missing the P&L is **`DATA_INSUFFICIENT`**
with a reason. It is never estimated and never shown as zero. Worked check (legacy numbers): asks 69.8 + 50.95 = 120.75, bids 66.05 + 54.00 = 120.05,
one lot of 65 → gross **−45.50**.

## Confirmation needs fresh quotes (Phase 1B.1)

A trade opens only with `confirmed: true` **and** a fresh executable quote for **every** leg, sent with the confirmation:
`{ "confirmed": true, "quotes": [{ "instrument": {...}, "bid": …, "ask": …, "asOf": "2026-09-28T10:00:05+05:30", … }, …] }`.

- Each quote must be for the **exact** stored instrument. Duplicate quotes for one leg are accepted only if **every** field is identical
  (bid, ask, LTP, bid/ask quantity, volume, open interest and time); any difference is ambiguous and refused (`DATA_INSUFFICIENT`). A quote for another strike, expiry or instrument is refused (`INVALID_REQUEST`), never substituted.
- Each quote needs a valid **bid and ask** (ask ≥ bid). LTP, theoretical, model and review-time prices are never used (`DATA_INSUFFICIENT`).
- Each quote needs its own time (`asOf`): a full timestamp **with a zone**. It is checked against the **server clock**: it may be at most
  **60 seconds old** (approved policy) and at most the allowed clock skew in the future. A missing, invalid, ambiguous, stale or future time is refused
  (`QUOTE_NOT_FRESH`). For manually typed prices the web app records a **user-entry time per price** (bid and ask separately; editing
  volume, open interest or depth never changes it) and sends the **older** of the leg's two price times. If either price has no entry time,
  no time is sent and the quote is refused. These are user-entry times, not exchange timestamps; they do not prove the prices were current.
- A refused confirmation is journaled (`CONFIRM_REJECTED_QUOTE`) and the trade **stays in `PAPER_REVIEW`**, so it can be confirmed again with fresh prices.
- Entry premium, capital (and the capital gate) and entry risk are **recalculated** from the fresh quotes. The review record keeps the review-time numbers as history.
- Spot, trading days to expiry, expected and implied move, expected net edge and score are the candidate's values (supplied at review). They are not
  re-priced at confirmation; the snapshot records their time as `candidateAsOf`.

## Entry snapshot (immutable)

Recorded once, at confirmation, and frozen: candidate identity, market, structure, expiry, strikes, each leg's entry ask (and bid),
combined entry premium, lot size, lots, spot, expected move, implied move, expected net edge, score, **entry risk** (with its inputs and rules
version), capital assessment and requirement, timestamp, and a **data-completeness** record listing any market data that was missing.
Since Phase 1B.1 (`snapshotVersion: 2`) it also records each leg's **quote time** (`quoteAsOf`) and **age at confirmation** (`quoteAgeMs`),
the freshness rule applied (`quoteFreshness`) and `candidateAsOf`. Snapshots written by Phase 1B (`snapshotVersion: 1`) remain readable.
It is deeply frozen in memory, and the journal refuses any attempt to change or replace it.

## Entry risk versus current risk

Entry risk lives inside the snapshot and never changes. **Current risk** is recomputed at each monitor update from the prices you supply and stored separately,
so the page can show "Entry risk LOW, Current risk HIGH". Market data is **not** carried over (a missing price stays missing, and current risk
becomes unknown rather than reusing the entry value). Strategy outputs and capital parameters are carried and listed in the monitor record.
The rules are in `RISK_ENGINE.md`.

## Monitoring

`monitor` records current bids (and, for risk, asks, volume, open interest and depth), the current exit premium, the unrealized P&L and the current
risk. Valid bids are remembered as the *last valid exit*. An invalid update (a missing bid) records `DATA_INSUFFICIENT` and **does not overwrite** the last valid exit.

**Phase 1B.2:** monitor prices pass the same manual-price checks as an exit (see "Manual prices (Phase 1B.2)"). An update with a missing, crossed,
ambiguous or too-old price is still recorded, as a `DATA_INSUFFICIENT` snapshot with its reasons, and it **never replaces** the last valid bids (A8).
A quote for an instrument that is not a leg of the trade is refused (`INVALID_REQUEST`) and nothing is recorded (D1).

## Time and freshness (Phase 1B.1)

- The **server clock** is the only trusted time. It is injected into the service (`now`), so tests are deterministic.
- Client times (`asOf` on monitor, exit and safety check) are **untrusted**. When supplied they must be a full timestamp with a zone, must not be
  earlier than the trade's last recorded update (at least the entry snapshot), and must not be later than server time plus the allowed skew. Otherwise the
  request is refused (`INVALID_REQUEST`) and nothing changes.
- A client time that passes validation is **metadata only** (`clientAsOf` on the monitor snapshot, the exit record and the journal event payload).
  `updatedAt`, journal event timestamps, the monitor time and the exit time are **always server time**, including for a refused exit.
- **Server processing time is not a quote-observation time (review correction R4).** Monitor, exit and safety quotes carry no observation time
  of their own. So `exit.timestamp`, `lastMonitor.asOf` and `lastValidExit.asOf` (and `staleReference.asOf`) mean "when the server recorded it",
  and `exit.priceAsOf` (the quote-observation time) is **null: not available**. It is never filled with server or client time. Records written before
  R4 may hold a time in `priceAsOf`; the UI labels it as not a verified quote-observation time. The only per-quote times that exist are the
  user-entry times on entry quotes (`entry.legs[].quoteAsOf`) and, since Phase 1B.2, on monitor, exit and holding-limit prices
  (`legs[].enteredAt` / `legBids[].enteredAt`). None of them is an exchange timestamp, and `priceAsOf` stays null.
- Allowed client-clock tolerance (future skew): **30 seconds** (`TIME_RULES.maxFutureSkewMs`, approved A1 in Phase 1B.2; it was a 5-second default before).
- Quote freshness at confirmation: **60 seconds** (`TIME_RULES.maxQuoteAgeMs`, approved).
- Manual price age for monitor, exit and holding-limit prices: **60 seconds** (`TIME_RULES.maxManualPriceAgeMs`, approved A2 in Phase 1B.2).

## Manual prices (Phase 1B.2)

Every price that values a trade (confirmation, monitor, exit, holding-limit closure) goes through one validation (`resolveTimedQuotes`):

1. A quote for an instrument that is not a leg of the trade is refused with `INVALID_REQUEST`. Another strike, expiry or instrument is never substituted (D1).
2. Each leg needs exactly one unambiguous quote with a valid **bid and ask** (both positive, ask not below bid; the unchanged Phase 1A rule).
   A missing leg, conflicting duplicates or a non-executable quote gives `DATA_INSUFFICIENT`. LTP and theoretical prices are never used.
3. Each quote needs its own `asOf`: the time **you entered** the price (a full timestamp with a zone). It may be at most **30 s** ahead of server time
   and at most **60 s** old (both inclusive: 30,000 ms and 60,000 ms are accepted; 30,001 ms and 60,001 ms are refused). Otherwise `QUOTE_NOT_FRESH`.

A valuation that passes is labelled **`MANUAL_ENTRY_CHECKED`** (A9) with `priceProvenance: MANUAL_USER_ENTRY`, the rule that was applied
(`valuationRule`) and, per leg, the bid, ask, `enteredAt` and `entryAgeMs`. The exit `basis` stays `CURRENT_QUOTE`: that is a **legacy
basis label**, kept so the journal and export schema do not change. For Phase 1B.2 records the valuation method is identified by
`valuationStatus: MANUAL_ENTRY_CHECKED` together with `priceProvenance: MANUAL_USER_ENTRY`.

> **What `MANUAL_ENTRY_CHECKED` means.** Only that the application's manual-input validation rules passed. The prices were typed by you; the time is
> when you say you entered them. They are **not** exchange-sourced, exchange-timestamped or independently verified, and the application never claims they are.

Records written before Phase 1B.2 are never rewritten. Their old labels (`EXECUTABLE_QUOTE`, `LAST_VALID_MONITOR_BID`, a stored `priceAsOf`) are kept as history
and shown with the price-quality warnings below.

## Price quality and expiry status (derived when read)

Every API response that returns a trade (review, confirm, monitor, exit, safety check, get, list) adds two **derived** fields. They are computed from the
stored record each time it is read and are **never written to the journal** (A10, D2, D3).

- `priceQuality`: `{ level, flags, warnings, note }`. Levels:
  - `MANUAL_ENTRY_CHECKED`: the P&L comes from prices that passed the Phase 1B.2 manual-input checks.
  - `UNVERIFIED_LEGACY`: the P&L comes from prices the current rules did not check (older records), or the record's provenance is incomplete
    (`PROVENANCE_INCOMPLETE`) or does not satisfy the rules (`PROVENANCE_INCONSISTENT`). Ambiguous records are never upgraded.
  - `SUPERSEDED_RULE`: the P&L was produced by a rule that is no longer allowed (an earlier monitored bid, bids typed at expiry, or an action at or after the cutoff).
  - `NO_PRICE`: there is no valid P&L (none was recorded, or the recorded one is `DATA_INSUFFICIENT`).
  - `HISTORICAL_SNAPSHOT` (final review; replaces the M1 use of `NO_PRICE`): the trade is still open, has a recorded valid unrealized P&L,
    and is read at or after its contract's cutoff. The figure is flagged `UNREALIZED_SNAPSHOT_AFTER_CUTOFF`: a historical snapshot recorded by
    the server before the cutoff. It is not a current or executable valuation, not exchange-verified and not realized P&L, and the UI labels it
    that way. Decided by the **server** read time and the approved 15:30 IST cutoff only (never a client time). It is display-only: the expiry
    closure, realized P&L and lifecycle are unchanged.
  - **No stale-age warning before the cutoff** (deliberately deferred): the server time of a monitor update says when it was recorded, not when
    the user observed the prices, and no age threshold has been approved. The UI shows the recording time and says "Exit premium when
    recorded … not refreshed since"; it never says "now".
- `expiryStatus`: `{ status, cutoff, expiryUsed, instrumentCheck, instrumentReasons }`, where status is `BEFORE_CUTOFF`, `EXPIRED_REVIEW` (a review that can no
  longer be confirmed; it stays `PAPER_REVIEW`, A7), `EXPIRED_PENDING_CLOSURE` (open past the cutoff; run the safety check) or `CLOSED`.

**The raw journal export (`GET /export`) is unchanged**: it contains the stored records only, without these derived fields. No enriched export exists.

## Expiry and safety (deterministic; no invented prices)

Expiry and safety are decided on **server time** only. A client `asOf` on the safety check is validated and recorded (`clientAsOf`) but never decides anything,
so a future-dated client time cannot force expiry.

| Rule | Trigger | Result |
|---|---|---|
| Expiry | server time is at or after **15:30 Asia/Kolkata on the expiry date** (Phase 1B.2) | `PAPER_EXPIRED` |
| Holding limit | `completedSessions` ≥ **2** (the frozen forward protocol) | `PAPER_AUTO_CLOSED` |

- Expiry dates are NSE dates, read in **Asia/Kolkata** (IST). The date is computed in that zone, never by cutting the first ten characters off a timestamp,
  so `2026-10-06T22:30:00Z` (04:00 IST on the 7th) counts as the 7th.
- **Phase 1B.2 (A3):** a contract counts as expired from **15:30:00.000 Asia/Kolkata on its expiry date** (inclusive; `2026-10-06` expires at
  `2026-10-06T10:00:00.000Z`). This is a **provisional paper-safety cutoff, not a verified exchange calendar**: it does not account for exchange holidays,
  special sessions or changed market hours. (Phase 1B and 1B.1 treated the whole expiry day as live and expired from 00:00 IST the next day.)
- At or after the cutoff the application refuses to **assess**, **review**, **confirm** (journaled as `CONFIRM_REJECTED_EXPIRED`), **monitor** or **exit**
  (journaled as `EXIT_REJECTED_EXPIRED`) with `CONTRACT_EXPIRED` (HTTP 409) (A6, A12). An open trade must be closed by the safety check. No new lifecycle state exists (A7).
- There is no trading calendar, so `completedSessions` must be **supplied**. If it is not, the holding limit is reported as **not evaluated**. It is never estimated.
- If both apply, expiry wins.
- The lifecycle event is **always recorded**.
- **Phase 1B.2 (A4):** an **expiry** closure is never priced. There is no approved settlement-price source, so it records basis `NONE`,
  `valuationStatus: DATA_INSUFFICIENT` and P&L `DATA_INSUFFICIENT`, even if prices are supplied. No settlement price is invented.
- **At or after the cutoff the server clock alone decides.** Untrusted request metadata cannot block the required expiry closure: an
  unacceptable or malformed client `asOf`, or a quote for an instrument that is not a leg of the trade, is ignored (noted on the exit record,
  never stored as `clientAsOf` and never used for a price). Before the cutoff these are still refused with `INVALID_REQUEST`, and any other
  invalid field (for example a fractional `completedSessions`) is always refused.
- **Phase 1B.2 (A5):** a **holding-limit** closure is priced only from manual prices that pass the checks above (before the cutoff), labelled
  `MANUAL_ENTRY_CHECKED`, with `sessionsSource: USER_PROVIDED`. Otherwise it is unpriced (basis `NONE`, P&L `DATA_INSUFFICIENT`).
- **Phase 1B.1 (D2):** an earlier monitored bid is **never** used as the exit price. If one exists it is kept on the exit record as `staleReference`,
  labelled *historical reference only*, and it is not used for P&L. (Phase 1B priced such closures from it with basis `LAST_VALID_MONITOR_BID`; that basis is no longer produced.)
- Lifecycle state (`PAPER_EXPIRED` / `PAPER_AUTO_CLOSED`), valuation status and P&L status are separate fields.

## Journal events

`REVIEW_STARTED`, `REJECTED_DATA_INSUFFICIENT`, `TRADE_OPENED`, `MONITOR_SNAPSHOT`, `EXIT_REJECTED_DATA_INSUFFICIENT`, `CONFIRM_REJECTED_QUOTE` (Phase 1B.1), `TRADE_EXITED`, `TRADE_EXPIRED`, `TRADE_AUTO_CLOSED`,
and from Phase 1B.2 `CONFIRM_REJECTED_EXPIRED`, `EXIT_REJECTED_EXPIRED` and `EXIT_REJECTED_QUOTE` (an exit price that is too old or future-dated).
Events are append-only with strictly increasing sequence numbers. A refused exit (missing bid) is journaled and the trade stays `PAPER_OPEN`.

## API (all under `/api/paper`; JSON only)

| Method and path | Purpose | Notable refusals |
|---|---|---|
| `POST /assess` | Evaluate a candidate. Stores nothing. | 400 invalid; 409 `CONTRACT_EXPIRED` |
| `POST /review` | Store a `PAPER_REVIEW` trade (201). | 422 `DATA_INSUFFICIENT` (stored as a final record); 409 `CONTRACT_EXPIRED` |
| `POST /trades/:id/confirm` | Open it. Body `{ "confirmed": true, "quotes": [fresh quotes with asOf] }`. | 400 `CONFIRMATION_REQUIRED` / `INVALID_REQUEST` (wrong instrument); 422 `QUOTE_NOT_FRESH` / `DATA_INSUFFICIENT` / `CAPITAL_GATE_FAILED` / `LOTS_UNRESOLVED`; 409 wrong state or `CONTRACT_EXPIRED`; 422 `DATA_INSUFFICIENT` for an older record whose instruments are not `CONSISTENT` (see note below) |
| `POST /trades/:id/monitor` | Record current prices (bid, ask and `asOf` per leg), risk and unrealized P&L. | 400 bad `asOf` / foreign instrument; 409 if not `PAPER_OPEN` or `CONTRACT_EXPIRED`; 422 `DATA_INSUFFICIENT` for an older record whose instruments are not `CONSISTENT` (see note below) |
| `POST /trades/:id/exit` | Exit at checked manual prices (bid, ask and `asOf` per leg). | 400 bad `asOf` / foreign instrument; 409 `CONTRACT_EXPIRED`; 422 `DATA_INSUFFICIENT` / `QUOTE_NOT_FRESH` (trade stays open); 422 `DATA_INSUFFICIENT` for an older record whose instruments are not `CONSISTENT` (see note below) |
| `POST /trades/:id/safety-check` | Apply expiry / holding-limit rules on server time. | 400 bad `asOf` / foreign instrument; 409 if not `PAPER_OPEN` |
| `GET /trades?state=&risk=` | List; `risk` is `ALL`, `LOW`, `MEDIUM` or `HIGH`. | 400 bad filter |
| `GET /trades/:id` | One trade and its events. | 404 |
| `GET /journal?tradeId=` | Events. | |
| `GET /export` | Whole journal as a JSON download. | |

**Older records whose instruments are not `CONSISTENT` (final review).** Confirm, monitor and exit on such a record are refused with HTTP 422
`DATA_INSUFFICIENT`. The request is refused **before** its prices and times are read, and **nothing is written**: no state change and **no
journal event**. This is deliberate, and it differs from refusals that are journaled:

| Refusal | Journal event written |
|---|---|
| Confirm at or after the cutoff (409 `CONTRACT_EXPIRED`) | `CONFIRM_REJECTED_EXPIRED` |
| Confirm with stale, missing or invalid quotes (422 `QUOTE_NOT_FRESH` / `DATA_INSUFFICIENT`) | `CONFIRM_REJECTED_QUOTE` |
| Exit at or after the cutoff (409 `CONTRACT_EXPIRED`) | `EXIT_REJECTED_EXPIRED` |
| Exit with stale or future-dated prices (422 `QUOTE_NOT_FRESH`) | `EXIT_REJECTED_QUOTE` |
| Exit with missing, crossed or ambiguous prices (422 `DATA_INSUFFICIENT`) | `EXIT_REJECTED_DATA_INSUFFICIENT` |
| Monitor at or after the cutoff (409 `CONTRACT_EXPIRED`) | none |
| Confirm, monitor or exit on an older record whose instruments are not `CONSISTENT` (422 `DATA_INSUFFICIENT`) | **none** |

The expiry check runs first, so at or after the cutoff such a record gets 409 `CONTRACT_EXPIRED` (journaled as listed above for confirm and
exit). The safety check is not refused for such a record: it closes it unpriced (see "Instrument identity" above).

There is no route to delete or edit a trade, and **no order, broker, login or authentication route** (a guard test enforces the exact list).

## Persistence

The domain talks only to the `JournalRepository` interface. Phase 1B provides:

- `InMemoryJournalRepository` (tests; no disk).
- `FileJournalRepository` (**backend only**): one JSON file at `data/paper-journal.json` in the repository root. The `data/` folder is git-ignored.

Properties of the file store: every change is written to a temporary file and renamed into place (a failed write leaves both disk and memory unchanged);
operations run one at a time; corrupt or unsupported data is **an error and is never overwritten**; the same rules engine as the in-memory store.

> **Durability warning.** The file store is suitable for **controlled development and paper-trading use** on a machine with a normal, persistent disk.
> It is **not guaranteed durable storage**. It must **not** be relied on on **serverless or ephemeral hosting** (including Bolt-style or similar environments),
> where the filesystem can be reset or discarded between requests. Treat anything held only on such a filesystem as temporary.

### Rollback warning (Phase 1B.2)

Do **not** run an older build (Phase 1B or 1B.1) against a journal written by Phase 1B.2. Older builds do not know the new event types, fields or the
`MANUAL_ENTRY_CHECKED` status and may refuse or misread the file. **Take a JSON export (or copy `data/paper-journal.json`) before any rollback**, and keep it (D7).

### Backups: JSON export

`GET /api/paper/export` (the **Export journal** link on the Paper Trading page, Journal tab) downloads the complete journal (trades, entry snapshots and events) as plain JSON,
stamped with the export time and a durability notice. Take an export regularly. A future store (a database, a hosted store) replaces only
the repository implementation; the paper-trading domain does not change.

## What Phase 1B (including 1B.1 and 1B.2) does not do

No broker, no live market data, no scanner, no calculation of Score / Expected Move / Implied Move / Expected Net Edge, no live orders, no authentication,
no multi-user separation, no automatic paper entry. Legacy `niftyAiTrader.*` storage and old Upstox paper trades are never read or imported.
