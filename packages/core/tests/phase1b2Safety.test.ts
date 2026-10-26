// Phase 1B.2 regression tests (test-first). Each block maps to an approved rule (A1-A13, D1-D9) and to a confirmed defect
// from the read-only safety review of b91fa26 (HIGH-1 expiry gate, HIGH-2 bid/ask validation, HIGH-3 expiry valuation,
// MEDIUM-1 manual-price timestamps). Written BEFORE the implementation: on b91fa26 most of these fail by design.
//
// Manual prices are typed by the user. Their times are USER-ENTRY times, checked against the server clock. Nothing here
// treats them as exchange timestamps. MANUAL_ENTRY_CHECKED means "the application's manual-input validation rules
// passed"; it never means exchange-sourced, exchange-timestamped or independently verified. No price limit is invented.
//
// Clocks are explicit and deterministic: every test creates its own service (makeService) and passes that service's
// clock time to every price it builds. Boundary inclusivity, pinned below to the millisecond:
//   - future skew:        an entry time up to 30 000 ms AHEAD of server time is accepted; 30 001 ms is refused;
//   - manual-entry age:   a price entered up to 60 000 ms BEFORE server time is accepted; 60 001 ms is refused;
//   - expiry cutoff:      the contract is expired AT and after 15:30:00.000 IST on its expiry date (the cutoff instant
//                         itself is expired); 15:29:59.999 IST is the last moment of normal actions.
import { describe, expect, it } from "vitest";
import type { PaperTradeRecord } from "../src/index.js";
import { EXPIRY_CUTOFF, TIME_RULES, assessPriceQuality, checkInstruments, evaluateSafety } from "../src/index.js";
import { CE_ID, PE_ID, confirmBody, longVolRaw, makeService, opened, reviewed } from "./fixtures.js";
// Historical samples written by the real 1d21f06 and b91fa26 builds (see fixtures/journals/README.md). Read-only.
import journal1d21f06 from "./fixtures/journals/journal-1d21f06.json" with { type: "json" };
import journalB91fa26 from "./fixtures/journals/journal-b91fa26.json" with { type: "json" };

type Res<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: string[]; trade?: PaperTradeRecord } };
const ok = <T>(r: Res<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const err = <T>(r: Res<T>) => {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.value).slice(0, 300)}`);
  return r.error;
};
type Svc = ReturnType<typeof makeService>;
/** ISO time `ms` milliseconds after `iso` (millisecond precision is kept). */
const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const types = async (svc: Svc, id: string) => (await svc.service.listEvents({ tradeId: id })).map((e) => e.type);
// Loose views of fields Phase 1B.2 adds (optional in the stored contract, so older records still load).
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const view = (t: unknown): Any => t as Any;

/** The fixture contract (expiry 2026-10-06) has its provisional paper-safety cutoff at 15:30 IST = 10:00:00.000Z (A3). */
const CUTOFF = "2026-10-06T10:00:00.000Z";
const LAST_MS_BEFORE = "2026-10-06T09:59:59.999Z"; // 15:29:59.999 IST
const FIRST_MS_AFTER = "2026-10-06T10:00:00.001Z"; // 15:30:00.001 IST
const AFTER_CLOSE = "2026-10-06T18:31:00.000Z"; // 00:01 IST on 7 Oct: the review's P7 / P7b probe time

interface QOpts {
  ce?: [number | null, number | null];
  pe?: [number | null, number | null];
  /** Entry time per leg. undefined = the time passed as `now`; null = no entry time sent. */
  ceAt?: string | null;
  peAt?: string | null;
  ceExtra?: Record<string, unknown>;
  peExtra?: Record<string, unknown>;
  more?: Array<Record<string, unknown>>;
}
/**
 * Manually entered monitor / exit / safety prices for the exact legs: bid, ask, depth and a user-entry time.
 * `now` is passed explicitly by the test, normally `svc.clock.peek()` (the time the service reads next: age 0).
 */
const manualAt = (now: string, o: QOpts = {}) => {
  const leg = (instrument: typeof CE_ID, [bid, ask]: [number | null, number | null], at: string | null | undefined, extra: Record<string, unknown> = {}) => ({
    instrument, bid, ask, volume: 7000, oi: 12000, bidQty: 6500, askQty: 6500, ...(at === null ? {} : { asOf: at ?? now }), ...extra,
  });
  return { quotes: [leg(CE_ID, o.ce ?? [66.05, 66.55], o.ceAt, o.ceExtra), leg(PE_ID, o.pe ?? [54, 54.5], o.peAt, o.peExtra), ...(o.more ?? [])] };
};
/** The same prices, all entered `deltaMs` relative to `now` (negative = earlier, positive = ahead of the server). */
const enteredRelative = (now: string, deltaMs: number, o: QOpts = {}) => manualAt(now, { ...o, ceAt: shift(now, deltaMs), peAt: shift(now, deltaMs) });

// ---------------------------------------------------------------------------------------------------------------
describe("A1 / A2: client-clock tolerance and manual-entry age are separate, approved constants", () => {
  it("future-skew tolerance is 30 000 ms (a client-clock tolerance, not exchange-time verification)", () => {
    expect(TIME_RULES.maxFutureSkewMs).toBe(30_000);
  });
  it("monitor / exit / holding-limit prices may be at most 60 000 ms old since manual entry; entry keeps its own 60 000 ms rule", () => {
    expect((TIME_RULES as Any)["maxManualPriceAgeMs"]).toBe(60_000);
    expect(TIME_RULES.maxQuoteAgeMs).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("A1 boundaries: up to 30 000 ms ahead of server time is accepted; 30 001 ms is refused", () => {
  it.each([
    [29_999, true],
    [30_000, true],
    [30_001, false],
  ])("confirmation: entry quotes %i ms ahead -> accepted=%s", async (ahead, accepted) => {
    const svc = makeService();
    const id = await reviewed(svc);
    const body = confirmBody(svc);
    const at = shift(svc.clock.peek(), ahead);
    const r = await svc.service.confirm(id, { ...body, quotes: body.quotes.map((q) => ({ ...q, asOf: at })) });
    if (accepted) expect(ok(r).state).toBe("PAPER_OPEN");
    else expect(err(r).code).toBe("QUOTE_NOT_FRESH");
  });
  it.each([
    [29_999, true],
    [30_000, true],
    [30_001, false],
  ])("exit: manual prices entered %i ms ahead -> accepted=%s", async (ahead, accepted) => {
    const svc = makeService();
    const id = await opened(svc);
    const r = await svc.service.exit(id, enteredRelative(svc.clock.peek(), ahead));
    if (accepted) expect(ok(r).state).toBe("PAPER_EXITED");
    else expect(err(r).code).toBe("QUOTE_NOT_FRESH");
  });
  it.each([
    [29_999, true],
    [30_000, true],
    [30_001, false],
  ])("exit: a client EVENT time %i ms ahead -> accepted=%s", async (ahead, accepted) => {
    const svc = makeService();
    const id = await opened(svc);
    const now = svc.clock.peek();
    const r = await svc.service.exit(id, { ...manualAt(now), asOf: shift(now, ahead) });
    if (accepted) expect(ok(r).state).toBe("PAPER_EXITED");
    else expect(err(r).code).toBe("INVALID_REQUEST");
  });
  it.each([
    [30_000, "VALID"],
    [30_001, "DATA_INSUFFICIENT"],
  ])("monitor: manual prices entered %i ms ahead -> snapshot %s", async (ahead, status) => {
    const svc = makeService();
    const id = await opened(svc);
    expect(ok(await svc.service.monitor(id, enteredRelative(svc.clock.peek(), ahead))).lastMonitor?.dataStatus).toBe(status);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("A2 boundaries: a price entered up to 60 000 ms before server time is accepted; 60 001 ms is refused", () => {
  it.each([
    [59_999, true],
    [60_000, true],
    [60_001, false],
  ])("exit: prices entered %i ms ago -> accepted=%s", async (age, accepted) => {
    const svc = makeService();
    const id = await opened(svc);
    const r = await svc.service.exit(id, enteredRelative(svc.clock.peek(), -age));
    if (accepted) expect(ok(r).state).toBe("PAPER_EXITED");
    else expect(err(r).code).toBe("QUOTE_NOT_FRESH");
  });
  it.each([
    [60_000, "VALID"],
    [60_001, "DATA_INSUFFICIENT"],
  ])("monitor: prices entered %i ms ago -> snapshot %s", async (age, status) => {
    const svc = makeService();
    const id = await opened(svc);
    expect(ok(await svc.service.monitor(id, enteredRelative(svc.clock.peek(), -age))).lastMonitor?.dataStatus).toBe(status);
  });
  it.each([
    [60_000, "VALID"],
    [60_001, "DATA_INSUFFICIENT"],
  ])("holding-limit closure: prices entered %i ms ago -> P&L %s", async (age, status) => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set("2026-10-01T09:30:00.000Z");
    const r = ok(await svc.service.runSafetyCheck(id, { completedSessions: 2, ...enteredRelative(svc.clock.peek(), -age) }));
    expect(r.trade.state).toBe("PAPER_AUTO_CLOSED");
    expect(r.trade.realizedPnl?.status).toBe(status);
  });
  it("confirmation keeps its own (unchanged) entry rule at the same boundary: 60 001 ms is refused", async () => {
    const svc = makeService();
    const id = await reviewed(svc);
    const body = confirmBody(svc);
    const at = shift(svc.clock.peek(), -60_001);
    expect(err(await svc.service.confirm(id, { ...body, quotes: body.quotes.map((q) => ({ ...q, asOf: at })) })).code).toBe("QUOTE_NOT_FRESH");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("A3: provisional paper-safety cutoff at 15:30 Asia/Kolkata on the user-supplied expiry date", () => {
  it("is documented as provisional: not a verified exchange calendar; no holidays or special sessions", () => {
    expect(EXPIRY_CUTOFF).toMatchObject({ timeZone: "Asia/Kolkata", localTime: "15:30" });
    const note = String((EXPIRY_CUTOFF as Any)["note"]);
    expect(note).toMatch(/not a verified exchange calendar/i);
    expect(note).toMatch(/holiday/i);
    expect(note).toMatch(/special session/i);
  });

  const base = { expiry: "2026-10-06", completedSessions: null as number | null };
  it.each([
    [LAST_MS_BEFORE, "NONE"], // 15:29:59.999 IST
    [CUTOFF, "EXPIRE"], // 15:30:00.000 IST: the cutoff instant is itself expired
    [FIRST_MS_AFTER, "EXPIRE"], // 15:30:00.001 IST
    ["2026-10-06T15:29:59.999+05:30", "NONE"], // the same boundary written in IST
    ["2026-10-06T15:30:00.000+05:30", "EXPIRE"],
    ["2026-10-06T10:00:00+05:30", "NONE"], // expiry day, morning
    ["2026-10-06T04:30:00Z", "NONE"], // a UTC time whose IST time (10:00) is before the cutoff
    ["2026-10-05T23:00:00Z", "NONE"], // 04:30 IST on the expiry day
    ["2026-10-06T18:29:59Z", "EXPIRE"], // 23:59:59 IST on the expiry day (was NONE under 1B.1)
    ["2026-10-07T01:00:00+09:00", "EXPIRE"], // 21:30 IST on the expiry day (was NONE under 1B.1)
  ])("evaluateSafety at %s -> %s", (asOf, action) => expect(evaluateSafety({ ...base, asOf }).action).toBe(action));

  it("EXPIRE wins over the holding limit at the cutoff", () => {
    expect(evaluateSafety({ ...base, asOf: CUTOFF, completedSessions: 5 }).action).toBe("EXPIRE");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("HIGH-1 / A6 / A12: nothing normal happens at or after the cutoff (one millisecond each side)", () => {
  it.each([
    [LAST_MS_BEFORE, true],
    [CUTOFF, false],
    [FIRST_MS_AFTER, false],
  ])("assess at %s -> allowed=%s", (at, allowed) => {
    const svc = makeService(at);
    const r = svc.service.assess(longVolRaw());
    if (allowed) expect(ok(r).state).toBe("CANDIDATE");
    else expect(err(r).code).toBe("CONTRACT_EXPIRED");
  });

  it.each([
    [LAST_MS_BEFORE, true],
    [CUTOFF, false],
    [FIRST_MS_AFTER, false],
  ])("review at %s -> allowed=%s (a refusal stores nothing and journals nothing)", async (at, allowed) => {
    const svc = makeService(at);
    const r = await svc.service.beginReview(longVolRaw());
    if (allowed) {
      expect(ok(r).state).toBe("PAPER_REVIEW");
    } else {
      expect(err(r).code).toBe("CONTRACT_EXPIRED");
      expect(await svc.service.listTrades()).toHaveLength(0);
      expect(await svc.service.listEvents()).toHaveLength(0);
    }
  });

  it("probe Q1: a contract that expired 14 days ago cannot be reviewed", async () => {
    const svc = makeService("2026-10-20T04:30:00.000Z");
    expect(err(await svc.service.beginReview(longVolRaw())).code).toBe("CONTRACT_EXPIRED");
  });

  it.each([
    [LAST_MS_BEFORE, true],
    [CUTOFF, false],
    [FIRST_MS_AFTER, false],
  ])("confirm at %s with otherwise valid fresh quotes -> allowed=%s", async (at, allowed) => {
    const svc = makeService();
    const id = await reviewed(svc);
    svc.clock.set(at);
    const r = await svc.service.confirm(id, confirmBody(svc));
    if (allowed) {
      expect(ok(r).state).toBe("PAPER_OPEN");
    } else {
      expect(err(r).code).toBe("CONTRACT_EXPIRED");
      const t = ok(await svc.service.getTrade(id)).trade;
      expect([t.state, t.entry]).toEqual(["PAPER_REVIEW", null]);
      expect((await types(svc, id)).at(-1)).toBe("CONFIRM_REJECTED_EXPIRED");
    }
  });

  it.each([
    [LAST_MS_BEFORE, true],
    [CUTOFF, false],
    [FIRST_MS_AFTER, false],
  ])("monitor at %s -> allowed=%s (a refusal leaves the snapshot and the journal unchanged)", async (at, allowed) => {
    const svc = makeService();
    const id = await opened(svc);
    const before = ok(await svc.service.monitor(id, manualAt(svc.clock.peek())));
    const eventsBefore = await types(svc, id);
    svc.clock.set(at);
    const r = await svc.service.monitor(id, manualAt(svc.clock.peek()));
    if (allowed) {
      expect(ok(r).lastMonitor?.dataStatus).toBe("VALID");
    } else {
      expect(err(r).code).toBe("CONTRACT_EXPIRED");
      expect(ok(await svc.service.getTrade(id)).trade.lastMonitor).toEqual(before.lastMonitor);
      expect(await types(svc, id)).toEqual(eventsBefore);
    }
  });

  it.each([
    [LAST_MS_BEFORE, true],
    [CUTOFF, false],
    [FIRST_MS_AFTER, false],
  ])("exit at %s with valid fresh manual prices -> allowed=%s (a refusal journals EXIT_REJECTED_EXPIRED)", async (at, allowed) => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set(at);
    const r = await svc.service.exit(id, manualAt(svc.clock.peek()));
    if (allowed) {
      expect(ok(r).state).toBe("PAPER_EXITED");
    } else {
      expect(err(r).code).toBe("CONTRACT_EXPIRED");
      const t = ok(await svc.service.getTrade(id)).trade;
      expect([t.state, t.realizedPnl]).toEqual(["PAPER_OPEN", null]);
      expect((await types(svc, id)).at(-1)).toBe("EXIT_REJECTED_EXPIRED");
    }
  });

  it("probes P7 / P7b: at 00:01 IST the day after expiry, monitor and user exit are both refused", async () => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set(AFTER_CLOSE);
    expect(err(await svc.service.monitor(id, manualAt(svc.clock.peek()))).code).toBe("CONTRACT_EXPIRED");
    expect(err(await svc.service.exit(id, manualAt(svc.clock.peek()))).code).toBe("CONTRACT_EXPIRED");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("A7 / D3: expiry status is derived response data, never a lifecycle state or a stored field", () => {
  it("a review is BEFORE_CUTOFF until 15:29:59.999 IST and EXPIRED_REVIEW from 15:30:00.000; its state stays PAPER_REVIEW", async () => {
    const svc = makeService();
    const id = await reviewed(svc);
    svc.clock.set(LAST_MS_BEFORE);
    expect(view(ok(await svc.service.getTrade(id)).trade)["expiryStatus"]).toMatchObject({ status: "BEFORE_CUTOFF" });
    svc.clock.set(CUTOFF);
    const t = view(ok(await svc.service.getTrade(id)).trade);
    expect(t["state"]).toBe("PAPER_REVIEW");
    expect(t["expiryStatus"]).toMatchObject({ status: "EXPIRED_REVIEW" });
    expect(Date.parse(String(t["expiryStatus"]["cutoff"]))).toBe(Date.parse(CUTOFF));
  });

  it("an expired review: confirmation is CONTRACT_EXPIRED; monitor, exit and safety stay INVALID_TRANSITION; nothing changes", async () => {
    const svc = makeService();
    const id = await reviewed(svc);
    svc.clock.set(CUTOFF);
    const before = ok(await svc.service.getTrade(id)).trade;
    expect(err(await svc.service.confirm(id, confirmBody(svc))).code).toBe("CONTRACT_EXPIRED");
    expect(err(await svc.service.monitor(id, manualAt(svc.clock.peek()))).code).toBe("INVALID_TRANSITION");
    expect(err(await svc.service.exit(id, manualAt(svc.clock.peek()))).code).toBe("INVALID_TRANSITION");
    expect(err(await svc.service.runSafetyCheck(id, {})).code).toBe("INVALID_TRANSITION");
    const after = ok(await svc.service.getTrade(id)).trade;
    expect([after.state, after.entry, after.updatedAt]).toEqual(["PAPER_REVIEW", null, before.updatedAt]);
  });

  it("an open trade past the cutoff is EXPIRED_PENDING_CLOSURE until the expiry closure runs, then CLOSED", async () => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set(CUTOFF);
    expect(view(ok(await svc.service.getTrade(id)).trade)["expiryStatus"]).toMatchObject({ status: "EXPIRED_PENDING_CLOSURE" });
    ok(await svc.service.runSafetyCheck(id, {}));
    expect(view(ok(await svc.service.getTrade(id)).trade)["expiryStatus"]).toMatchObject({ status: "CLOSED" });
  });

  it("D2: monitor and exit responses carry priceQuality and expiryStatus", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const m = view(ok(await svc.service.monitor(id, manualAt(svc.clock.peek()))));
    expect(m["priceQuality"]).toBeDefined();
    expect(m["expiryStatus"]).toMatchObject({ status: "BEFORE_CUTOFF" });
    const x = view(ok(await svc.service.exit(id, manualAt(svc.clock.peek()))));
    expect(x["priceQuality"]).toMatchObject({ level: "MANUAL_ENTRY_CHECKED" });
    expect(x["expiryStatus"]).toMatchObject({ status: "CLOSED" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("HIGH-3 / A4: an expiry closure is never priced from typed bids", () => {
  it("at the cutoff, valid fresh typed bids are NOT used: basis NONE, valuation and P&L DATA_INSUFFICIENT", async () => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set(CUTOFF);
    const r = ok(await svc.service.runSafetyCheck(id, manualAt(svc.clock.peek())));
    expect(r.decision.action).toBe("EXPIRE");
    expect(r.trade.state).toBe("PAPER_EXPIRED");
    expect(r.trade.exit).toMatchObject({ trigger: "EXPIRY", basis: "NONE", exitPremium: null, valuationStatus: "DATA_INSUFFICIENT", priceProvenance: "NONE" });
    expect(r.trade.exit?.legBids.every((b) => b.bid === null)).toBe(true);
    expect(r.trade.realizedPnl).toMatchObject({ status: "DATA_INSUFFICIENT", grossPnl: null, netPnl: null });
    const notes = r.trade.exit?.notes.join(" ") ?? "";
    expect(notes).toMatch(/no approved settlement-price source/i);
    expect(notes).toMatch(/supplied prices were not used/i);
  });

  it("an earlier valid monitor update is kept as reference only (D2 behaviour), now at the cutoff", async () => {
    const svc = makeService();
    const id = await opened(svc);
    ok(await svc.service.monitor(id, manualAt(svc.clock.peek())));
    svc.clock.set(CUTOFF);
    const r = ok(await svc.service.runSafetyCheck(id, {}));
    expect(r.trade.exit).toMatchObject({ basis: "NONE", exitPremium: null, valuationStatus: "DATA_INSUFFICIENT" });
    expect(r.trade.exit?.staleReference?.exitPremium).toBe(120.05);
  });

  it("EXPIRE wins over a typed holding-limit count at the cutoff, and is still unpriced", async () => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set(CUTOFF);
    const r = ok(await svc.service.runSafetyCheck(id, { completedSessions: 2, ...manualAt(svc.clock.peek()) }));
    expect(r.trade.state).toBe("PAPER_EXPIRED");
    expect(r.trade.realizedPnl?.status).toBe("DATA_INSUFFICIENT");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Safety-review correction: at or after the cutoff the SERVER clock decides. Untrusted request metadata (client asOf,
// a quote for another instrument) can never block the required unpriced expiry closure, and is never used for a price.
describe("Safety-review correction: expiry closure takes precedence over untrusted request metadata", () => {
  const unpricedExpiry = (t: PaperTradeRecord) => {
    expect(t.state).toBe("PAPER_EXPIRED");
    expect(t.exit).toMatchObject({ trigger: "EXPIRY", basis: "NONE", exitPremium: null, valuationStatus: "DATA_INSUFFICIENT", priceProvenance: "NONE" });
    expect(t.exit?.legBids.every((b) => b.bid === null)).toBe(true);
    expect(t.realizedPnl).toMatchObject({ status: "DATA_INSUFFICIENT", grossPnl: null, netPnl: null });
  };
  const foreignQuote = (at: string) => ({ instrument: { provider: "manual", id: "NIFTY|2026-10-06|CE|25000" }, bid: 1, ask: 1.5, asOf: at });
  // [name, asOf built from the server time the check will read, how it is refused BEFORE the cutoff]
  const badAsOf: Array<[string, (now: string) => unknown, string]> = [
    ["malformed text", () => "not a date", "The request is not valid."],
    ["a date without a time or zone", () => "2026-10-06", "The request is not valid."],
    ["a number", () => 1_790_000_000_000, "The request is not valid."],
    ["30 001 ms ahead of server time", (now) => shift(now, 30_001), "The client time (asOf) is not acceptable"],
    ["earlier than the trade's entry", () => "2026-09-01T00:00:00Z", "The client time (asOf) is not acceptable"],
  ];

  it.each(badAsOf)("at the cutoff, a client asOf that is %s does not prevent the unpriced expiry closure", async (_n, asOf) => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set(CUTOFF);
    const r = ok(await svc.service.runSafetyCheck(id, { asOf: asOf(CUTOFF) }));
    expect(r.decision.action).toBe("EXPIRE");
    unpricedExpiry(r.trade);
    expect(r.trade.exit?.notes.join(" ")).toMatch(/client time \(asOf\) was not acceptable and was ignored/);
    expect(r.trade.exit).not.toHaveProperty("clientAsOf");
    const events = (await svc.service.listEvents({ tradeId: id })).filter((e) => e.type === "TRADE_EXPIRED");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).not.toHaveProperty("clientAsOf"); // an unacceptable time is never recorded as metadata
    expect(Date.parse(String(events[0]?.timestamp))).toBe(Date.parse(CUTOFF)); // the event time is server time
  });

  it.each([
    ["only a foreign quote", (now: string) => ({ quotes: [foreignQuote(now)] })],
    ["valid prices for the legs plus a foreign quote", (now: string) => manualAt(now, { more: [foreignQuote(now)] })],
  ])("at the cutoff, %s does not prevent the expiry closure and no supplied price is used", async (_n, body) => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set(FIRST_MS_AFTER);
    const r = ok(await svc.service.runSafetyCheck(id, body(FIRST_MS_AFTER)));
    unpricedExpiry(r.trade);
    const notes = r.trade.exit?.notes.join(" ") ?? "";
    expect(notes).toMatch(/not legs of this trade were ignored/);
    expect(notes).toMatch(/supplied prices were not used/i);
  });

  it("expiry still wins over a holding-limit count, even with an unacceptable asOf and a foreign quote", async () => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set(CUTOFF);
    const r = ok(await svc.service.runSafetyCheck(id, { asOf: "not a date", completedSessions: 5, ...manualAt(CUTOFF, { more: [foreignQuote(CUTOFF)] }) }));
    expect(r.decision.action).toBe("EXPIRE");
    unpricedExpiry(r.trade);
    expect(r.trade.exit).not.toHaveProperty("sessionsSource");
    expect(await types(svc, id)).toContain("TRADE_EXPIRED");
    expect(await types(svc, id)).not.toContain("TRADE_AUTO_CLOSED");
  });

  it("a valid client asOf at the cutoff is still recorded as clientAsOf metadata (unchanged)", async () => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set(CUTOFF);
    unpricedExpiry(ok(await svc.service.runSafetyCheck(id, { asOf: CUTOFF })).trade);
    const ev = (await svc.service.listEvents({ tradeId: id })).find((e) => e.type === "TRADE_EXPIRED");
    expect(ev?.payload).toMatchObject({ clientAsOf: CUTOFF });
  });

  it("other invalid fields are still refused at the cutoff (no broad bypass): fractional completedSessions with a bad asOf", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const before = ok(await svc.service.getTrade(id)).events;
    svc.clock.set(CUTOFF);
    const e = err(await svc.service.runSafetyCheck(id, { asOf: "not a date", completedSessions: 1.5 }));
    expect(e.code).toBe("INVALID_REQUEST");
    const after = ok(await svc.service.getTrade(id));
    expect(after.trade.state).toBe("PAPER_OPEN");
    expect(after.events).toEqual(before);
  });

  it.each(badAsOf)("BEFORE the cutoff, a client asOf that is %s is still refused (INVALID_REQUEST) and nothing changes", async (_n, asOf, message) => {
    const svc = makeService();
    const id = await opened(svc);
    const before = ok(await svc.service.getTrade(id)).events;
    svc.clock.set(LAST_MS_BEFORE);
    const e = err(await svc.service.runSafetyCheck(id, { asOf: asOf(LAST_MS_BEFORE), completedSessions: 2, ...manualAt(LAST_MS_BEFORE) }));
    expect(e.code).toBe("INVALID_REQUEST");
    expect(e.message).toContain(message);
    const after = ok(await svc.service.getTrade(id));
    expect(after.trade.state).toBe("PAPER_OPEN");
    expect(after.events).toEqual(before);
  });

  it("BEFORE the cutoff, a foreign quote on a safety check is still INVALID_REQUEST and nothing changes", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const before = ok(await svc.service.getTrade(id)).events;
    svc.clock.set(LAST_MS_BEFORE);
    const e = err(await svc.service.runSafetyCheck(id, { quotes: [foreignQuote(LAST_MS_BEFORE)] }));
    expect(e.code).toBe("INVALID_REQUEST");
    expect(e.details?.join(" ")).toMatch(/not a leg of this trade/);
    const after = ok(await svc.service.getTrade(id));
    expect(after.trade.state).toBe("PAPER_OPEN");
    expect(after.events).toEqual(before);
  });

  it("a malformed asOf is still INVALID_REQUEST for a trade that is not open or does not exist (parse-error precedence unchanged)", async () => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set(CUTOFF);
    ok(await svc.service.runSafetyCheck(id, {}));
    expect(err(await svc.service.runSafetyCheck(id, { asOf: "not a date" })).code).toBe("INVALID_REQUEST");
    expect(err(await svc.service.runSafetyCheck("pt_missing", { asOf: "not a date" })).code).toBe("INVALID_REQUEST");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("MEDIUM-1 / A2: manual-entry times on exit are required and checked", () => {
  it("an exit quote with no entry time is QUOTE_NOT_FRESH; the trade stays open; EXIT_REJECTED_QUOTE journaled", async () => {
    const svc = makeService();
    const id = await opened(svc);
    expect(err(await svc.service.exit(id, manualAt(svc.clock.peek(), { ceAt: null, peAt: null }))).code).toBe("QUOTE_NOT_FRESH");
    expect(ok(await svc.service.getTrade(id)).trade.state).toBe("PAPER_OPEN");
    expect((await types(svc, id)).at(-1)).toBe("EXIT_REJECTED_QUOTE");
  });

  it("one stale leg (60 001 ms) is enough to refuse the exit", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const now = svc.clock.peek();
    expect(err(await svc.service.exit(id, manualAt(now, { peAt: shift(now, -60_001) }))).code).toBe("QUOTE_NOT_FRESH");
  });

  it("probe P1: prices entered 5 days earlier are refused", async () => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set("2026-10-01T04:30:00.000Z");
    const old = "2026-09-26T10:00:00+05:30";
    expect(err(await svc.service.exit(id, manualAt(svc.clock.peek(), { ceAt: old, peAt: old }))).code).toBe("QUOTE_NOT_FRESH");
  });

  it.each([["2026-10-01"], ["2026-10-01T10:00:00"], ["2026-02-30T10:00:00Z"], ["yesterday"]])("an ambiguous or invalid entry time %s is QUOTE_NOT_FRESH", async (bad) => {
    const svc = makeService();
    const id = await opened(svc);
    expect(err(await svc.service.exit(id, manualAt(svc.clock.peek(), { ceAt: bad }))).code).toBe("QUOTE_NOT_FRESH");
  });

  it("the exit record keeps per-leg bid, ask, entry time and age, provenance and the rule applied; timestamp is server time", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const serverAt = svc.clock.peek();
    const enteredAt = shift(serverAt, -20_000);
    const t = ok(await svc.service.exit(id, manualAt(serverAt, { ceAt: enteredAt, peAt: enteredAt })));
    const exit = view(t.exit);
    expect(exit).toMatchObject({ trigger: "USER_EXIT", basis: "CURRENT_QUOTE", timestamp: serverAt, priceAsOf: null, valuationStatus: "MANUAL_ENTRY_CHECKED", priceProvenance: "MANUAL_USER_ENTRY", exitPremium: 120.05 });
    expect(exit["legBids"]).toEqual([
      { instrument: CE_ID, bid: 66.05, ask: 66.55, enteredAt, entryAgeMs: 20_000 },
      { instrument: PE_ID, bid: 54, ask: 54.5, enteredAt, entryAgeMs: 20_000 },
    ]);
    expect(exit["valuationRule"]).toMatchObject({ maxManualPriceAgeMs: 60_000, maxFutureSkewMs: 30_000, evaluatedAt: serverAt });
    expect(Date.parse(String(exit["valuationRule"]["expiryCutoff"]))).toBe(Date.parse(CUTOFF));
    expect(t.realizedPnl).toMatchObject({ status: "VALID", grossPnl: -45.5 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("HIGH-2: exit prices pass the same bid/ask rule as entry", () => {
  it("probe P2: a crossed CE quote (bid 660.5 > ask 66.55) is refused; the trade stays open; no P&L", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const e = err(await svc.service.exit(id, manualAt(svc.clock.peek(), { ce: [660.5, 66.55] })));
    expect(e.code).toBe("DATA_INSUFFICIENT");
    expect(e.details?.join(" ")).toMatch(/CROSSED_MARKET/);
    const t = ok(await svc.service.getTrade(id)).trade;
    expect([t.state, t.realizedPnl]).toEqual(["PAPER_OPEN", null]);
    expect((await types(svc, id)).at(-1)).toBe("EXIT_REJECTED_DATA_INSUFFICIENT");
  });

  it.each([
    ["no ask", [66.05, null], "INVALID_ASK"],
    ["zero ask", [66.05, 0], "INVALID_ASK"],
    ["negative ask", [66.05, -1], "INVALID_ASK"],
    ["zero bid", [0, 66.55], "INVALID_BID"],
  ] as const)("probe P3 family: %s on the CE leg is refused (%s)", async (_n, ce, reason) => {
    const svc = makeService();
    const id = await opened(svc);
    const e = err(await svc.service.exit(id, manualAt(svc.clock.peek(), { ce: [...ce] as [number | null, number | null] })));
    expect(e.code).toBe("DATA_INSUFFICIENT");
    expect(e.details?.join(" ")).toContain(reason);
  });

  it("bid equal to ask is accepted (zero spread is not crossed)", async () => {
    const svc = makeService();
    const id = await opened(svc);
    expect(ok(await svc.service.exit(id, manualAt(svc.clock.peek(), { ce: [66.05, 66.05] }))).state).toBe("PAPER_EXITED");
  });

  it.each([
    ["valid", [66.05, 66.55], true],
    ["crossed", [70, 69.8], false],
    ["missing ask", [66.05, null], false],
    ["zero bid", [0, 1], false],
    ["equal", [66.05, 66.05], true],
  ] as const)("the same %s quote gets the same verdict at confirmation and at exit", async (_n, ce, valid) => {
    const svcA = makeService();
    const idA = await reviewed(svcA);
    const body = confirmBody(svcA);
    const conf = await svcA.service.confirm(idA, { ...body, quotes: body.quotes.map((q, i) => (i === 0 ? { ...q, bid: ce[0], ask: ce[1] } : q)) });
    const svcB = makeService();
    const idB = await opened(svcB);
    const exit = await svcB.service.exit(idB, manualAt(svcB.clock.peek(), { ce: [...ce] as [number | null, number | null] }));
    expect([conf.ok, exit.ok]).toEqual([valid, valid]);
  });

  it("policy 4: no invented price limit. A very large but well-formed bid/ask is not rejected for its size", async () => {
    const svc = makeService();
    const id = await opened(svc);
    expect(ok(await svc.service.exit(id, manualAt(svc.clock.peek(), { ce: [10_000_000, 10_000_000.5] }))).state).toBe("PAPER_EXITED");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("D1: duplicate and foreign quotes on monitor, exit and safety", () => {
  it.each([
    ["ask", { ask: 99 }],
    ["ask quantity", { askQty: 1 }],
    ["bid quantity", { bidQty: 1 }],
    ["volume", { volume: 1 }],
    ["open interest", { oi: 1 }],
    ["LTP", { ltp: 1 }],
    ["entry time", { asOf: "2026-09-28T09:59:58.000Z" }],
  ])("an exit with a duplicate CE quote that differs only in %s is refused as ambiguous", async (_n, diff) => {
    const svc = makeService();
    const id = await opened(svc);
    const body = manualAt(svc.clock.peek());
    const e = err(await svc.service.exit(id, { quotes: [...body.quotes, { ...body.quotes[0], ...diff }] }));
    expect(e.code).toBe("DATA_INSUFFICIENT");
    expect(e.details?.join(" ")).toMatch(/conflicting/);
  });

  it("an identical duplicate is accepted", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const body = manualAt(svc.clock.peek());
    expect(ok(await svc.service.exit(id, { quotes: [...body.quotes, { ...body.quotes[0] }] })).state).toBe("PAPER_EXITED");
  });

  const foreign = (at: string) => ({ instrument: { provider: "manual", id: "NIFTY|2026-10-06|CE|25000" }, bid: 1, ask: 1.5, asOf: at });
  it.each([
    ["monitor", (svc: Svc, id: string) => svc.service.monitor(id, manualAt(svc.clock.peek(), { more: [foreign(svc.clock.peek())] }))],
    ["exit", (svc: Svc, id: string) => svc.service.exit(id, manualAt(svc.clock.peek(), { more: [foreign(svc.clock.peek())] }))],
    ["holding-limit safety check", (svc: Svc, id: string) => svc.service.runSafetyCheck(id, { completedSessions: 2, ...manualAt(svc.clock.peek(), { more: [foreign(svc.clock.peek())] }) })],
  ])("probe P5: a quote for another instrument on %s is INVALID_REQUEST and changes nothing", async (_n, act) => {
    const svc = makeService();
    const id = await opened(svc);
    const before = ok(await svc.service.getTrade(id));
    expect(err((await act(svc, id)) as Res<unknown>).code).toBe("INVALID_REQUEST");
    const after = ok(await svc.service.getTrade(id));
    expect(after.trade.state).toBe("PAPER_OPEN");
    expect(after.events).toEqual(before.events);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("A8: a bad monitor quote gives a DATA_INSUFFICIENT snapshot and never replaces the last valid bids", () => {
  const scenarios: Array<[string, (now: string) => QOpts]> = [
    ["a crossed quote", () => ({ ce: [70, 69] })],
    ["a missing ask", () => ({ ce: [66.05, null] })],
    ["prices entered 60 001 ms ago", (now) => ({ ceAt: shift(now, -60_001), peAt: shift(now, -60_001) })],
    ["no entry time", () => ({ ceAt: null, peAt: null })],
    ["an entry time 30 001 ms ahead", (now) => ({ ceAt: shift(now, 30_001) })],
  ];
  it.each(scenarios)("%s", async (_n, opts) => {
    const svc = makeService();
    const id = await opened(svc);
    const good = ok(await svc.service.monitor(id, manualAt(svc.clock.peek())));
    expect(good.lastValidExit?.exitPremium).toBe(120.05);
    const now = svc.clock.peek();
    const bad = ok(await svc.service.monitor(id, manualAt(now, { ce: [70, 70.5], pe: [60, 60.5], ...opts(now) })));
    expect(bad.lastMonitor?.dataStatus).toBe("DATA_INSUFFICIENT");
    expect(bad.lastMonitor?.unrealized.status).toBe("DATA_INSUFFICIENT");
    expect(bad.lastValidExit).toEqual(good.lastValidExit);
  });

  it("conflicting duplicates on monitor are DATA_INSUFFICIENT, never 'first copy wins' (probe P6b)", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const body = manualAt(svc.clock.peek());
    const m = ok(await svc.service.monitor(id, { quotes: [...body.quotes, { ...body.quotes[0], ask: 99, volume: 1 }] }));
    expect(m.lastMonitor?.dataStatus).toBe("DATA_INSUFFICIENT");
    expect(m.lastValidExit).toBeNull();
  });

  it("a valid monitor update records provenance, per-leg entry time and age; the last valid bids say so too", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const now = svc.clock.peek();
    const enteredAt = shift(now, -10_000);
    const m = ok(await svc.service.monitor(id, manualAt(now, { ceAt: enteredAt, peAt: enteredAt })));
    const lm = view(m.lastMonitor);
    expect(lm["dataStatus"]).toBe("VALID");
    expect(lm["priceProvenance"]).toBe("MANUAL_USER_ENTRY");
    expect(lm["legs"][0]).toMatchObject({ instrument: CE_ID, bid: 66.05, ask: 66.55, enteredAt, entryAgeMs: 10_000 });
    expect(view(m.lastValidExit)["priceProvenance"]).toBe("MANUAL_USER_ENTRY");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("A5 / A9: holding-limit closure (session count typed by the user; no trading calendar)", () => {
  it("before the cutoff with checked fresh manual prices: priced, MANUAL_ENTRY_CHECKED, sessionsSource USER_PROVIDED", async () => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set("2026-10-01T09:30:00.000Z");
    const r = ok(await svc.service.runSafetyCheck(id, { completedSessions: 2, ...manualAt(svc.clock.peek()) }));
    expect(r.trade.state).toBe("PAPER_AUTO_CLOSED");
    expect(r.trade.exit).toMatchObject({ trigger: "HOLDING_LIMIT", basis: "CURRENT_QUOTE", valuationStatus: "MANUAL_ENTRY_CHECKED", priceProvenance: "MANUAL_USER_ENTRY", sessionsSource: "USER_PROVIDED", exitPremium: 120.05 });
    expect(r.trade.realizedPnl).toMatchObject({ status: "VALID", grossPnl: -45.5 });
  });

  it.each<[string, ((now: string) => QOpts) | null]>([
    ["stale prices (120 s)", (now) => ({ ceAt: shift(now, -120_000), peAt: shift(now, -120_000) })],
    ["a crossed quote", () => ({ ce: [70, 69] })],
    ["no prices at all", null],
  ])("with %s the trade still closes, unpriced (basis NONE, DATA_INSUFFICIENT), session count still USER_PROVIDED", async (_n, opts) => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set("2026-10-01T09:30:00.000Z");
    const now = svc.clock.peek();
    const r = ok(await svc.service.runSafetyCheck(id, { completedSessions: 2, ...(opts === null ? {} : manualAt(now, opts(now))) }));
    expect(r.trade.state).toBe("PAPER_AUTO_CLOSED");
    expect(r.trade.exit).toMatchObject({ basis: "NONE", exitPremium: null, valuationStatus: "DATA_INSUFFICIENT", sessionsSource: "USER_PROVIDED" });
    expect(r.trade.realizedPnl?.status).toBe("DATA_INSUFFICIENT");
  });

  it("A9: a user exit from checked manual prices is labelled MANUAL_ENTRY_CHECKED, never EXECUTABLE_QUOTE", async () => {
    const svc = makeService();
    const id = await opened(svc);
    expect(ok(await svc.service.exit(id, manualAt(svc.clock.peek()))).exit?.valuationStatus).toBe("MANUAL_ENTRY_CHECKED");
  });
});

// ---------------------------------------------------------------------------------------------------------------
const SAMPLES: Record<string, unknown> = { "journal-1d21f06.json": journal1d21f06, "journal-b91fa26.json": journalB91fa26 };
/** A deep copy of a sample's trades, so a test can never change the shared fixture object. */
const sample = (name: string): Record<string, PaperTradeRecord> =>
  (JSON.parse(JSON.stringify(SAMPLES[name])) as { trades: Record<string, PaperTradeRecord> }).trades;
const allSampleTrades = (): PaperTradeRecord[] => [...Object.values(sample("journal-1d21f06.json")), ...Object.values(sample("journal-b91fa26.json"))];
/** Text that would CLAIM exchange sourcing, exchange timestamps or independent verification (a negated mention is fine). */
const CLAIMS_VERIFICATION = /\b(?<!not )(?<!never )(exchange[- ](verified|sourced|timestamped)|verified by the exchange|independently verified)\b/i;

describe("A10 / D4: derived priceQuality (computed when read; stored records are never rewritten)", () => {
  // [trade id, expected level, flags that must be present]
  const phase1B: Array<[string, string, string[]]> = [
    ["pt_1d21f06-open", "UNVERIFIED_LEGACY", ["LEGACY_ENTRY_SNAPSHOT_V1", "UNREALIZED_FROM_UNCHECKED_MONITOR"]],
    ["pt_1d21f06-userExit", "UNVERIFIED_LEGACY", ["LEGACY_ENTRY_SNAPSHOT_V1", "ASK_AND_PRICE_AGE_NOT_CHECKED", "UNVERIFIED_PRICE_TIME"]],
    ["pt_1d21f06-expiryAfterMonitor", "SUPERSEDED_RULE", ["PRICED_FROM_EARLIER_MONITOR_BID", "UNVERIFIED_PRICE_TIME"]],
    ["pt_1d21f06-expiryTypedBids", "SUPERSEDED_RULE", ["EXPIRY_PRICED_FROM_TYPED_BIDS"]],
    ["pt_1d21f06-holdingLimit", "UNVERIFIED_LEGACY", ["ASK_AND_PRICE_AGE_NOT_CHECKED", "SESSION_COUNT_USER_PROVIDED"]],
    ["pt_1d21f06-review", "NO_PRICE", []],
    ["pt_1d21f06-dataInsufficient", "NO_PRICE", []],
    ["pt_1d21f06-openedAfterExpiry", "SUPERSEDED_RULE", ["ACTION_AFTER_EXPIRY_CUTOFF", "ASK_AND_PRICE_AGE_NOT_CHECKED"]],
  ];
  const phase1B1: Array<[string, string, string[]]> = [
    ["pt_b91fa26-open", "UNVERIFIED_LEGACY", ["UNREALIZED_FROM_UNCHECKED_MONITOR"]],
    ["pt_b91fa26-userExit", "UNVERIFIED_LEGACY", ["ASK_AND_PRICE_AGE_NOT_CHECKED"]],
    ["pt_b91fa26-expiryAfterMonitor", "NO_PRICE", []],
    ["pt_b91fa26-expiryTypedBids", "SUPERSEDED_RULE", ["EXPIRY_PRICED_FROM_TYPED_BIDS"]],
    ["pt_b91fa26-holdingLimit", "UNVERIFIED_LEGACY", ["ASK_AND_PRICE_AGE_NOT_CHECKED", "SESSION_COUNT_USER_PROVIDED"]],
    ["pt_b91fa26-review", "NO_PRICE", []],
    ["pt_b91fa26-dataInsufficient", "NO_PRICE", []],
    ["pt_b91fa26-openedAfterExpiry", "SUPERSEDED_RULE", ["ACTION_AFTER_EXPIRY_CUTOFF"]],
  ];
  it.each(phase1B)("1d21f06 sample %s -> %s", (id, level, flags) => {
    const t = sample("journal-1d21f06.json")[id] as PaperTradeRecord;
    const before = JSON.stringify(t);
    const q = assessPriceQuality(t);
    expect(q.level).toBe(level);
    expect(q.flags).toEqual(expect.arrayContaining(flags));
    expect(JSON.stringify(t)).toBe(before); // pure: the record is not modified
  });
  it.each(phase1B1)("b91fa26 sample %s -> %s", (id, level, flags) => {
    const q = assessPriceQuality(sample("journal-b91fa26.json")[id] as PaperTradeRecord);
    expect(q.level).toBe(level);
    expect(q.flags).toEqual(expect.arrayContaining(flags));
  });
  it("every flag has a warning, and no level, note or warning claims exchange sourcing or verification", () => {
    for (const t of allSampleTrades()) {
      const q = assessPriceQuality(t);
      expect(q.warnings).toHaveLength(q.flags.length);
      for (const text of [q.level, q.note, ...q.warnings]) expect(String(text)).not.toMatch(CLAIMS_VERIFICATION);
    }
  });

  // D4: ambiguous or inconsistent records are never upgraded. Timestamps a user typed never imply exchange verification.
  const exited = (): PaperTradeRecord => sample("journal-b91fa26.json")["pt_b91fa26-userExit"] as PaperTradeRecord;
  const ambiguous: Array<[string, (t: Any) => void, string, string[]]> = [
    ["labelled MANUAL_ENTRY_CHECKED but with no provenance or entry times", (t) => { t["exit"]["valuationStatus"] = "MANUAL_ENTRY_CHECKED"; }, "UNVERIFIED_LEGACY", ["PROVENANCE_INCOMPLETE"]],
    ["provenance MANUAL_USER_ENTRY but one leg has no entry time", (t) => {
      Object.assign(t["exit"], { valuationStatus: "MANUAL_ENTRY_CHECKED", priceProvenance: "MANUAL_USER_ENTRY" });
      t["exit"]["legBids"] = [{ ...t["exit"]["legBids"][0], ask: 66.55, enteredAt: "2026-09-30T05:29:50.000Z", entryAgeMs: 10_000 }, { ...t["exit"]["legBids"][1], ask: 54.5 }];
    }, "UNVERIFIED_LEGACY", ["PROVENANCE_INCOMPLETE"]],
    ["a recorded entry age above the 60 000 ms rule", (t) => {
      Object.assign(t["exit"], { valuationStatus: "MANUAL_ENTRY_CHECKED", priceProvenance: "MANUAL_USER_ENTRY" });
      t["exit"]["legBids"] = t["exit"]["legBids"].map((b: Any) => ({ ...b, ask: b["bid"] + 0.5, enteredAt: "2026-09-30T05:28:00.000Z", entryAgeMs: 90_000 }));
    }, "UNVERIFIED_LEGACY", ["PROVENANCE_INCONSISTENT"]],
    ["a non-null priceAsOf and a clientAsOf (user-supplied times)", (t) => { Object.assign(t["exit"], { priceAsOf: "2026-09-30T11:00:00+05:30", clientAsOf: "2026-09-30T11:00:00+05:30" }); }, "UNVERIFIED_LEGACY", ["UNVERIFIED_PRICE_TIME"]],
  ];
  it.each(ambiguous)("an ambiguous exit record: %s -> %s", (_n, mutate, level, flags) => {
    const t = exited() as unknown as Any;
    mutate(t);
    const q = assessPriceQuality(t as unknown as PaperTradeRecord);
    expect(q.level).toBe(level);
    expect(q.flags).toEqual(expect.arrayContaining(flags));
  });

  it("rollback overwrite: last valid bids with provenance but a newer monitor snapshot without it -> unrealized is unverified", () => {
    const t = sample("journal-b91fa26.json")["pt_b91fa26-open"] as unknown as Any;
    t["lastValidExit"]["priceProvenance"] = "MANUAL_USER_ENTRY"; // written by 1B.2 ...
    // ... then an OLDER build wrote a new lastMonitor without provenance (observed with tools/check-rollback.mjs)
    const q = assessPriceQuality(t as unknown as PaperTradeRecord);
    expect(q.level).toBe("UNVERIFIED_LEGACY");
    expect(q.flags).toContain("UNREALIZED_FROM_UNCHECKED_MONITOR");
  });

  it("MANUAL_ENTRY_CHECKED means the app's manual-input checks passed, explicitly NOT exchange-sourced or verified", async () => {
    const svc = makeService();
    const id = await opened(svc);
    ok(await svc.service.exit(id, manualAt(svc.clock.peek())));
    const q = view(ok(await svc.service.getTrade(id)).trade)["priceQuality"];
    expect(q).toMatchObject({ level: "MANUAL_ENTRY_CHECKED", flags: [], warnings: [] });
    expect(q["note"]).toMatch(/manual-input validation rules passed/i);
    expect(q["note"]).toMatch(/not exchange-sourced, exchange-timestamped or independently verified/i);
    // The required disclaimer is itself a negation, not a claim: remove exactly that phrase, then reject any genuine claim in the rest.
    expect(String(q["note"]).replace(/not exchange-sourced, exchange-timestamped or independently verified/i, "")).not.toMatch(CLAIMS_VERIFICATION);
    // The claim detector still catches genuine claims.
    for (const claim of ["Exchange-verified price", "Prices are exchange-sourced", "independently verified by a third party", "verified by the exchange"]) expect(claim).toMatch(CLAIMS_VERIFICATION);
  });

  it("listTrades returns priceQuality and expiryStatus for every trade", async () => {
    const svc = makeService();
    await opened(svc);
    await reviewed(svc);
    for (const t of await svc.service.listTrades()) {
      expect(view(t)["priceQuality"]).toBeDefined();
      expect(view(t)["expiryStatus"]).toBeDefined();
    }
  });

  it("guard (correction 6): derived fields are never written to the journal or the raw export, before or after the cutoff", async () => {
    const svc = makeService();
    const id = await opened(svc);
    ok(await svc.service.monitor(id, manualAt(svc.clock.peek())));
    await reviewed(svc);
    await svc.service.listTrades();
    svc.clock.set(CUTOFF);
    await svc.service.listTrades(); // EXPIRED_REVIEW / EXPIRED_PENDING_CLOSURE are computed here
    ok(await svc.service.getTrade(id));
    const raw = JSON.stringify(await svc.repository.listTrades());
    const exported = await svc.service.exportJournal();
    expect(Object.keys(exported).sort()).toEqual(["app", "counts", "durabilityNotice", "events", "exportVersion", "exportedAt", "trades"]);
    for (const s of [raw, JSON.stringify(exported)]) {
      expect(s).not.toContain("priceQuality");
      expect(s).not.toContain("expiryStatus");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// M1 (review of PR #1): an open trade's unrealized P&L read at or after the contract's cutoff is a HISTORICAL snapshot.
// Decided by the trusted server read time and the approved 15:30 IST cutoff only; no age threshold is invented.
describe("M1: an unrealized P&L snapshot read at or after the cutoff is never labelled a current checked valuation", () => {
  const FLAG = "UNREALIZED_SNAPSHOT_AFTER_CUTOFF";
  const monitored = async () => {
    const svc = makeService();
    const id = await opened(svc);
    const m = ok(await svc.service.monitor(id, manualAt(svc.clock.peek())));
    return { svc, id, snapshot: m.lastMonitor };
  };
  const exportedRecords = async (svc: Svc) => {
    const x = (await svc.repository.exportJournal()) as unknown as Any;
    return JSON.stringify({ trades: x["trades"], events: x["events"] });
  };

  it("before the cutoff (15:29:59.999 IST) a checked snapshot stays MANUAL_ENTRY_CHECKED with no flag", async () => {
    const { svc, id } = await monitored();
    svc.clock.set(LAST_MS_BEFORE);
    const t = view(ok(await svc.service.getTrade(id)).trade);
    expect(t["priceQuality"]).toMatchObject({ level: "MANUAL_ENTRY_CHECKED", flags: [] });
    expect(t["expiryStatus"]).toMatchObject({ status: "BEFORE_CUTOFF" });
  });

  it.each([["at the cutoff instant", CUTOFF], ["one ms after", FIRST_MS_AFTER], ["after the close", AFTER_CLOSE]])(
    "%s the same snapshot is HISTORICAL_SNAPSHOT with the historical-snapshot flag; the stored snapshot is unchanged",
    async (_n, readAt) => {
      const { svc, id, snapshot } = await monitored();
      svc.clock.set(readAt);
      const t = view(ok(await svc.service.getTrade(id)).trade);
      // Final review: a dedicated level. A recorded figure exists, so NO_PRICE ("no valid P&L") would be inaccurate.
      expect(t["priceQuality"]["level"]).toBe("HISTORICAL_SNAPSHOT");
      expect(t["priceQuality"]["flags"]).toEqual([FLAG]);
      expect(t["priceQuality"]["warnings"][0]).toMatch(/historical snapshot, not a current or executable valuation/);
      expect(t["priceQuality"]["note"]).toContain(`recorded by the server at ${String(snapshot?.asOf)}`);
      expect(t["priceQuality"]["note"]).toMatch(/expiry closure is unpriced/);
      expect(t["priceQuality"]["note"]).not.toMatch(CLAIMS_VERIFICATION);
      expect(t["expiryStatus"]).toMatchObject({ status: "EXPIRED_PENDING_CLOSURE" });
      expect(t["lastMonitor"]).toEqual(snapshot); // the stored record is reported as it is, never rewritten
      expect(t["priceQuality"]["note"]).toMatch(/not a current or executable valuation, it is not exchange-verified, and it is not realized P&L/);
      expect(t["realizedPnl"]).toBeNull(); // display only: nothing is realized
      expect((await svc.service.listTrades())[0]?.priceQuality).toMatchObject({ level: "HISTORICAL_SNAPSHOT", flags: [FLAG] });
    },
  );

  it("the expiry closure stays unpriced: no realized P&L is calculated from the old snapshot", async () => {
    const { svc, id, snapshot } = await monitored();
    svc.clock.set(CUTOFF);
    const r = ok(await svc.service.runSafetyCheck(id, manualAt(CUTOFF)));
    expect(r.trade.state).toBe("PAPER_EXPIRED");
    expect(r.trade.exit).toMatchObject({ basis: "NONE", exitPremium: null, valuationStatus: "DATA_INSUFFICIENT" });
    expect(r.trade.realizedPnl).toMatchObject({ status: "DATA_INSUFFICIENT", grossPnl: null, netPnl: null });
    expect(r.trade.exit?.staleReference?.exitPremium).toBe(snapshot?.currentExitPremium); // reference only
    expect(view(r.trade)["priceQuality"]).toMatchObject({ level: "NO_PRICE", flags: [] }); // closed: no snapshot flag
  });

  it("the raw journal export is unchanged by reading a trade after the cutoff and never contains derived fields", async () => {
    const { svc, id } = await monitored();
    svc.clock.set(FIRST_MS_AFTER);
    const before = await exportedRecords(svc);
    ok(await svc.service.getTrade(id));
    await svc.service.listTrades();
    const after = await exportedRecords(svc);
    expect(after).toBe(before);
    expect(after).not.toMatch(/priceQuality|expiryStatus|UNREALIZED_SNAPSHOT_AFTER_CUTOFF/);
  });

  it("only the SERVER read time decides: a client time after the cutoff stored on the snapshot does not trigger the flag", () => {
    const t = sample("journal-b91fa26.json")["pt_b91fa26-open"] as unknown as Any;
    t["lastMonitor"]["clientAsOf"] = AFTER_CLOSE;
    expect(assessPriceQuality(t as unknown as PaperTradeRecord, Date.parse(LAST_MS_BEFORE)).flags).not.toContain(FLAG);
    expect(assessPriceQuality(t as unknown as PaperTradeRecord, Date.parse(CUTOFF)).flags).toContain(FLAG);
  });

  it.each([["journal-1d21f06.json", "pt_1d21f06-open"], ["journal-b91fa26.json", "pt_b91fa26-open"]])(
    "historical %s open trade keeps its legacy flags; after the cutoff it is HISTORICAL_SNAPSHOT with the snapshot flag (record not modified)",
    (file, id) => {
      const t = sample(file)[id] as PaperTradeRecord;
      const stored = JSON.stringify(t);
      const before = assessPriceQuality(t, Date.parse(LAST_MS_BEFORE));
      expect(before.level).toBe("UNVERIFIED_LEGACY");
      expect(before.flags).toContain("UNREALIZED_FROM_UNCHECKED_MONITOR");
      expect(before.flags).not.toContain(FLAG);
      const after = assessPriceQuality(t, Date.parse(CUTOFF));
      expect(after.level).toBe("HISTORICAL_SNAPSHOT");
      expect(after.flags).toEqual([...before.flags, FLAG]); // the unchecked-monitor warning is kept
      expect(after.warnings).toHaveLength(after.flags.length);
      for (const text of [after.note, ...after.warnings]) expect(text).not.toMatch(CLAIMS_VERIFICATION);
      expect(JSON.stringify(t)).toBe(stored);
      expect(assessPriceQuality(t)).toEqual(assessPriceQuality(JSON.parse(stored) as PaperTradeRecord)); // no read time: record-only, unchanged
    },
  );

  it("closed historical records are not given the snapshot flag (it applies to open trades only)", () => {
    for (const t of allSampleTrades().filter((x) => x.state !== "PAPER_OPEN")) {
      expect(assessPriceQuality(t, Date.parse(AFTER_CLOSE)).flags).not.toContain(FLAG);
      expect(assessPriceQuality(t, Date.parse(AFTER_CLOSE))).toEqual(assessPriceQuality(t));
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Final review: instrument expiry on STORED records, the dedicated HISTORICAL_SNAPSHOT level, and no freshness claims.
describe("final review: instrument identity on stored records, HISTORICAL_SNAPSHOT and freshness wording", () => {
  const legsWith = (ids: Array<{ provider: string; id: string }>) => ids.map((instrument, i) => ({ optionType: i === 0 ? "CE" : "PE", strike: 22900 - i * 100, instrument }));
  const man = (id: string) => ({ provider: "manual", id });
  const PE_OK = man("NIFTY|2026-10-06|PE|22800");

  it.each([
    ["consistent legs", [man("NIFTY|2026-10-06|CE|22900"), PE_OK], "2026-10-06", "CONSISTENT", 0],
    ["an earlier instrument expiry (the earliest date wins)", [man("NIFTY|2026-10-01|CE|22900"), PE_OK], "2026-10-01", "MISMATCH", 1],
    ["a later instrument expiry (never extends the cutoff)", [man("NIFTY|2026-12-29|CE|22900"), PE_OK], "2026-10-06", "MISMATCH", 1],
    ["another market", [man("BANKNIFTY|2026-10-06|CE|22900"), PE_OK], "2026-10-06", "MISMATCH", 1],
    ["another option type", [man("NIFTY|2026-10-06|PE|22900"), PE_OK], "2026-10-06", "MISMATCH", 1],
    ["another strike", [man("NIFTY|2026-10-06|CE|23000"), PE_OK], "2026-10-06", "MISMATCH", 1],
    ["a strike written differently (no normalisation)", [man("NIFTY|2026-10-06|CE|22900.0"), PE_OK], "2026-10-06", "MISMATCH", 1],
    ["an opaque provider", [{ provider: "p", id: "abc" }, PE_OK], "2026-10-06", "UNVERIFIABLE", 1],
    ["a malformed expiry", [man("NIFTY|2026-13-40|CE|22900"), PE_OK], "2026-10-06", "UNVERIFIABLE", 1],
    ["an empty part", [man("|2026-10-06|CE|22900"), PE_OK], "2026-10-06", "UNVERIFIABLE", 1],
  ])("checkInstruments with %s", (_n, ids, expiryUsed, check, nReasons) => {
    const candidate = { marketId: "NIFTY", expiry: "2026-10-06", legs: legsWith(ids) } as unknown as Parameters<typeof checkInstruments>[0];
    const before = JSON.stringify(candidate);
    const r = checkInstruments(candidate);
    expect(r).toMatchObject({ expiryUsed, check });
    expect(r.reasons).toHaveLength(nReasons);
    expect(JSON.stringify(candidate)).toBe(before); // never rewritten
  });

  it("every sample record (1d21f06, b91fa26) is CONSISTENT, so its behaviour is unchanged", () => {
    for (const t of allSampleTrades()) expect(checkInstruments(t.candidate)).toEqual({ expiryUsed: t.candidate.expiry, check: "CONSISTENT", reasons: [] });
  });

  it("a stored record whose instruments are not CONSISTENT is never shown as checked: INSTRUMENT_IDENTITY_UNVERIFIED", () => {
    const t = sample("journal-b91fa26.json")["pt_b91fa26-userExit"] as unknown as Any;
    // a record written by 6f1fd0b with a checked exit, but an opaque instrument (accepted before the final review)
    Object.assign(t["exit"], { valuationStatus: "MANUAL_ENTRY_CHECKED", priceProvenance: "MANUAL_USER_ENTRY" });
    t["exit"]["legBids"] = t["exit"]["legBids"].map((b: Any) => ({ ...b, ask: b["bid"] + 0.5, enteredAt: "2026-09-30T05:29:50.000Z", entryAgeMs: 10_000 }));
    expect(assessPriceQuality(t as unknown as PaperTradeRecord).level).toBe("MANUAL_ENTRY_CHECKED");
    t["candidate"]["legs"][0]["instrument"] = { provider: "p", id: "abc" };
    const q = assessPriceQuality(t as unknown as PaperTradeRecord);
    expect(q.level).toBe("UNVERIFIED_LEGACY");
    expect(q.flags).toContain("INSTRUMENT_IDENTITY_UNVERIFIED");
  });

  it("a stored open trade whose instrument names an EARLIER expiry becomes a historical snapshot at THAT cutoff (boundary pinned)", () => {
    const t = sample("journal-b91fa26.json")["pt_b91fa26-open"] as unknown as Any;
    t["candidate"]["legs"][0]["instrument"] = man("NIFTY|2026-10-01|CE|22900");
    const rec = t as unknown as PaperTradeRecord;
    expect(assessPriceQuality(rec, Date.parse("2026-10-01T09:59:59.999Z")).flags).not.toContain("UNREALIZED_SNAPSHOT_AFTER_CUTOFF");
    const at = assessPriceQuality(rec, Date.parse("2026-10-01T10:00:00.000Z"));
    expect(at.level).toBe("HISTORICAL_SNAPSHOT");
    expect(at.note).toContain("2026-10-01T15:30:00+05:30");
  });

  it("missing price data after the cutoff stays NO_PRICE (no figure exists, so it is not a historical snapshot)", async () => {
    const svc = makeService();
    const id = await opened(svc);
    ok(await svc.service.monitor(id, manualAt(svc.clock.peek(), { ce: [66.05, null] })));
    svc.clock.set(FIRST_MS_AFTER);
    const t = view(ok(await svc.service.getTrade(id)).trade);
    expect(t["lastMonitor"]["unrealized"]["status"]).toBe("DATA_INSUFFICIENT");
    expect(t["priceQuality"]).toMatchObject({ level: "NO_PRICE", flags: [] });
  });

  it("an open trade with no monitor update after the cutoff is NO_PRICE (nothing recorded)", async () => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set(CUTOFF);
    expect(view(ok(await svc.service.getTrade(id)).trade)["priceQuality"]).toMatchObject({ level: "NO_PRICE", flags: [] });
  });

  it("HISTORICAL_SNAPSHOT is display-only: the expiry closure, realized P&L and lifecycle are exactly as before", async () => {
    const svc = makeService();
    const id = await opened(svc);
    ok(await svc.service.monitor(id, manualAt(svc.clock.peek())));
    svc.clock.set(CUTOFF);
    expect(view(ok(await svc.service.getTrade(id)).trade)["priceQuality"]["level"]).toBe("HISTORICAL_SNAPSHOT");
    const r = ok(await svc.service.runSafetyCheck(id, {}));
    expect(r.trade).toMatchObject({ state: "PAPER_EXPIRED", exit: { basis: "NONE", exitPremium: null, valuationStatus: "DATA_INSUFFICIENT" }, realizedPnl: { status: "DATA_INSUFFICIENT", grossPnl: null } });
    expect(await types(svc, id)).toEqual(["REVIEW_STARTED", "TRADE_OPENED", "MONITOR_SNAPSHOT", "TRADE_EXPIRED"]);
  });

  // Item 3 (deferred stale-age policy): an old snapshot BEFORE the cutoff keeps its level (no threshold is invented), and
  // no level, note or warning claims the price is current, live, fresh or real-time.
  const FRESHNESS_CLAIM = /\b(current price is|live|real-?time|fresh|up[- ]to[- ]date|latest market)\b/i;
  it("a checked snapshot read days later (before the cutoff) is unchanged and makes no freshness claim", async () => {
    const svc = makeService();
    const id = await opened(svc);
    ok(await svc.service.monitor(id, manualAt(svc.clock.peek())));
    svc.clock.set("2026-10-05T10:00:00.000Z"); // 7 days later, still before the cutoff
    const q = view(ok(await svc.service.getTrade(id)).trade)["priceQuality"];
    expect(q).toMatchObject({ level: "MANUAL_ENTRY_CHECKED", flags: [] });
    for (const text of [q["note"], ...q["warnings"]]) expect(String(text)).not.toMatch(FRESHNESS_CLAIM);
  });
  it("no sample record's derived note or warnings claim freshness, before or after the cutoff", () => {
    for (const t of allSampleTrades()) {
      for (const at of [LAST_MS_BEFORE, AFTER_CLOSE]) {
        const q = assessPriceQuality(t, Date.parse(at));
        for (const text of [q.note, ...q.warnings]) expect(text).not.toMatch(FRESHNESS_CLAIM);
      }
    }
  });
});
