import { describe, expect, it } from "vitest";
import type { PaperTradeRecord } from "../src/index.js";
import { CE_ID, PE_ID, exitQuotes, longVolRaw, makeService, opened, reviewed } from "./fixtures.js";

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const err = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string; details?: string[]; trade?: PaperTradeRecord } }) => {
  if (r.ok) throw new Error("expected an error");
  return r.error;
};
const eventTypes = async (svc: ReturnType<typeof makeService>, id?: string) => (await svc.service.listEvents(id ? { tradeId: id } : undefined)).map((e) => e.type);

describe("CANDIDATE -> PAPER_REVIEW", () => {
  it("assess evaluates a candidate but stores NOTHING and opens NOTHING", async () => {
    const svc = makeService();
    const r = ok(svc.service.assess(longVolRaw()));
    expect(r.state).toBe("CANDIDATE");
    expect(r.review.combinedEntryPremium).toBe(120.75);
    expect(await svc.service.listTrades()).toEqual([]);
    expect(await eventTypes(svc)).toEqual([]);
  });

  it("assess reports an invalid request as INVALID_REQUEST with details", () => {
    const e = err(makeService().service.assess({ source: "LONG_VOL" }));
    expect(e.code).toBe("INVALID_REQUEST");
    expect(e.details?.length).toBeGreaterThan(0);
  });

  it("assess shows DATA_INSUFFICIENT when no executable entry exists", () => {
    const r = ok(makeService().service.assess(longVolRaw({ legs: [
      { optionType: "CE", strike: 22900, quote: { bid: 69, ask: null } },
      { optionType: "PE", strike: 22800, quote: { bid: 50.2, ask: 50.95 } },
    ] })));
    expect(r.state).toBe("DATA_INSUFFICIENT");
    expect(r.review.risk.result.riskLevel).toBeNull();
  });

  it("beginReview moves a candidate to PAPER_REVIEW, stores it, and does NOT open it", async () => {
    const svc = makeService();
    const trade = ok(await svc.service.beginReview(longVolRaw()));
    expect(trade.state).toBe("PAPER_REVIEW");
    expect(trade.entry).toBeNull();
    expect(trade.exit).toBeNull();
    expect(trade.currentRisk).toBeNull();
    expect((await svc.service.listTrades({ states: ["PAPER_OPEN"] })).length).toBe(0);
    expect(await eventTypes(svc, trade.tradeId)).toEqual(["REVIEW_STARTED"]);
  });

  it("the review shows entry premium, capital and risk before anything is confirmed", async () => {
    const trade = ok(await makeService().service.beginReview(longVolRaw()));
    expect(trade.review.entryStatus).toBe("EXECUTABLE");
    expect(trade.review.combinedEntryPremium).toBe(120.75);
    expect(trade.review.capital).toMatchObject({ premiumRequirement: 7848.75, totalCapitalRequirement: 8098.75, lots: 1, gate: "PASS" });
    expect(trade.review.risk.result).toMatchObject({ riskLevel: "LOW", riskScore: 4, riskDataStatus: "COMPLETE" });
    expect(trade.review.risk.rulesVersion).toBe("1.0.0");
  });

  it("a candidate with no executable entry becomes a stored DATA_INSUFFICIENT record (final) and cannot be confirmed", async () => {
    const svc = makeService();
    const bad = longVolRaw({ legs: [
      { optionType: "CE", strike: 22900, quote: { bid: 69, ask: null, ltp: 69.5 } },
      { optionType: "PE", strike: 22800, quote: { bid: 50.2, ask: 50.95 } },
    ] });
    const e = err(await svc.service.beginReview(bad));
    expect(e.code).toBe("DATA_INSUFFICIENT");
    expect(e.trade?.state).toBe("DATA_INSUFFICIENT");
    expect(e.trade?.entry).toBeNull();
    expect(e.trade?.rejectionReasons).toContain("CE 22900: INVALID_ASK");
    expect(await eventTypes(svc)).toEqual(["REJECTED_DATA_INSUFFICIENT"]);
    const c = err(await svc.service.confirm(e.trade?.tradeId ?? "", { confirmed: true }));
    expect(c.code).toBe("INVALID_TRANSITION");
  });
});

describe("PAPER_REVIEW -> PAPER_OPEN requires explicit confirmation", () => {
  it("confirmed: false is refused with CONFIRMATION_REQUIRED and the trade stays in review", async () => {
    const svc = makeService();
    const id = await reviewed(svc);
    expect(err(await svc.service.confirm(id, { confirmed: false })).code).toBe("CONFIRMATION_REQUIRED");
    expect(ok(await svc.service.getTrade(id)).trade.state).toBe("PAPER_REVIEW");
  });

  it.each([undefined, null, {}, { confirmed: "true" }, { confirmed: 1 }, "yes"])("a non-boolean or missing confirmation (%j) is an INVALID_REQUEST", async (body) => {
    const svc = makeService();
    const id = await reviewed(svc);
    expect(err(await svc.service.confirm(id, body)).code).toBe("INVALID_REQUEST");
    expect(ok(await svc.service.getTrade(id)).trade.state).toBe("PAPER_REVIEW");
  });

  it("confirmed: true opens the trade", async () => {
    const svc = makeService();
    const id = await reviewed(svc);
    const trade = ok(await svc.service.confirm(id, { confirmed: true }));
    expect(trade.state).toBe("PAPER_OPEN");
    expect(await eventTypes(svc, id)).toEqual(["REVIEW_STARTED", "TRADE_OPENED"]);
  });

  it("confirming twice is an INVALID_TRANSITION", async () => {
    const svc = makeService();
    const id = await opened(svc);
    expect(err(await svc.service.confirm(id, { confirmed: true })).code).toBe("INVALID_TRANSITION");
  });

  it("an unknown trade is NOT_FOUND", async () => {
    expect(err(await makeService().service.confirm("pt_nope", { confirmed: true })).code).toBe("NOT_FOUND");
  });

  it("monitoring, exiting or safety-checking a trade that is only in REVIEW is refused", async () => {
    const svc = makeService();
    const id = await reviewed(svc);
    expect(err(await svc.service.monitor(id, exitQuotes())).code).toBe("INVALID_TRANSITION");
    expect(err(await svc.service.exit(id, exitQuotes())).code).toBe("INVALID_TRANSITION");
    expect(err(await svc.service.runSafetyCheck(id, { asOf: "2026-10-09" })).code).toBe("INVALID_TRANSITION");
  });

  it("the capital gate blocks confirmation: allocation too small for one lot", async () => {
    const svc = makeService();
    const id = await reviewed(svc, longVolRaw({ maxCapitalAllocation: 5000, requestedLots: null }));
    const e = err(await svc.service.confirm(id, { confirmed: true }));
    expect(e.code).toBe("CAPITAL_GATE_FAILED");
    expect(ok(await svc.service.getTrade(id)).trade.state).toBe("PAPER_REVIEW");
  });

  it("unknown lots block confirmation (LOTS_UNRESOLVED), nothing is guessed", async () => {
    const svc = makeService();
    const id = await reviewed(svc, longVolRaw({ maxCapitalAllocation: null, requestedLots: null }));
    expect(err(await svc.service.confirm(id, { confirmed: true })).code).toBe("LOTS_UNRESOLVED");
  });

  it("explicit lots with unknown allocation can open, but entry risk is recorded as unknown (null), not guessed", async () => {
    const svc = makeService();
    const id = await reviewed(svc, longVolRaw({ maxCapitalAllocation: null, requestedLots: 2 }));
    const trade = ok(await svc.service.confirm(id, { confirmed: true }));
    expect(trade.entry?.lots).toBe(2);
    expect(trade.entry?.risk.result).toMatchObject({ riskLevel: null, riskScore: null, riskDataStatus: "INSUFFICIENT" });
  });
});

describe("entry snapshot", () => {
  it("captures identity, market, structure, expiry, strikes, asks, premium, spot, moves, edge, score, risk, capital and time", async () => {
    const svc = makeService();
    const id = await reviewed(svc);
    const trade = ok(await svc.service.confirm(id, { confirmed: true }));
    const e = trade.entry;
    expect(e).toMatchObject({
      snapshotVersion: 1,
      candidateId: trade.candidate.candidateId,
      source: "LONG_VOL",
      marketId: "NIFTY",
      structure: "STRANGLE",
      expiry: "2026-10-06",
      dataSource: "MANUAL",
      combinedEntryPremium: 120.75,
      lotSize: 65,
      lots: 1,
      spot: 22831.15,
      expectedMove: 230,
      impliedMove: 180,
      expectedNetEdge: 700,
      score: 62,
      capitalRequirement: 8098.75,
    });
    expect(e?.legs).toEqual([
      { optionType: "CE", strike: 22900, instrument: CE_ID, entryAsk: 69.8, entryBid: 69.0 },
      { optionType: "PE", strike: 22800, instrument: PE_ID, entryAsk: 50.95, entryBid: 50.2 },
    ]);
    expect(e?.capturedAt).toMatch(/^2026-09-28T/);
    expect(e?.risk.result.riskLevel).toBe("LOW");
    expect(e?.dataCompleteness).toEqual({ complete: true, missing: [] });
  });

  it("the strategy outputs are stored exactly as supplied: Risk never recalculates Score or Expected Net Edge", async () => {
    const svc = makeService();
    const trade = ok(await svc.service.confirm(await reviewed(svc, longVolRaw({ score: 17, expectedNetEdge: -50, expectedMove: 1, impliedMove: 2 })), { confirmed: true }));
    expect(trade.entry).toMatchObject({ score: 17, expectedNetEdge: -50, expectedMove: 1, impliedMove: 2 });
  });

  it("records which market data was missing (completeness state)", async () => {
    const svc = makeService();
    const raw = longVolRaw({ spot: undefined, legs: [
      { optionType: "CE", strike: 22900, quote: { bid: 69, ask: 69.8 } },
      { optionType: "PE", strike: 22800, quote: { bid: 50.2, ask: 50.95, volume: 100, oi: 100, bidQty: 10, askQty: 10 } },
    ] });
    const trade = ok(await svc.service.confirm(await reviewed(svc, raw), { confirmed: true }));
    expect(trade.entry?.dataCompleteness.complete).toBe(false);
    expect(trade.entry?.dataCompleteness.missing).toEqual(["spot", "CE 22900.volume", "CE 22900.oi", "CE 22900.bidQty", "CE 22900.askQty"]);
  });

  it("is immutable in memory: it is deeply frozen", async () => {
    const svc = makeService();
    const trade = ok(await svc.service.confirm(await reviewed(svc), { confirmed: true }));
    expect(Object.isFrozen(trade.entry)).toBe(true);
    expect(Object.isFrozen(trade.entry?.legs)).toBe(true);
    expect(() => {
      (trade.entry as { combinedEntryPremium: number }).combinedEntryPremium = 1;
    }).toThrow(TypeError);
    expect(() => {
      (trade.entry?.risk.result as { riskLevel: string }).riskLevel = "HIGH";
    }).toThrow(TypeError);
  });

  it("is immutable in storage: a second entry is rejected", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const stored = (await svc.repository.getTrade(id)) as PaperTradeRecord;
    await expect(svc.repository.updateLifecycle(id, { updatedAt: "x", state: "PAPER_OPEN", entry: stored.entry as NonNullable<typeof stored.entry> }, { timestamp: "x", type: "TRADE_OPENED", tradeId: id, fromState: "PAPER_OPEN", toState: "PAPER_OPEN" })).rejects.toMatchObject({ code: "ENTRY_IMMUTABLE" });
  });
});

describe("entry risk is preserved separately from current risk", () => {
  it("monitoring with a wide spread changes CURRENT risk to HIGH while ENTRY risk stays LOW, byte for byte", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const before = ok(await svc.service.getTrade(id)).trade;
    expect(before.entry?.risk.result.riskLevel).toBe("LOW");
    expect(before.currentRisk?.result.riskLevel).toBe("LOW");

    const wide = {
      quotes: [
        { instrument: CE_ID, bid: 60, ask: 75, volume: 7000, oi: 12000, bidQty: 6500, askQty: 6500 },
        { instrument: PE_ID, bid: 45, ask: 58, volume: 7000, oi: 12000, bidQty: 6500, askQty: 6500 },
      ],
      tradingDaysToExpiry: 7,
      spot: 22831.15,
    };
    const after = ok(await svc.service.monitor(id, wide));
    expect(after.currentRisk?.result.riskLevel).toBe("HIGH"); // spread (133-105)/133 = 21% is a critical HIGH
    expect(after.entry?.risk.result.riskLevel).toBe("LOW");
    expect(JSON.stringify(after.entry)).toBe(JSON.stringify(before.entry));
    expect(after.lastMonitor?.currentRisk.result.riskLevel).toBe("HIGH");
  });

  it("current risk never carries stale MARKET data: a missing ask makes current risk INSUFFICIENT, not a reused entry spread", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const after = ok(await svc.service.monitor(id, { quotes: [{ instrument: CE_ID, bid: 66.05 }, { instrument: PE_ID, bid: 54 }], tradingDaysToExpiry: 7 }));
    expect(after.currentRisk?.result).toMatchObject({ riskLevel: null, riskDataStatus: "INSUFFICIENT" });
    expect(after.entry?.risk.result.riskLevel).toBe("LOW");
  });

  it("lists what was carried from entry (strategy outputs and capital), for transparency", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const after = ok(await svc.service.monitor(id, exitQuotes(66.05, 54, { tradingDaysToExpiry: 7, spot: 22831.15 })));
    expect(after.lastMonitor?.carriedFromEntry).toEqual(expect.arrayContaining(["expectedNetEdge", "iv", "rv20", "maxCapitalAllocation", "entryCosts", "lots", "structure", "capitalUtilization"]));
  });
});

describe("risk is independent of Score and of Expected Net Edge", () => {
  it("two candidates that differ only in Score get identical risk", async () => {
    const a = ok(await makeService().service.beginReview(longVolRaw({ score: 5 })));
    const b = ok(await makeService().service.beginReview(longVolRaw({ score: 95 })));
    expect(a.review.risk.result).toEqual(b.review.risk.result);
  });

  it("Expected Net Edge influences risk ONLY through expectedNetEdgeQuality, and is stored unchanged", async () => {
    const good = ok(await makeService().service.beginReview(longVolRaw({ expectedNetEdge: 700 })));
    const bad = ok(await makeService().service.beginReview(longVolRaw({ expectedNetEdge: -100 })));
    expect(good.review.risk.inputs["expectedNetEdgeQuality"]).toBe(0.0892);
    expect(bad.review.risk.inputs["expectedNetEdgeQuality"]).toBe(-0.0127);
    expect(bad.review.risk.result.riskLevel).toBe("MEDIUM"); // non-critical HIGH factor floors at MEDIUM
    expect(bad.candidate.expectedNetEdge).toBe(-100);
  });

  it("an opportunity Status or Score key sent by a client changes nothing about risk", async () => {
    const a = ok(await makeService().service.beginReview(longVolRaw()));
    const b = ok(await makeService().service.beginReview(longVolRaw({ status: "QUALIFIED", opportunityScore: 99 })));
    expect(b.review.risk.result).toEqual(a.review.risk.result);
  });
});

describe("monitoring and unrealized P&L", () => {
  it("valid bids: unrealized = 65 x (120.05 - 120.75) = -45.50 gross; the last valid exit is recorded", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const t = ok(await svc.service.monitor(id, exitQuotes()));
    expect(t.lastMonitor).toMatchObject({ dataStatus: "VALID", currentExitPremium: 120.05 });
    expect(t.lastMonitor?.unrealized).toMatchObject({ status: "VALID", grossPnl: -45.5, netPnl: null, netStatus: "COSTS_UNAVAILABLE" });
    expect(t.lastValidExit?.exitPremium).toBe(120.05);
    expect(t.state).toBe("PAPER_OPEN");
  });

  it("with exit costs supplied, unrealized net is shown", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const t = ok(await svc.service.monitor(id, exitQuotes(66.05, 54, { exitCosts: 240 })));
    expect(t.lastMonitor?.unrealized).toMatchObject({ grossPnl: -45.5, netPnl: -535.5, netStatus: "VALID" });
  });

  it("a missing bid -> DATA_INSUFFICIENT; the previous valid exit is kept, not overwritten", async () => {
    const svc = makeService();
    const id = await opened(svc);
    ok(await svc.service.monitor(id, exitQuotes()));
    const t = ok(await svc.service.monitor(id, exitQuotes(66.05, null)));
    expect(t.lastMonitor).toMatchObject({ dataStatus: "DATA_INSUFFICIENT", currentExitPremium: null });
    expect(t.lastMonitor?.unrealized).toMatchObject({ status: "DATA_INSUFFICIENT", grossPnl: null });
    expect(t.lastValidExit?.exitPremium).toBe(120.05);
  });

  it("every monitor update is journaled", async () => {
    const svc = makeService();
    const id = await opened(svc);
    ok(await svc.service.monitor(id, exitQuotes()));
    ok(await svc.service.monitor(id, exitQuotes(65, 53)));
    expect(await eventTypes(svc, id)).toEqual(["REVIEW_STARTED", "TRADE_OPENED", "MONITOR_SNAPSHOT", "MONITOR_SNAPSHOT"]);
  });
});

describe("PAPER_OPEN -> PAPER_EXITED (P&L from executable bids only)", () => {
  it("exits at CE Bid + PE Bid: realized gross -45.50", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const t = ok(await svc.service.exit(id, exitQuotes()));
    expect(t.state).toBe("PAPER_EXITED");
    expect(t.exit).toMatchObject({ trigger: "USER_EXIT", basis: "CURRENT_QUOTE", exitPremium: 120.05 });
    expect(t.realizedPnl).toMatchObject({ status: "VALID", grossPnl: -45.5 });
    expect(await eventTypes(svc, id)).toEqual(["REVIEW_STARTED", "TRADE_OPENED", "TRADE_EXITED"]);
  });

  it("realized net uses both cost figures: gross -45.50 - 250 - 240 = -535.50", async () => {
    const svc = makeService();
    const t = ok(await svc.service.exit(await opened(svc), exitQuotes(66.05, 54, { exitCosts: 240 })));
    expect(t.realizedPnl).toMatchObject({ grossPnl: -45.5, netPnl: -535.5, netStatus: "VALID" });
  });

  it.each([
    ["missing CE bid", exitQuotes(null, 54)],
    ["missing PE bid", exitQuotes(66.05, null)],
    ["both bids missing", exitQuotes(null, null)],
    ["zero CE bid", exitQuotes(0, 54)],
  ])("%s -> DATA_INSUFFICIENT: the trade stays PAPER_OPEN and no exit price is invented", async (_name, body) => {
    const svc = makeService();
    const id = await opened(svc);
    const e = err(await svc.service.exit(id, body));
    expect(e.code).toBe("DATA_INSUFFICIENT");
    expect(e.trade?.state).toBe("PAPER_OPEN");
    expect(e.trade?.exit).toBeNull();
    expect(e.trade?.realizedPnl).toBeNull();
    expect(await eventTypes(svc, id)).toEqual(["REVIEW_STARTED", "TRADE_OPENED", "EXIT_REJECTED_DATA_INSUFFICIENT"]);
  });

  it("LTP is never a substitute: quotes carrying only an LTP do not exit the trade", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const e = err(await svc.service.exit(id, { quotes: [{ instrument: CE_ID, bid: null, ltp: 66.5 }, { instrument: PE_ID, bid: null, ltp: 54.2 }] }));
    expect(e.code).toBe("DATA_INSUFFICIENT");
    expect(e.trade?.state).toBe("PAPER_OPEN");
  });

  it("quotes for another strike or another expiry are not substituted", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const otherStrike = { provider: "manual", id: "NIFTY|2026-10-06|CE|23000" };
    const otherExpiry = { provider: "manual", id: "NIFTY|2026-10-13|PE|22800" };
    const e = err(await svc.service.exit(id, { quotes: [{ instrument: otherStrike, bid: 66.05 }, { instrument: otherExpiry, bid: 54 }] }));
    expect(e.code).toBe("DATA_INSUFFICIENT");
    expect(e.details?.join()).toMatch(/no quote supplied for this exact instrument/);
    expect(e.trade?.state).toBe("PAPER_OPEN");
  });

  it("an exited trade is final: a second exit is an INVALID_TRANSITION", async () => {
    const svc = makeService();
    const id = await opened(svc);
    ok(await svc.service.exit(id, exitQuotes()));
    expect(err(await svc.service.exit(id, exitQuotes())).code).toBe("INVALID_TRANSITION");
    expect(err(await svc.service.monitor(id, exitQuotes())).code).toBe("INVALID_TRANSITION");
  });
});

describe("expiry and safety closure (deterministic; no invented prices)", () => {
  it("before expiry and below the holding limit: nothing happens and nothing is journaled", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const before = await eventTypes(svc, id);
    const r = ok(await svc.service.runSafetyCheck(id, { asOf: "2026-10-01T10:00:00+05:30", completedSessions: 1 }));
    expect(r.decision.action).toBe("NONE");
    expect(r.trade.state).toBe("PAPER_OPEN");
    expect(await eventTypes(svc, id)).toEqual(before);
  });

  it("the expiry day itself is not expired", async () => {
    const svc = makeService();
    const id = await opened(svc);
    expect(ok(await svc.service.runSafetyCheck(id, { asOf: "2026-10-06T10:00:00+05:30" })).decision.action).toBe("NONE");
  });

  it("an unknown number of completed sessions is reported as not evaluated, never estimated", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const r = ok(await svc.service.runSafetyCheck(id, { asOf: "2026-10-01T10:00:00+05:30" }));
    expect(r.decision.notEvaluated[0]).toMatch(/HOLDING_LIMIT not evaluated/);
    expect(r.trade.state).toBe("PAPER_OPEN");
  });

  it("EXPIRY with last valid monitored bids: PAPER_EXPIRED, priced from them, clearly labelled as not current", async () => {
    const svc = makeService();
    const id = await opened(svc);
    ok(await svc.service.monitor(id, exitQuotes()));
    const r = ok(await svc.service.runSafetyCheck(id, { asOf: "2026-10-07T09:20:00+05:30" }));
    expect(r.decision.action).toBe("EXPIRE");
    expect(r.trade.state).toBe("PAPER_EXPIRED");
    expect(r.trade.exit).toMatchObject({ trigger: "EXPIRY", basis: "LAST_VALID_MONITOR_BID", exitPremium: 120.05 });
    expect(r.trade.exit?.notes[0]).toMatch(/Not a current quote/);
    expect(r.trade.realizedPnl).toMatchObject({ status: "VALID", grossPnl: -45.5 });
    expect((await eventTypes(svc, id)).at(-1)).toBe("TRADE_EXPIRED");
  });

  it("EXPIRY with NO valid price ever: PAPER_EXPIRED, exit price null, P&L DATA_INSUFFICIENT (nothing fabricated)", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const r = ok(await svc.service.runSafetyCheck(id, { asOf: "2026-10-07T09:20:00+05:30" }));
    expect(r.trade.state).toBe("PAPER_EXPIRED");
    expect(r.trade.exit).toMatchObject({ basis: "NONE", exitPremium: null });
    expect(r.trade.exit?.legBids.every((b) => b.bid === null)).toBe(true);
    expect(r.trade.realizedPnl).toMatchObject({ status: "DATA_INSUFFICIENT", grossPnl: null, netPnl: null });
  });

  it("EXPIRY after only an INVALID monitor update still has no price (an invalid snapshot is never promoted)", async () => {
    const svc = makeService();
    const id = await opened(svc);
    ok(await svc.service.monitor(id, exitQuotes(66.05, null)));
    const r = ok(await svc.service.runSafetyCheck(id, { asOf: "2026-10-07T09:20:00+05:30" }));
    expect(r.trade.exit?.basis).toBe("NONE");
    expect(r.trade.realizedPnl?.status).toBe("DATA_INSUFFICIENT");
  });

  it("HOLDING LIMIT with current valid bids: PAPER_AUTO_CLOSED at those bids", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const r = ok(await svc.service.runSafetyCheck(id, { asOf: "2026-10-01T15:00:00+05:30", completedSessions: 2, ...exitQuotes() }));
    expect(r.decision.action).toBe("AUTO_CLOSE");
    expect(r.trade.state).toBe("PAPER_AUTO_CLOSED");
    expect(r.trade.exit).toMatchObject({ trigger: "HOLDING_LIMIT", basis: "CURRENT_QUOTE", exitPremium: 120.05 });
    expect(r.trade.realizedPnl?.grossPnl).toBe(-45.5);
    expect((await eventTypes(svc, id)).at(-1)).toBe("TRADE_AUTO_CLOSED");
  });

  it("HOLDING LIMIT with no valid price: closed, lifecycle recorded, P&L DATA_INSUFFICIENT", async () => {
    const svc = makeService();
    const id = await opened(svc);
    const r = ok(await svc.service.runSafetyCheck(id, { asOf: "2026-10-01T15:00:00+05:30", completedSessions: 3 }));
    expect(r.trade.state).toBe("PAPER_AUTO_CLOSED");
    expect(r.trade.exit?.exitPremium).toBeNull();
    expect(r.trade.realizedPnl?.status).toBe("DATA_INSUFFICIENT");
  });

  it("a closed trade cannot be safety-checked again", async () => {
    const svc = makeService();
    const id = await opened(svc);
    ok(await svc.service.runSafetyCheck(id, { asOf: "2026-10-07" }));
    expect(err(await svc.service.runSafetyCheck(id, { asOf: "2026-10-08" })).code).toBe("INVALID_TRANSITION");
  });
});

describe("one lifecycle for LONG VOL and Best Opportunities", () => {
  it("LONG VOL STRADDLE: entry = CE Ask + PE Ask", async () => {
    const svc = makeService();
    const raw = longVolRaw({ structure: "STRADDLE", legs: [
      { optionType: "CE", strike: 22850, quote: { bid: 100, ask: 101, volume: 9000, oi: 20000, bidQty: 6500, askQty: 6500 } },
      { optionType: "PE", strike: 22850, quote: { bid: 90, ask: 91, volume: 9000, oi: 20000, bidQty: 6500, askQty: 6500 } },
    ] });
    const t = ok(await svc.service.confirm(await reviewed(svc, raw), { confirmed: true }));
    expect(t.entry?.combinedEntryPremium).toBe(192);
    expect(t.entry?.structure).toBe("STRADDLE");
  });

  it("Best Opportunities SINGLE_CALL: entry = the CE ask, exit = the CE bid, gross = 65 x (66.05 - 69.80) = -243.75", async () => {
    const svc = makeService();
    const raw = longVolRaw({ source: "BEST_OPPORTUNITY", structure: "SINGLE_CALL", legs: [{ optionType: "CE", strike: 22900, quote: { bid: 69, ask: 69.8, volume: 6000, oi: 12000, bidQty: 6500, askQty: 6500 } }] });
    const id = await opened(svc, raw);
    const t = ok(await svc.service.exit(id, { quotes: [{ instrument: CE_ID, bid: 66.05 }] }));
    expect(t.source).toBe("BEST_OPPORTUNITY");
    expect(t.entry?.combinedEntryPremium).toBe(69.8);
    expect(t.realizedPnl?.grossPnl).toBe(-243.75);
    expect(t.state).toBe("PAPER_EXITED");
  });

  it("a Best Opportunities trade needs no broker, and uses the same journal and lifecycle events", async () => {
    const svc = makeService();
    const raw = longVolRaw({ source: "BEST_OPPORTUNITY", structure: "SINGLE_PUT", legs: [{ optionType: "PE", strike: 22800, quote: { bid: 50.2, ask: 50.95, volume: 6000, oi: 12000, bidQty: 6500, askQty: 6500 } }] });
    const id = await opened(svc, raw);
    expect(await eventTypes(svc, id)).toEqual(["REVIEW_STARTED", "TRADE_OPENED"]);
  });
});

describe("listing, risk filter and export", () => {
  async function three() {
    const svc = makeService();
    const low = await opened(svc);
    const high = await opened(svc, longVolRaw({ legs: [
      { optionType: "CE", strike: 22900, quote: { bid: 60, ask: 75, volume: 6000, oi: 12000, bidQty: 6500, askQty: 6500 } },
      { optionType: "PE", strike: 22800, quote: { bid: 45, ask: 58, volume: 6000, oi: 12000, bidQty: 6500, askQty: 6500 } },
    ] }));
    const unknown = await opened(svc, longVolRaw({ maxCapitalAllocation: null, requestedLots: 1 }));
    return { svc, low, high, unknown };
  }

  it("filters by current risk: ALL / LOW / MEDIUM / HIGH, and unknown risk appears only under ALL", async () => {
    const { svc, low, high, unknown } = await three();
    const ids = async (risk: "ALL" | "LOW" | "MEDIUM" | "HIGH") => (await svc.service.listTrades({ risk })).map((t) => t.tradeId);
    expect(await ids("ALL")).toEqual([low, high, unknown]);
    expect(await ids("LOW")).toEqual([low]);
    expect(await ids("HIGH")).toEqual([high]);
    expect(await ids("MEDIUM")).toEqual([]);
    for (const f of ["LOW", "MEDIUM", "HIGH"] as const) expect(await ids(f)).not.toContain(unknown);
  });

  it("the risk filter does not change any trade's Score or Expected Net Edge", async () => {
    const { svc } = await three();
    const all = await svc.service.listTrades({ risk: "ALL" });
    const filtered = await svc.service.listTrades({ risk: "LOW" });
    expect(filtered[0]?.entry?.score).toBe(all[0]?.entry?.score);
    expect(filtered[0]?.entry?.expectedNetEdge).toBe(all[0]?.entry?.expectedNetEdge);
  });

  it("filters by lifecycle state", async () => {
    const svc = makeService();
    const a = await opened(svc);
    await reviewed(svc);
    expect((await svc.service.listTrades({ states: ["PAPER_OPEN"] })).map((t) => t.tradeId)).toEqual([a]);
    expect((await svc.service.listTrades({ states: ["PAPER_REVIEW"] })).length).toBe(1);
  });

  it("exports the whole journal as plain JSON with counts and a durability notice", async () => {
    const svc = makeService();
    const id = await opened(svc);
    ok(await svc.service.exit(id, exitQuotes()));
    const exp = await svc.service.exportJournal();
    expect(exp).toMatchObject({ exportVersion: 1, app: "nse-smart-trader-v2", counts: { trades: 1, events: 3 } });
    expect(exp.durabilityNotice).toMatch(/NOT guaranteed durable/);
    expect(exp.trades[0]?.entry?.combinedEntryPremium).toBe(120.75);
    expect(JSON.parse(JSON.stringify(exp))).toEqual(exp);
  });
});
