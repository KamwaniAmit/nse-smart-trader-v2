// Phase 1B.1 regression tests: one block per audited defect (D1-D5, see docs/PHASE_REPORTS/PHASE_1B1.md).
// Written BEFORE the fixes; each block reproduces the audited behaviour and pins the approved policy.
import { describe, expect, it } from "vitest";
import type { PaperTradeRecord } from "../src/index.js";
import {
  EXPIRY_CONVENTION,
  TIME_RULES,
  buildRiskInputs,
  assessRiskRecord,
  computeCapital,
  evaluateSafety,
  istDateOf,
  parseCandidateInput,
} from "../src/index.js";
import { CE_ID, PE_ID, T0, confirmBody, exitQuotes, freshQuotes, longVolRaw, makeService, opened, reviewed } from "./fixtures.js";

type Res<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: string[]; trade?: PaperTradeRecord } };
const ok = <T>(r: Res<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const err = <T>(r: Res<T>) => {
  if (r.ok) throw new Error("expected an error");
  return r.error;
};
const DAY = 24 * 60 * 60 * 1000;
const types = async (svc: ReturnType<typeof makeService>, id: string) => (await svc.service.listEvents({ tradeId: id })).map((e) => e.type);
const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString().replace(".000Z", "Z");

// ---------------------------------------------------------------------------------------------------------------
describe("D1: quote freshness at confirmation (max 60 s, trusted server time)", () => {
  it("the approved policy constants: 60 s maximum age", () => {
    expect(TIME_RULES.maxQuoteAgeMs).toBe(60_000);
    expect(TIME_RULES.maxFutureSkewMs).toBeGreaterThan(0);
    expect(TIME_RULES.maxFutureSkewMs).toBeLessThan(TIME_RULES.maxQuoteAgeMs);
  });

  it.each([5, 10])("a review-time quote re-sent %i days later is rejected (QUOTE_NOT_FRESH); the trade stays in review and nothing is opened", async (days) => {
    const svc = makeService();
    const reviewTime = svc.clock.peek();
    const id = await reviewed(svc);
    svc.clock.advance(days * DAY);
    const e = err(await svc.service.confirm(id, { confirmed: true, quotes: freshQuotes(longVolRaw(), reviewTime) }));
    expect(e.code).toBe("QUOTE_NOT_FRESH");
    expect(e.details?.join(" ")).toMatch(/older than 60 s/);
    const t = ok(await svc.service.getTrade(id)).trade;
    expect(t.state).toBe("PAPER_REVIEW");
    expect(t.entry).toBeNull();
    expect(await types(svc, id)).toEqual(["REVIEW_STARTED", "CONFIRM_REJECTED_QUOTE"]);
  });

  it("the stale review price is never reused when quotes are omitted (confirmed: true alone is refused)", async () => {
    const svc = makeService();
    const id = await reviewed(svc);
    const e = err(await svc.service.confirm(id, { confirmed: true }));
    expect(e.code).toBe("DATA_INSUFFICIENT");
    expect(ok(await svc.service.getTrade(id)).trade.state).toBe("PAPER_REVIEW");
  });

  it.each([
    ["exactly 60 s old", -60_000, true],
    ["59 s old", -59_000, true],
    ["61 s old", -61_000, false],
    ["now", 0, true],
    ["in the future within the allowed skew", 1_000, true],
    ["in the future beyond the allowed skew", 60_000, false],
  ] as const)("quote %s -> accepted: %s", async (_n, delta, accepted) => {
    const svc = makeService();
    const id = await reviewed(svc);
    const at = shift(svc.clock.peek(), delta);
    const r = await svc.service.confirm(id, { confirmed: true, quotes: freshQuotes(longVolRaw(), at) });
    if (accepted) expect(ok(r).state).toBe("PAPER_OPEN");
    else expect(err(r).code).toBe("QUOTE_NOT_FRESH");
  });

  it.each([
    ["missing", undefined],
    ["not a timestamp", "yesterday"],
    ["an impossible date", "2026-02-30T10:00:00Z"],
    ["a date without a time or zone (ambiguous)", "2026-09-28"],
    ["a time without a zone (ambiguous)", "2026-09-28T10:00:00"],
  ])("a quote time that is %s is rejected", async (_n, asOf) => {
    const svc = makeService();
    const id = await reviewed(svc);
    const e = err(await svc.service.confirm(id, { confirmed: true, quotes: freshQuotes(longVolRaw(), asOf as string | undefined) }));
    expect(e.code).toBe("QUOTE_NOT_FRESH");
    expect(ok(await svc.service.getTrade(id)).trade.state).toBe("PAPER_REVIEW");
  });

  it("only the EXACT candidate instruments are accepted: another strike or expiry is refused, never substituted", async () => {
    const svc = makeService();
    const id = await reviewed(svc);
    const now = svc.clock.peek();
    const quotes = [
      { instrument: { provider: "manual", id: "NIFTY|2026-10-06|CE|23000" }, bid: 69, ask: 69.8, asOf: now },
      { instrument: { provider: "manual", id: "NIFTY|2026-10-13|PE|22800" }, bid: 50.2, ask: 50.95, asOf: now },
    ];
    const e = err(await svc.service.confirm(id, { confirmed: true, quotes }));
    expect(e.code).toBe("INVALID_REQUEST");
    expect(e.details?.join(" ")).toMatch(/not a leg of this trade/);
    expect(ok(await svc.service.getTrade(id)).trade.state).toBe("PAPER_REVIEW");
  });

  it("a missing leg quote, a missing ask, or an LTP-only quote is DATA_INSUFFICIENT (no LTP or theoretical substitute)", async () => {
    for (const quotes of [
      (now: string) => [{ instrument: CE_ID, bid: 69, ask: 69.8, asOf: now }],
      (now: string) => [{ instrument: CE_ID, bid: 69, ask: null, ltp: 69.5, asOf: now }, { instrument: PE_ID, bid: 50.2, ask: 50.95, asOf: now }],
      (now: string) => [{ instrument: CE_ID, bid: null, ask: null, ltp: 69.5, asOf: now }, { instrument: PE_ID, bid: null, ask: null, ltp: 50.5, asOf: now }],
    ]) {
      const svc = makeService();
      const id = await reviewed(svc);
      const e = err(await svc.service.confirm(id, { confirmed: true, quotes: quotes(svc.clock.peek()) }));
      expect(e.code).toBe("DATA_INSUFFICIENT");
      expect(ok(await svc.service.getTrade(id)).trade.state).toBe("PAPER_REVIEW");
    }
  });

  it("two different prices for the same leg are ambiguous and refused", async () => {
    const svc = makeService();
    const id = await reviewed(svc);
    const now = svc.clock.peek();
    const quotes = [...freshQuotes(longVolRaw(), now), { instrument: CE_ID, bid: 68, ask: 68.5, asOf: now }];
    expect(err(await svc.service.confirm(id, { confirmed: true, quotes })).code).toBe("DATA_INSUFFICIENT");
  });

  it("entry premium, capital and entry risk are RECALCULATED from the fresh asks (CE 70.50 + PE 51.25 = 121.75)", async () => {
    const svc = makeService();
    const id = await reviewed(svc);
    const now = svc.clock.peek();
    const quotes = [
      { instrument: CE_ID, bid: 69.9, ask: 70.5, volume: 6000, oi: 12000, bidQty: 6500, askQty: 6500, asOf: now },
      { instrument: PE_ID, bid: 50.6, ask: 51.25, volume: 6000, oi: 12000, bidQty: 6500, askQty: 6500, asOf: now },
    ];
    const t = ok(await svc.service.confirm(id, { confirmed: true, quotes }));
    expect(t.entry?.combinedEntryPremium).toBe(121.75);
    expect(t.entry?.capital).toMatchObject({ premiumRequirement: 7913.75, totalCapitalRequirement: 8163.75, lots: 1, gate: "PASS" });
    expect(t.entry?.capitalRequirement).toBe(8163.75);
    expect(t.entry?.legs.map((l) => [l.entryAsk, l.entryBid])).toEqual([[70.5, 69.9], [51.25, 50.6]]);
    expect(t.entry?.risk.inputs["bidAskSpreadQuality"]).toBe(1.0267); // (121.75 - 120.50) / 121.75 x 100, from the FRESH bids and asks
    // The review record is history: it keeps the review-time numbers and is not rewritten.
    expect(t.review.combinedEntryPremium).toBe(120.75);
  });

  it("the fresh price can fail the capital gate even though the review passed", async () => {
    const svc = makeService();
    const raw = longVolRaw({ maxCapitalAllocation: 8100, requestedLots: 1 });
    const id = await reviewed(svc, raw);
    const now = svc.clock.peek();
    const quotes = [
      { instrument: CE_ID, bid: 69.9, ask: 70.5, asOf: now },
      { instrument: PE_ID, bid: 50.6, ask: 51.25, asOf: now },
    ];
    expect(err(await svc.service.confirm(id, { confirmed: true, quotes })).code).toBe("CAPITAL_GATE_FAILED");
    expect(ok(await svc.service.getTrade(id)).trade.state).toBe("PAPER_REVIEW");
  });

  it("market data missing from the fresh quotes is recorded as missing, not carried over from the review", async () => {
    const svc = makeService();
    const id = await reviewed(svc);
    const now = svc.clock.peek();
    const t = ok(await svc.service.confirm(id, { confirmed: true, quotes: [
      { instrument: CE_ID, bid: 69, ask: 69.8, asOf: now },
      { instrument: PE_ID, bid: 50.2, ask: 50.95, volume: 6000, oi: 12000, bidQty: 6500, askQty: 6500, asOf: now },
    ] }));
    expect(t.entry?.dataCompleteness.missing).toEqual(["CE 22900.volume", "CE 22900.oi", "CE 22900.bidQty", "CE 22900.askQty"]);
  });

  it("the entry snapshot keeps each quote's own time, its age, the freshness rule and the review time", async () => {
    const svc = makeService();
    const reviewTime = svc.clock.peek();
    const id = await reviewed(svc);
    svc.clock.advance(30_000);
    const quoteTime = svc.clock.peek();
    svc.clock.advance(20_000);
    const t = ok(await svc.service.confirm(id, { confirmed: true, quotes: freshQuotes(longVolRaw(), quoteTime) }));
    expect(t.entry?.snapshotVersion).toBe(2);
    expect(t.entry?.legs.map((l) => [l.quoteAsOf, l.quoteAgeMs])).toEqual([[quoteTime, 20_000], [quoteTime, 20_000]]);
    expect(t.entry?.quoteFreshness).toEqual({ maxQuoteAgeMs: 60_000, maxFutureSkewMs: TIME_RULES.maxFutureSkewMs, evaluatedAt: t.entry?.capturedAt });
    expect(t.entry?.candidateAsOf).toBe(t.candidate.asOf);
    expect(Date.parse(t.entry?.capturedAt ?? "")).toBeGreaterThan(Date.parse(reviewTime));
  });

  it("confirmed: false still needs no quotes and is still CONFIRMATION_REQUIRED (the gate is unchanged)", async () => {
    const svc = makeService();
    const id = await reviewed(svc);
    expect(err(await svc.service.confirm(id, { confirmed: false })).code).toBe("CONFIRMATION_REQUIRED");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("D2: expiry / safety closure without executable bids is DATA_INSUFFICIENT", () => {
  it.each([
    ["about one day old (expiry-day morning)", "2026-10-06T04:30:00Z"],
    ["about nine days old (just after entry)", null],
  ] as const)("an old monitored bid (%s) is kept as reference only, never as a valid exit price", async (_n, monitorAt) => {
    const svc = makeService();
    const id = await opened(svc);
    if (monitorAt !== null) svc.clock.set(monitorAt);
    const monitored = ok(await svc.service.monitor(id, exitQuotes()));
    expect(monitored.lastValidExit?.exitPremium).toBe(120.05);
    svc.clock.set("2026-10-07T03:50:00Z"); // 09:20 IST on the day after expiry (server time)
    const r = ok(await svc.service.runSafetyCheck(id, {}));
    expect(r.decision.action).toBe("EXPIRE");
    expect(r.trade.state).toBe("PAPER_EXPIRED");
    expect(r.trade.exit).toMatchObject({ trigger: "EXPIRY", basis: "NONE", exitPremium: null, priceAsOf: null, valuationStatus: "DATA_INSUFFICIENT" });
    expect(r.trade.exit?.legBids.every((b) => b.bid === null)).toBe(true);
    expect(r.trade.exit?.staleReference).toMatchObject({ exitPremium: 120.05, asOf: monitored.lastValidExit?.asOf });
    expect(r.trade.exit?.notes.join(" ")).toMatch(/reference only/);
    expect(r.trade.realizedPnl).toMatchObject({ status: "DATA_INSUFFICIENT", grossPnl: null, netPnl: null });
    expect(r.trade.lastValidExit?.exitPremium).toBe(120.05); // history is preserved, not deleted
    const last = (await svc.service.listEvents({ tradeId: id })).at(-1);
    expect(last).toMatchObject({ type: "TRADE_EXPIRED", payload: { basis: "NONE", pnlStatus: "DATA_INSUFFICIENT" } });
  });

  it("the holding-limit closure follows the same rule: no current bid -> DATA_INSUFFICIENT even with an earlier monitored bid", async () => {
    const svc = makeService();
    const id = await opened(svc);
    ok(await svc.service.monitor(id, exitQuotes()));
    const r = ok(await svc.service.runSafetyCheck(id, { completedSessions: 2 }));
    expect(r.trade.state).toBe("PAPER_AUTO_CLOSED");
    expect(r.trade.exit).toMatchObject({ basis: "NONE", exitPremium: null, valuationStatus: "DATA_INSUFFICIENT" });
    expect(r.trade.realizedPnl?.status).toBe("DATA_INSUFFICIENT");
  });

  it("with valid CURRENT CE and PE bids, expiry is valued from them (unchanged) and marked EXECUTABLE_QUOTE", async () => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set("2026-10-07T03:50:00Z");
    const r = ok(await svc.service.runSafetyCheck(id, exitQuotes()));
    expect(r.trade.exit).toMatchObject({ basis: "CURRENT_QUOTE", exitPremium: 120.05, valuationStatus: "EXECUTABLE_QUOTE", staleReference: null });
    expect(r.trade.realizedPnl).toMatchObject({ status: "VALID", grossPnl: -45.5 });
  });

  it("lifecycle state, valuation status and P&L validity are separate fields", async () => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set("2026-10-07T03:50:00Z");
    const t = ok(await svc.service.runSafetyCheck(id, {})).trade;
    expect([t.state, t.exit?.valuationStatus, t.realizedPnl?.status]).toEqual(["PAPER_EXPIRED", "DATA_INSUFFICIENT", "DATA_INSUFFICIENT"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("D3: client timestamps are untrusted (format, ordering, skew); safety uses server time", () => {
  it("an exit timestamped before the entry snapshot is rejected and the trade stays open", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const e = err(await svc.service.exit(id, { ...exitQuotes(), asOf: "2026-09-01T10:00:00+05:30" }));
    expect(e.code).toBe("INVALID_REQUEST");
    expect(e.details?.join(" ")).toMatch(/before/);
    const t = ok(await svc.service.getTrade(id)).trade;
    expect(t.state).toBe("PAPER_OPEN");
    expect(t.exit).toBeNull();
  });

  it("a monitor update timestamped before the previous update is rejected (events stay in order)", async () => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.advance(10 * 60_000);
    const later = shift(svc.clock.peek(), -1000);
    ok(await svc.service.monitor(id, { ...exitQuotes(), asOf: later }));
    expect(err(await svc.service.monitor(id, { ...exitQuotes(), asOf: shift(later, -60_000) })).code).toBe("INVALID_REQUEST");
  });

  it("a materially future-dated exit is rejected; one within the allowed skew is accepted", async () => {
    const svc = makeService();
    const id = await opened(svc);
    expect(err(await svc.service.exit(id, { ...exitQuotes(), asOf: shift(svc.clock.peek(), 10 * 60_000) })).code).toBe("INVALID_REQUEST");
    expect(ok(await svc.service.exit(id, { ...exitQuotes(), asOf: shift(svc.clock.peek(), 1000) })).state).toBe("PAPER_EXITED");
  });

  it.each(["not a date", "2026-02-30T10:00:00Z", "2026-10-01", "2026-10-01T10:00:00"])("an invalid or ambiguous event time (%s) is rejected", async (asOf) => {
    const svc = makeService();
    const id = await opened(svc);
    expect(err(await svc.service.exit(id, { ...exitQuotes(), asOf })).code).toBe("INVALID_REQUEST");
  });

  it("a client-supplied future asOf can NOT force expiry: it is rejected, and the trade stays open", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const e = err(await svc.service.runSafetyCheck(id, { asOf: "2030-01-01T00:00:00Z" }));
    expect(e.code).toBe("INVALID_REQUEST");
    expect(ok(await svc.service.getTrade(id)).trade.state).toBe("PAPER_OPEN");
  });

  it("the expiry decision uses SERVER time: before expiry (server clock) nothing happens", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const r = ok(await svc.service.runSafetyCheck(id, {}));
    expect(r.decision.action).toBe("NONE");
    expect(r.trade.state).toBe("PAPER_OPEN");
  });

  it("after expiry by SERVER time the trade expires without any client time; the event is stamped with server time", async () => {
    const svc = makeService();
    const id = await opened(svc);
    svc.clock.set("2026-10-07T03:50:00Z");
    const r = ok(await svc.service.runSafetyCheck(id, {}));
    expect(r.trade.state).toBe("PAPER_EXPIRED");
    expect((await svc.service.listEvents({ tradeId: id })).at(-1)?.timestamp).toBe("2026-10-07T03:50:00Z");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("D4: expiry dates are judged in Asia/Kolkata (IST), never by slicing an ISO string", () => {
  it("documents the convention: IST, and expired from 00:00 IST on the day after the expiry date", () => {
    expect(EXPIRY_CONVENTION.timeZone).toBe("Asia/Kolkata");
    expect(EXPIRY_CONVENTION.expiredFrom).toMatch(/00:00 Asia\/Kolkata on the calendar day after/);
  });

  it.each([
    ["2026-10-06T18:29:59Z", "2026-10-06"], // 23:59:59 IST
    ["2026-10-06T18:30:00Z", "2026-10-07"], // 00:00:00 IST next day
    ["2026-10-06T22:30:00Z", "2026-10-07"], // the audited P5 case
    ["2026-10-05T19:00:00Z", "2026-10-06"], // 00:30 IST: UTC date is still the 5th
    ["2026-10-07T01:00:00+09:00", "2026-10-06"], // 21:30 IST: the written date is the 7th
    ["2026-10-06T00:00:00-05:00", "2026-10-06"], // 10:30 IST
  ])("istDateOf(%s) = %s", (ts, date) => expect(istDateOf(ts)).toBe(date));

  const base = { expiry: "2026-10-06", completedSessions: null as number | null };
  it.each([
    ["2026-10-06T18:29:59Z", "NONE"], // last second of expiry day in IST
    ["2026-10-06T18:30:00Z", "EXPIRE"], // first second of the next IST day
    ["2026-10-06T22:30:00Z", "EXPIRE"], // P5: UTC date says expiry day, IST says the day after
    ["2026-10-07T01:00:00+09:00", "NONE"], // written date is the 7th, but it is still the 6th in IST
    ["2026-10-06T10:00:00+05:30", "NONE"],
    ["2026-10-07T09:20:00+05:30", "EXPIRE"],
  ])("evaluateSafety at %s -> %s", (asOf, action) => expect(evaluateSafety({ ...base, asOf }).action).toBe(action));

  it("an unparseable time is an error, never a guess", () => {
    expect(() => evaluateSafety({ ...base, asOf: "garbage" })).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("D5: no implicit one-lot assumption in risk inputs", () => {
  const candidate = (over: Record<string, unknown> = {}) => {
    const p = parseCandidateInput(longVolRaw(over), { now: T0, newId: () => "x" });
    if (!p.ok) throw new Error(p.errors.join());
    return p.value;
  };
  const capitalFor = (c: ReturnType<typeof candidate>) =>
    computeCapital({ combinedEntryPremium: 120.75, lotSize: c.lotSize, entryCosts: c.entryCosts, maxCapitalAllocation: c.maxCapitalAllocation, requestedLots: c.requestedLots });

  it("unknown lots: contractLiquidity is unavailable (null), and the risk level stays null", () => {
    const c = candidate({ maxCapitalAllocation: null, requestedLots: null });
    const cap = capitalFor(c);
    expect(cap.lots).toBeNull();
    const inputs = buildRiskInputs(c, cap);
    expect(inputs["contractLiquidity"]).toBeNull();
    expect(assessRiskRecord(inputs, T0).result).toMatchObject({ riskLevel: null, riskDataStatus: "INSUFFICIENT" });
  });

  it.each([0, -1, 1.5, Number.NaN])("an invalid lot count (%s) is treated as unknown, not as one lot", (lots) => {
    const c = candidate();
    const cap = { ...capitalFor(c), lots };
    expect(buildRiskInputs(c, cap)["contractLiquidity"]).toBeNull();
  });

  it("explicit lots are still used: 2 lots -> depth 6500 / (2 x 65) = 50", () => {
    const c = candidate({ requestedLots: 2 });
    expect(buildRiskInputs(c, capitalFor(c))["contractLiquidity"]).toBe(50);
  });

  it("one explicit lot keeps the established value 6500 / 65 = 100", () => {
    const c = candidate();
    expect(buildRiskInputs(c, capitalFor(c))["contractLiquidity"]).toBe(100);
  });
});

// The confirm helper used across the suite must satisfy D1 itself.
describe("fixture sanity", () => {
  it("confirmBody produces fresh quotes for the exact legs, stamped with the server clock", async () => {
    const svc = makeService();
    const id = await reviewed(svc);
    const body = confirmBody(svc);
    expect(body.quotes.map((q) => q.instrument)).toEqual([CE_ID, PE_ID]);
    expect(ok(await svc.service.confirm(id, body)).state).toBe("PAPER_OPEN");
  });
});
