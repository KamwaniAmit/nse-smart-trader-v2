import { describe, expect, it } from "vitest";
import { assessEntry, computeCapital, computePnl, exitPremiumOf, parseCandidateInput, resolveLegBids } from "../src/index.js";
import type { LegQuoteDTO, PaperCandidate } from "../src/index.js";
import { CE_ID, PE_ID, longVolRaw } from "./fixtures.js";

const candidate = (over: Record<string, unknown> = {}): PaperCandidate => {
  const p = parseCandidateInput(longVolRaw(over), { now: "2026-09-28T10:00:00Z", newId: () => "x" });
  if (!p.ok) throw new Error(p.errors.join("; "));
  return p.value;
};
const q = (instrument: { provider: string; id: string }, bid: number | null, extra: Partial<LegQuoteDTO> = {}): LegQuoteDTO => ({ instrument, bid, ...extra });

describe("entry premium = CE Ask + PE Ask (frozen)", () => {
  it("is exactly 120.75 for asks 69.8 + 50.95 (no floating-point drift)", () => {
    const e = assessEntry(candidate());
    expect(e.status).toBe("EXECUTABLE");
    expect(e.combinedEntryPremium).toBe(120.75);
  });

  it("is never the bids, midpoint or LTP", () => {
    const e = assessEntry(candidate({ legs: [
      { optionType: "CE", strike: 22900, quote: { bid: 69.0, ask: 69.8, ltp: 1 } },
      { optionType: "PE", strike: 22800, quote: { bid: 50.2, ask: 50.95, ltp: 2 } },
    ] }));
    expect(e.combinedEntryPremium).toBe(120.75);
  });

  it("reports the combined spread as a percentage of the combined ask", () => {
    expect(assessEntry(candidate()).spreadPct).toBe(1.2836); // (120.75 - 119.20) / 120.75
  });

  it.each([
    ["missing CE ask", 0, { bid: 69.0, ask: null }, "CE 22900: INVALID_ASK"],
    ["missing PE bid", 1, { bid: null, ask: 50.95 }, "PE 22800: INVALID_BID"],
    ["zero ask", 0, { bid: 69.0, ask: 0 }, "CE 22900: INVALID_ASK"],
    ["crossed market", 0, { bid: 70, ask: 69.8 }, "CE 22900: CROSSED_MARKET"],
  ])("DATA_INSUFFICIENT with no premium: %s", (_name, index, quote, reason) => {
    const legs = [
      { optionType: "CE", strike: 22900, quote: { bid: 69.0, ask: 69.8 } },
      { optionType: "PE", strike: 22800, quote: { bid: 50.2, ask: 50.95 } },
    ];
    legs[index as number] = { ...(legs[index as number] as object), quote } as (typeof legs)[number];
    const e = assessEntry(candidate({ legs }));
    expect(e).toMatchObject({ status: "DATA_INSUFFICIENT", combinedEntryPremium: null, spreadPct: null });
    expect(e.reasons).toContain(reason);
  });

  it("does not substitute LTP when the ask is missing", () => {
    const e = assessEntry(candidate({ legs: [
      { optionType: "CE", strike: 22900, quote: { bid: 69.0, ask: null, ltp: 69.5 } },
      { optionType: "PE", strike: 22800, quote: { bid: 50.2, ask: 50.95 } },
    ] }));
    expect(e.status).toBe("DATA_INSUFFICIENT");
    expect(e.combinedEntryPremium).toBeNull();
  });
});

describe("capital (frozen formulas)", () => {
  const base = { combinedEntryPremium: 120.75, lotSize: 65, entryCosts: 250, maxCapitalAllocation: 100000, requestedLots: null };

  it("premiumRequirement = premium x lot size; total = premium requirement + entry costs", () => {
    const c = computeCapital(base);
    expect(c.premiumRequirement).toBe(7848.75);
    expect(c.totalCapitalRequirement).toBe(8098.75);
  });

  it("numberOfLots = floor(allocation / total requirement)", () => {
    const c = computeCapital(base);
    expect(c.numberOfLots).toBe(12); // floor(100000 / 8098.75) = floor(12.35)
    expect(c.lots).toBe(12);
    expect(c.gate).toBe("PASS");
    expect(c.utilizationPct).toBe(97.185);
  });

  it("a requested number of lots is used when it fits the allocation", () => {
    const c = computeCapital({ ...base, requestedLots: 1 });
    expect(c).toMatchObject({ lots: 1, gate: "PASS", utilizationPct: 8.0988 });
  });

  it("the gate FAILS when one lot does not fit, and numberOfLots is 0", () => {
    const c = computeCapital({ ...base, maxCapitalAllocation: 5000 });
    expect(c).toMatchObject({ numberOfLots: 0, gate: "FAIL", lots: null });
  });

  it("the gate FAILS when the requested lots exceed the allocation", () => {
    expect(computeCapital({ ...base, requestedLots: 13 }).gate).toBe("FAIL");
  });

  it("unknown entry costs are NOT guessed: gate NOT_EVALUATED, total null", () => {
    const c = computeCapital({ ...base, entryCosts: null });
    expect(c).toMatchObject({ totalCapitalRequirement: null, numberOfLots: null, gate: "NOT_EVALUATED", utilizationPct: null });
  });

  it("an unknown allocation is NOT guessed", () => {
    expect(computeCapital({ ...base, maxCapitalAllocation: null })).toMatchObject({ gate: "NOT_EVALUATED", numberOfLots: null });
  });

  it("no executable premium means nothing is evaluated", () => {
    expect(computeCapital({ ...base, combinedEntryPremium: null })).toMatchObject({ premiumRequirement: null, gate: "NOT_EVALUATED" });
  });
});

describe("exit premium = CE Bid + PE Bid, matched by exact instrument", () => {
  const legs = [{ instrument: CE_ID }, { instrument: PE_ID }];

  it("is exactly 120.05 for bids 66.05 + 54.00", () => {
    const r = resolveLegBids(legs, [q(CE_ID, 66.05), q(PE_ID, 54)]);
    expect(exitPremiumOf(r.bids)).toBe(120.05);
  });

  it("missing CE bid -> no premium", () => {
    const r = resolveLegBids(legs, [q(CE_ID, null), q(PE_ID, 54)]);
    expect(exitPremiumOf(r.bids)).toBeNull();
    expect(r.reasons[0]).toMatch(/22900.*bid is missing or not positive/);
  });

  it("missing PE bid -> no premium", () => {
    const r = resolveLegBids(legs, [q(CE_ID, 66.05), q(PE_ID, null)]);
    expect(exitPremiumOf(r.bids)).toBeNull();
  });

  it("a quote that carries only an LTP gives no bid: LTP is never substituted", () => {
    const r = resolveLegBids(legs, [q(CE_ID, null, { ltp: 66.5 }), q(PE_ID, 54)]);
    expect(exitPremiumOf(r.bids)).toBeNull();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("a bid of %s is not a price", (bad) => {
    expect(exitPremiumOf(resolveLegBids(legs, [q(CE_ID, bad), q(PE_ID, 54)]).bids)).toBeNull();
  });

  it("a quote for ANOTHER STRIKE is ignored, never substituted", () => {
    const otherStrike = { provider: "manual", id: "NIFTY|2026-10-06|CE|23000" };
    const r = resolveLegBids(legs, [q(otherStrike, 66.05), q(PE_ID, 54)]);
    expect(exitPremiumOf(r.bids)).toBeNull();
    expect(r.reasons[0]).toMatch(/no quote supplied for this exact instrument/);
  });

  it("a quote for ANOTHER EXPIRY is ignored, never substituted", () => {
    const otherExpiry = { provider: "manual", id: "NIFTY|2026-10-13|CE|22900" };
    expect(exitPremiumOf(resolveLegBids(legs, [q(otherExpiry, 66.05), q(PE_ID, 54)]).bids)).toBeNull();
  });

  it("a quote for ANOTHER INSTRUMENT PROVIDER with the same id is ignored", () => {
    const otherProvider = { provider: "other", id: CE_ID.id };
    expect(exitPremiumOf(resolveLegBids(legs, [q(otherProvider, 66.05), q(PE_ID, 54)]).bids)).toBeNull();
  });

  it("quotes for unrelated instruments are ignored when the exact ones are present", () => {
    const noise = q({ provider: "manual", id: "NIFTY|2026-10-06|CE|23500" }, 1);
    expect(exitPremiumOf(resolveLegBids(legs, [noise, q(CE_ID, 66.05), q(PE_ID, 54)]).bids)).toBe(120.05);
  });

  it("conflicting duplicate quotes for one instrument are ambiguous, so not used", () => {
    expect(exitPremiumOf(resolveLegBids(legs, [q(CE_ID, 66.05), q(CE_ID, 60), q(PE_ID, 54)]).bids)).toBeNull();
  });

  it("identical duplicate quotes are fine", () => {
    expect(exitPremiumOf(resolveLegBids(legs, [q(CE_ID, 66.05), q(CE_ID, 66.05), q(PE_ID, 54)]).bids)).toBe(120.05);
  });
});

describe("P&L: valid executable prices only", () => {
  const args = { entryPremium: 120.75, lotSize: 65, lots: 1, entryCosts: null, exitCosts: null };

  it("one lot: 65 x (120.05 - 120.75) = -45.50 gross (legacy number)", () => {
    expect(computePnl({ ...args, exitPremium: 120.05 })).toMatchObject({ status: "VALID", grossPnl: -45.5 });
  });

  it("scales with lots: 12 lots = -546.00", () => {
    expect(computePnl({ ...args, lots: 12, exitPremium: 120.05 }).grossPnl).toBe(-546);
  });

  it("a gain is positive: exit 125.00 -> +276.25 for one lot", () => {
    expect(computePnl({ ...args, exitPremium: 125 }).grossPnl).toBe(276.25);
  });

  it("no exit price -> DATA_INSUFFICIENT with null P&L (never estimated, never zero)", () => {
    expect(computePnl({ ...args, exitPremium: null })).toEqual({
      status: "DATA_INSUFFICIENT",
      reason: expect.stringMatching(/not estimated/),
      grossPnl: null,
      netPnl: null,
      netStatus: "DATA_INSUFFICIENT",
    });
  });

  it("net = gross - entry costs - exit costs, only when BOTH costs are known", () => {
    const p = computePnl({ ...args, exitPremium: 120.05, entryCosts: 250, exitCosts: 240 });
    expect(p).toMatchObject({ grossPnl: -45.5, netPnl: -535.5, netStatus: "VALID" });
  });

  it("with an unknown cost, net is null and labelled COSTS_UNAVAILABLE (gross is still valid)", () => {
    expect(computePnl({ ...args, exitPremium: 120.05, entryCosts: 250, exitCosts: null })).toMatchObject({ status: "VALID", netPnl: null, netStatus: "COSTS_UNAVAILABLE" });
  });
});
