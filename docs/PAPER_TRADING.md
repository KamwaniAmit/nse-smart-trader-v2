# Paper Trading (Phase 1B)

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
  user-entry times on entry quotes (`entry.legs[].quoteAsOf`), which are not exchange timestamps either.
- Allowed clock skew: **5 seconds** (`TIME_RULES.maxFutureSkewMs`). This is a DEFAULT engineering value with no source in the specification; it awaits owner review.
- Quote freshness at confirmation: **60 seconds** (`TIME_RULES.maxQuoteAgeMs`, approved).

## Expiry and safety (deterministic; no invented prices)

Expiry and safety are decided on **server time** only. A client `asOf` on the safety check is validated and recorded (`clientAsOf`) but never decides anything,
so a future-dated client time cannot force expiry.

| Rule | Trigger | Result |
|---|---|---|
| Expiry | the server time's calendar **date in Asia/Kolkata** is after the expiry date | `PAPER_EXPIRED` |
| Holding limit | `completedSessions` ≥ **2** (the frozen forward protocol) | `PAPER_AUTO_CLOSED` |

- Expiry dates are NSE dates, read in **Asia/Kolkata** (IST). The date is computed in that zone, never by cutting the first ten characters off a timestamp,
  so `2026-10-06T22:30:00Z` (04:00 IST on the 7th) counts as the 7th.
- The expiry **day itself is not treated as expired**, because market hours (an intraday cutoff) are not configured yet. A contract counts as expired from
  **00:00 Asia/Kolkata on the day after** its expiry date. No holiday or expiry calendar is assumed.
- There is no trading calendar, so `completedSessions` must be **supplied**. If it is not, the holding limit is reported as **not evaluated**. It is never estimated.
- If both apply, expiry wins.
- The lifecycle event is **always recorded**. The exit is valued **only** from valid CE/PE bids supplied in the call (basis `CURRENT_QUOTE`,
  `valuationStatus: EXECUTABLE_QUOTE`). Otherwise there is no exit price: basis `NONE`, `valuationStatus: DATA_INSUFFICIENT`, P&L `DATA_INSUFFICIENT`.
- **Phase 1B.1 (D2):** an earlier monitored bid is **never** used as the exit price. If one exists it is kept on the exit record as `staleReference`,
  labelled *historical reference only*, and it is not used for P&L. (Phase 1B priced such closures from it with basis `LAST_VALID_MONITOR_BID`; that basis is no longer produced.)
- Lifecycle state (`PAPER_EXPIRED` / `PAPER_AUTO_CLOSED`), valuation status and P&L status are separate fields.

## Journal events

`REVIEW_STARTED`, `REJECTED_DATA_INSUFFICIENT`, `TRADE_OPENED`, `MONITOR_SNAPSHOT`, `EXIT_REJECTED_DATA_INSUFFICIENT`, `CONFIRM_REJECTED_QUOTE` (Phase 1B.1), `TRADE_EXITED`, `TRADE_EXPIRED`, `TRADE_AUTO_CLOSED`.
Events are append-only with strictly increasing sequence numbers. A refused exit (missing bid) is journaled and the trade stays `PAPER_OPEN`.

## API (all under `/api/paper`; JSON only)

| Method and path | Purpose | Notable refusals |
|---|---|---|
| `POST /assess` | Evaluate a candidate. Stores nothing. | 400 invalid |
| `POST /review` | Store a `PAPER_REVIEW` trade (201). | 422 `DATA_INSUFFICIENT` (stored as a final record) |
| `POST /trades/:id/confirm` | Open it. Body `{ "confirmed": true, "quotes": [fresh quotes with asOf] }`. | 400 `CONFIRMATION_REQUIRED` / `INVALID_REQUEST` (wrong instrument); 422 `QUOTE_NOT_FRESH` / `DATA_INSUFFICIENT` / `CAPITAL_GATE_FAILED` / `LOTS_UNRESOLVED`; 409 wrong state |
| `POST /trades/:id/monitor` | Record current prices, risk and unrealized P&L. | 400 bad `asOf`; 409 if not `PAPER_OPEN` |
| `POST /trades/:id/exit` | Exit at valid bids. | 400 bad `asOf`; 422 `DATA_INSUFFICIENT` (trade stays open) |
| `POST /trades/:id/safety-check` | Apply expiry / holding-limit rules on server time. | 400 bad `asOf`; 409 if not `PAPER_OPEN` |
| `GET /trades?state=&risk=` | List; `risk` is `ALL`, `LOW`, `MEDIUM` or `HIGH`. | 400 bad filter |
| `GET /trades/:id` | One trade and its events. | 404 |
| `GET /journal?tradeId=` | Events. | |
| `GET /export` | Whole journal as a JSON download. | |

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

### Backups: JSON export

`GET /api/paper/export` (the **Export journal** link on the Paper Trading page, Journal tab) downloads the complete journal (trades, entry snapshots and events) as plain JSON,
stamped with the export time and a durability notice. Take an export regularly. A future store (a database, a hosted store) replaces only
the repository implementation; the paper-trading domain does not change.

## What Phase 1B does not do

No broker, no live market data, no scanner, no calculation of Score / Expected Move / Implied Move / Expected Net Edge, no live orders, no authentication,
no multi-user separation, no automatic paper entry. Legacy `niftyAiTrader.*` storage and old Upstox paper trades are never read or imported.
