import { describe, expect, it } from "vitest";
import { parseCandidateInput, parseConfirmRequest, parseExitRequest, parseMonitorRequest, parseSafetyCheckRequest } from "../src/index.js";
import { CE_ID, PE_ID, exitQuotes, longVolRaw } from "./fixtures.js";

const ctx = { now: "2026-09-28T10:00:00Z", newId: () => "42" };
const parse = (raw: unknown) => parseCandidateInput(raw, ctx);
const errorsOf = (raw: unknown): string[] => {
  const r = parse(raw);
  if (r.ok) throw new Error("expected a parse error");
  return r.errors;
};
const ce = (strike: number) => ({ optionType: "CE", strike, quote: { bid: 1, ask: 2 } });
const pe = (strike: number) => ({ optionType: "PE", strike, quote: { bid: 1, ask: 2 } });

describe("candidate parsing: LONG VOL structures (frozen definitions)", () => {
  it("accepts a valid STRANGLE (CE strike above PE strike)", () => {
    const r = parse(longVolRaw());
    expect(r.ok).toBe(true);
  });
  it("accepts a valid STRADDLE (same strike)", () => {
    expect(parse(longVolRaw({ structure: "STRADDLE", legs: [ce(22850), pe(22850)] })).ok).toBe(true);
  });
  it("rejects a STRADDLE with different strikes", () => {
    expect(errorsOf(longVolRaw({ structure: "STRADDLE", legs: [ce(22900), pe(22800)] }))).toContain("STRADDLE needs the CE and PE at the same strike");
  });
  it("rejects a STRANGLE whose CE strike is not above the PE strike", () => {
    expect(errorsOf(longVolRaw({ legs: [ce(22800), pe(22900)] }))).toContain("STRANGLE needs the CE strike above the PE strike");
  });
  it("rejects a LONG VOL structure with two CE legs", () => {
    expect(errorsOf(longVolRaw({ legs: [ce(22900), ce(23000)] }))).toContain("STRANGLE needs exactly one CE leg and one PE leg");
  });
  it("rejects LONG VOL with a single-leg structure", () => {
    expect(errorsOf(longVolRaw({ structure: "SINGLE_CALL", legs: [ce(22900)] }))).toContain("LONG_VOL requires structure STRADDLE or STRANGLE");
  });
});

describe("candidate parsing: Best Opportunities (single leg)", () => {
  const bo = (over: Record<string, unknown>) => longVolRaw({ source: "BEST_OPPORTUNITY", ...over });
  it("accepts a SINGLE_CALL with one CE leg", () => {
    expect(parse(bo({ structure: "SINGLE_CALL", legs: [ce(22900)] })).ok).toBe(true);
  });
  it("accepts a SINGLE_PUT with one PE leg", () => {
    expect(parse(bo({ structure: "SINGLE_PUT", legs: [pe(22800)] })).ok).toBe(true);
  });
  it("rejects a SINGLE_CALL given a PE leg", () => {
    expect(errorsOf(bo({ structure: "SINGLE_CALL", legs: [pe(22800)] }))).toContain("SINGLE_CALL needs exactly one CE leg");
  });
  it("rejects BEST_OPPORTUNITY with a two-leg structure", () => {
    expect(errorsOf(bo({}))).toContain("BEST_OPPORTUNITY requires structure SINGLE_CALL or SINGLE_PUT");
  });
});

describe("candidate parsing: strictness (nothing is guessed or repaired)", () => {
  it("assigns an honest MANUAL identity: provider 'manual', id built from market|expiry|type|strike", () => {
    const r = parse(longVolRaw());
    if (!r.ok) throw new Error("parse failed");
    expect(r.value.dataSource).toBe("MANUAL");
    expect(r.value.legs.map((l) => l.instrument)).toEqual([CE_ID, PE_ID]);
  });
  it("keeps a supplied instrument identity exactly", () => {
    const r = parse(longVolRaw({ legs: [{ ...ce(22900), instrument: { provider: "p", id: "abc" } }, pe(22800)] }));
    if (!r.ok) throw new Error("parse failed");
    expect(r.value.legs[0]?.instrument).toEqual({ provider: "p", id: "abc" });
  });
  it("requires an explicit lot size (none is assumed)", () => {
    const raw = longVolRaw();
    delete raw["lotSize"];
    expect(errorsOf(raw)).toContain("lotSize is required (no lot size is assumed)");
  });
  it.each([0, -65, 65.5, "65"])("rejects lot size %s", (bad) => {
    expect(errorsOf(longVolRaw({ lotSize: bad })).length).toBeGreaterThan(0);
  });
  it.each(["2026-13-01", "2026-02-30", "06-10-2026", "tomorrow", 20261006])("rejects expiry %s", (bad) => {
    expect(errorsOf(longVolRaw({ expiry: bad }))).toContain("expiry must be a real calendar date, YYYY-MM-DD");
  });
  it("rejects an unknown market (no substitution)", () => {
    expect(errorsOf(longVolRaw({ marketId: "MIDCAP" }))[0]).toMatch(/marketId must be one of/);
  });
  it("rejects numbers sent as strings (no coercion)", () => {
    expect(errorsOf(longVolRaw({ spot: "22831" }))).toContain("spot must be a finite number or null");
    expect(errorsOf(longVolRaw({ legs: [{ ...ce(22900), quote: { bid: "69", ask: 70 } }, pe(22800)] })).join()).toMatch(/bid must be a finite number or null/);
  });
  it("rejects NaN / Infinity", () => {
    expect(errorsOf(longVolRaw({ spot: Number.POSITIVE_INFINITY }))).toContain("spot must be a finite number or null");
  });
  it("rejects two legs that are the same instrument", () => {
    const same = { provider: "x", id: "same" };
    expect(errorsOf(longVolRaw({ legs: [{ ...ce(22900), instrument: same }, { ...pe(22800), instrument: same }] }))).toContain("Each leg must be a different instrument");
  });
  it("rejects a non-object body and a missing legs array", () => {
    expect(errorsOf("nope")).toEqual(["Request body must be a JSON object"]);
    expect(errorsOf({ ...longVolRaw(), legs: undefined })).toContain("legs must be an array");
  });
  it("treats omitted optional numbers as null (never zero)", () => {
    const r = parse(longVolRaw({ spot: undefined, score: undefined, iv: undefined }));
    if (!r.ok) throw new Error("parse failed");
    expect([r.value.spot, r.value.score, r.value.iv]).toEqual([null, null, null]);
  });
  it("rejects an unknown rvRegime and non-integer tradingDaysToExpiry", () => {
    expect(errorsOf(longVolRaw({ rvRegime: "SIDEWAYS" }))).toContain("rvRegime must be RV_ACCELERATING, RV_DECELERATING or null");
    expect(errorsOf(longVolRaw({ tradingDaysToExpiry: 2.5 }))).toContain("tradingDaysToExpiry must be a whole number");
  });
});

describe("request parsing: confirm, monitor, exit, safety check", () => {
  it("confirm needs a real boolean", () => {
    expect(parseConfirmRequest({ confirmed: true })).toEqual({ ok: true, value: { confirmed: true } });
    expect(parseConfirmRequest({ confirmed: "true" }).ok).toBe(false);
    expect(parseConfirmRequest({}).ok).toBe(false);
    expect(parseConfirmRequest(null).ok).toBe(false);
  });
  it("monitor and exit need a quotes array of exact instruments", () => {
    expect(parseMonitorRequest(exitQuotes()).ok).toBe(true);
    expect(parseExitRequest(exitQuotes()).ok).toBe(true);
    expect(parseExitRequest({}).ok).toBe(false);
    expect(parseExitRequest({ quotes: [{ bid: 5 }] }).ok).toBe(false);
  });
  it("safety check needs asOf; completedSessions must be a whole number", () => {
    expect(parseSafetyCheckRequest({}).ok).toBe(false);
    expect(parseSafetyCheckRequest({ asOf: "2026-10-07" }).ok).toBe(true);
    expect(parseSafetyCheckRequest({ asOf: "2026-10-07", completedSessions: 1.5 }).ok).toBe(false);
    expect(parseSafetyCheckRequest({ asOf: "not a date" }).ok).toBe(false);
  });
});
