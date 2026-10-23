/* global process, console */
// Test-support tool (not run by the test suite). Writes a SYNTHETIC historical journal sample with a BUILT copy of an
// earlier commit, using only that build's public service API and FileJournalRepository, into the given output file.
// Every price, time and id is synthetic; no real journal is read.
//
//   node generate-journal.mjs <repo root built at the commit> <output file> <1d21f06 | b91fa26> [--minify]
//
// Without --minify the output is exactly what that build's FileJournalRepository wrote (its own serializer).
// With --minify that same file is then re-serialized without whitespace (JSON.stringify(JSON.parse(file)) + newline):
// the parsed content and key order are unchanged. The committed samples are the --minify form.
//
// Scenarios are merged so that each sample is as small as possible while still covering every lifecycle state, every
// exit basis and trigger the build can write, every event type it can write, and both entry-snapshot versions.
import { readFile, rm, writeFile } from "node:fs/promises";

const [root, out, variant, option] = process.argv.slice(2);
if (!root || !out || (variant !== "1d21f06" && variant !== "b91fa26") || (option !== undefined && option !== "--minify")) {
  throw new Error("usage: generate-journal.mjs <root> <out> <1d21f06|b91fa26> [--minify]");
}
const legacy = variant === "1d21f06";
const { createPaperTradingService } = await import(`${root}/packages/core/dist/index.js`);
const { FileJournalRepository } = await import(`${root}/apps/api/dist/persistence/FileJournalRepository.js`);
await rm(out, { force: true });

// Explicit, deterministic clock: every call returns the current time, then moves it on by 1 s.
let ms = 0;
const setClock = (iso) => { ms = Date.parse(iso); };
const now = () => { const s = new Date(ms).toISOString(); ms += 1000; return s; };
// Named ids: the candidate becomes cand_<variant>-<label>, the trade pt_<variant>-<label>.
let label = "";
const svc = createPaperTradingService({ repository: new FileJournalRepository({ filePath: out, now }), now, newId: () => `${variant}-${label}` });

const CE = { provider: "manual", id: "NIFTY|2026-10-06|CE|22900" };
const PE = { provider: "manual", id: "NIFTY|2026-10-06|PE|22800" };
const d = { volume: 6000, oi: 12000, bidQty: 6500, askQty: 6500 };
const cand = (over = {}) => ({
  source: "LONG_VOL", marketId: "NIFTY", structure: "STRANGLE", expiry: "2026-10-06", lotSize: 65, asOf: "2026-09-28T10:00:00+05:30",
  legs: [{ optionType: "CE", strike: 22900, quote: { bid: 69.0, ask: 69.8, ...d } }, { optionType: "PE", strike: 22800, quote: { bid: 50.2, ask: 50.95, ...d } }],
  spot: 22831.15, score: 62, expectedMove: 230, impliedMove: 180, expectedNetEdge: 700, iv: 0.15, rv20: 0.12, rvRegime: "RV_ACCELERATING",
  tradingDaysToExpiry: 8, maxCapitalAllocation: 100000, entryCosts: 250, requestedLots: 1, ...over,
});
const q = (c, p) => ({ quotes: [{ instrument: CE, bid: c, ask: c + 0.5, ...d }, { instrument: PE, bid: p, ask: p + 0.5, ...d }] });
const must = (r, what) => { if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r.error)}`); return r.value; };
/** 1d21f06 trusts a client asOf on monitor / exit / safety; b91fa26 uses its server clock and needs none. */
const ev = (iso) => (legacy ? { asOf: iso } : {});
const confirmBody = () => {
  if (legacy) return { confirmed: true };
  const at = new Date(ms).toISOString(); // b91fa26 needs fresh entry quotes, stamped with the clock's current time
  return { confirmed: true, quotes: [{ instrument: CE, bid: 69, ask: 69.8, ...d, asOf: at }, { instrument: PE, bid: 50.2, ask: 50.95, ...d, asOf: at }] };
};
const review = async (name, at, over) => { label = name; setClock(at); return must(await svc.beginReview(cand(over)), `review ${name}`).tradeId; };
const open = async (name, at) => { const id = await review(name, at); must(await svc.confirm(id, confirmBody()), `confirm ${name}`); return id; };

// open: entry snapshot, a VALID monitor snapshot (last valid bids), then an exit REJECTED for a missing bid. Stays open.
const openId = await open("open", "2026-09-28T04:30:00.000Z");
setClock("2026-09-29T04:30:00.000Z"); must(await svc.monitor(openId, { ...q(70, 52), ...ev("2026-09-29T10:00:00+05:30") }), "monitor open");
setClock("2026-09-29T05:00:00.000Z");
const rejected = await svc.exit(openId, { quotes: [{ instrument: CE, bid: 66 }, { instrument: PE, bid: null }], ...ev("2026-09-29T10:30:00+05:30") });
if (rejected.ok) throw new Error("expected the exit to be rejected");
// userExit: USER_EXIT priced from typed bids (1d21f06: priceAsOf = client time; b91fa26: EXECUTABLE_QUOTE, priceAsOf null).
const exitId = await open("userExit", "2026-09-28T05:00:00.000Z");
setClock("2026-09-30T05:30:00.000Z"); must(await svc.exit(exitId, { ...q(66.05, 54), ...ev("2026-09-30T11:00:00+05:30") }), "exit");
// expiryAfterMonitor: monitored, then EXPIRY with no current bids (1d21f06: priced from LAST_VALID_MONITOR_BID; b91fa26: unpriced + staleReference).
const expMonId = await open("expiryAfterMonitor", "2026-09-28T05:30:00.000Z");
setClock("2026-09-30T04:30:00.000Z"); must(await svc.monitor(expMonId, { ...q(66, 53), ...ev("2026-09-30T10:00:00+05:30") }), "monitor expiryAfterMonitor");
setClock("2026-10-07T04:30:00.000Z"); must(await svc.runSafetyCheck(expMonId, { completedSessions: null, ...ev("2026-10-07T10:00:00+05:30") }), "expire after monitor");
// expiryTypedBids: EXPIRY priced from bids typed at closure (both builds allow this; Phase 1B.2 forbids it).
const expTypedId = await open("expiryTypedBids", "2026-09-28T06:00:00.000Z");
setClock("2026-10-07T04:31:00.000Z"); must(await svc.runSafetyCheck(expTypedId, { completedSessions: null, ...q(70, 52), ...ev("2026-10-07T10:01:00+05:30") }), "expire typed");
// holdingLimit: HOLDING_LIMIT closure priced from typed bids, session count typed by the user.
const holdId = await open("holdingLimit", "2026-09-28T06:30:00.000Z");
setClock("2026-10-01T09:30:00.000Z"); must(await svc.runSafetyCheck(holdId, { completedSessions: 2, ...q(66.05, 54), ...ev("2026-10-01T15:00:00+05:30") }), "holding limit");
// review: stays PAPER_REVIEW (b91fa26 also records a confirmation refused for a stale quote: CONFIRM_REJECTED_QUOTE).
const reviewId = await review("review", "2026-09-28T07:00:00.000Z");
if (!legacy) {
  const stale = new Date(ms - 120_000).toISOString();
  const c = await svc.confirm(reviewId, { confirmed: true, quotes: [{ instrument: CE, bid: 69, ask: 69.8, ...d, asOf: stale }, { instrument: PE, bid: 50.2, ask: 50.95, ...d, asOf: stale }] });
  if (c.ok || c.error.code !== "QUOTE_NOT_FRESH") throw new Error("expected QUOTE_NOT_FRESH");
}
// dataInsufficient: candidate with no executable entry (missing CE ask) -> terminal DATA_INSUFFICIENT.
label = "dataInsufficient"; setClock("2026-09-28T07:30:00.000Z");
const di = await svc.beginReview(cand({ legs: [{ optionType: "CE", strike: 22900, quote: { bid: 69.0, ask: null, ...d } }, { optionType: "PE", strike: 22800, quote: { bid: 50.2, ask: 50.95, ...d } }] }));
if (di.ok) throw new Error("expected DATA_INSUFFICIENT");
// openedAfterExpiry: opened on 10 Oct for a 6 Oct contract and exited the same day (both builds allow this).
const lateId = await open("openedAfterExpiry", "2026-10-10T04:30:00.000Z");
setClock("2026-10-10T05:00:00.000Z"); must(await svc.exit(lateId, { ...q(10, 12), ...ev("2026-10-10T10:30:00+05:30") }), "late exit");

if (option === "--minify") await writeFile(out, `${JSON.stringify(JSON.parse(await readFile(out, "utf8")))}\n`, "utf8");
const trades = await svc.listTrades();
console.log(JSON.stringify({ variant, trades: (trades.value ?? trades).map((t) => [t.tradeId, t.state]) }));
