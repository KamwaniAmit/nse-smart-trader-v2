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
  // Final review: rewritten. An opaque instrument ({ provider: "p", id: "abc" }) used to be accepted, but its expiry cannot
  // be verified, so it could bypass the expiry cutoff; it is now refused (tests below). A supplied, consistent instrument is
  // still kept exactly as given (never rewritten).
  it("keeps a supplied instrument identity exactly (a manual instrument naming the candidate expiry)", () => {
    const supplied = { provider: "manual", id: "NIFTY|2026-10-06|CE|22900" };
    const r = parse(longVolRaw({ legs: [{ ...ce(22900), instrument: supplied }, pe(22800)] }));
    if (!r.ok) throw new Error("parse failed");
    expect(r.value.legs[0]?.instrument).toEqual(supplied);
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
  // Phase 1B.1 (D3): asOf is now OPTIONAL and untrusted (the server clock decides expiry and safety), and an event
  // time must be a full timestamp with a zone. A bare date is ambiguous and is rejected.
  it("safety check: asOf is optional but must be a full timestamp with a zone; completedSessions must be a whole number", () => {
    expect(parseSafetyCheckRequest({}).ok).toBe(true);
    expect(parseSafetyCheckRequest({ asOf: "2026-10-07T09:20:00+05:30" }).ok).toBe(true);
    expect(parseSafetyCheckRequest({ asOf: "2026-10-07" }).ok).toBe(false);
    expect(parseSafetyCheckRequest({ completedSessions: 1.5 }).ok).toBe(false);
    expect(parseSafetyCheckRequest({ asOf: "not a date" }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Final review: an explicit leg instrument must identify exactly the leg's contract. The existing manual format
// "<market>|<YYYY-MM-DD>|<CE or PE>|<strike>" is compared part by part with what the parser's own builder produces
// (marketId, expiry, optionType, String(strike)). Nothing is rewritten and no other normalisation is applied.
describe("final review: an explicit instrument must match market, expiry, option type and strike", () => {
  const withCe = (instrument: unknown, over: Record<string, unknown> = {}) => longVolRaw({ legs: [{ ...ce(22900), instrument }, pe(22800)], ...over });
  const m = (id: string) => ({ provider: "manual", id });
  const ceErrors = (id: string, over: Record<string, unknown> = {}) => errorsOf(withCe(m(id), over)).filter((e) => e.startsWith("legs[0].instrument: "));

  it("matching instruments on every supported leg type (CE and PE) are accepted and kept exactly", () => {
    const r = parse(longVolRaw({ legs: [{ ...ce(22900), instrument: m("NIFTY|2026-10-06|CE|22900") }, { ...pe(22800), instrument: m("NIFTY|2026-10-06|PE|22800") }] }));
    if (!r.ok) throw new Error(`parse failed: ${r.errors.join("; ")}`);
    expect(r.value.expiry).toBe("2026-10-06");
    expect(r.value.legs.map((l) => l.instrument.id)).toEqual(["NIFTY|2026-10-06|CE|22900", "NIFTY|2026-10-06|PE|22800"]);
  });
  it("a matching instrument on a single-leg structure (SINGLE_PUT) and another market (BANKNIFTY) is accepted", () => {
    expect(parse(longVolRaw({ source: "BEST_OPPORTUNITY", structure: "SINGLE_PUT", legs: [{ ...pe(22800), instrument: m("NIFTY|2026-10-06|PE|22800") }] })).ok).toBe(true);
    expect(parse(longVolRaw({ marketId: "BANKNIFTY", legs: [{ ...ce(52000), instrument: m("BANKNIFTY|2026-10-06|CE|52000") }, pe(51500)] })).ok).toBe(true);
  });
  it("a fractional strike matches when written as the builder writes it", () => {
    expect(parse(longVolRaw({ legs: [{ ...ce(22900.5), instrument: m("NIFTY|2026-10-06|CE|22900.5") }, pe(22800)] })).ok).toBe(true);
  });
  it.each([
    ["market mismatch", "BANKNIFTY|2026-10-06|CE|22900", /instrument market "BANKNIFTY" does not match the market "NIFTY" \(neither is rewritten\)/],
    ["option-type mismatch", "NIFTY|2026-10-06|PE|22900", /instrument option type "PE" does not match the option type "CE"/],
    ["strike mismatch", "NIFTY|2026-10-06|CE|23000", /instrument strike "23000" does not match the strike "22900"/],
    ["strike written differently", "NIFTY|2026-10-06|CE|22900.0", /instrument strike "22900.0" does not match the strike "22900"/],
    ["later expiry", "NIFTY|2026-12-29|CE|22900", /instrument expiry "2026-12-29" does not match the expiry "2026-10-06" \(neither is rewritten\)/],
    ["earlier expiry", "NIFTY|2026-09-29|CE|22900", /instrument expiry "2026-09-29" does not match the expiry "2026-10-06"/],
    ["missing expiry", "NIFTY||CE|22900", /has no expiry/],
    ["impossible date", "NIFTY|2026-13-40|CE|22900", /not a real calendar date/],
    ["non-ISO date", "NIFTY|06-10-2026|CE|22900", /not a real calendar date/],
    ["date with a time", "NIFTY|2026-10-06T15:30|CE|22900", /not a real calendar date/],
    ["empty market", "|2026-10-06|CE|22900", /with no empty part/],
    ["empty option type", "NIFTY|2026-10-06||22900", /with no empty part/],
    ["empty strike", "NIFTY|2026-10-06|CE|", /with no empty part/],
    ["too few parts", "NIFTY|2026-10-06|CE", /must be "<market>\|<expiry YYYY-MM-DD>\|<CE or PE>\|<strike>"/],
    ["too many parts", "NIFTY|2026-10-06|CE|22900|x", /must be "<market>\|<expiry YYYY-MM-DD>\|<CE or PE>\|<strike>"/],
  ])("%s is refused (legs[0].instrument) and the candidate is not accepted", (_n, id, message) => {
    expect(ceErrors(id).some((e) => message.test(e))).toBe(true);
  });
  it("every mismatching part is reported, not just the first", () => {
    expect(ceErrors("BANKNIFTY|2026-12-29|PE|23000")).toHaveLength(4);
  });
  it("an opaque provider is refused: none of its fields can be verified (it could bypass the cutoff)", () => {
    expect(errorsOf(withCe({ provider: "p", id: "abc" })).join(" ")).toMatch(/legs\[0\]\.instrument: a "p" instrument cannot be verified/);
  });
  it("an invalid structured field reports its own error; the instrument is not also compared with it", () => {
    const errors = errorsOf(withCe(m("NIFTY|2026-10-06|CE|22900"), { expiry: "2026-02-30" }));
    expect(errors).toContain("expiry must be a real calendar date, YYYY-MM-DD");
    expect(errors.join(" ")).not.toMatch(/does not match/);
  });
  it("a leg with no explicit instrument still gets the manual identity built from the structured fields", () => {
    const r = parse(longVolRaw());
    if (!r.ok) throw new Error("parse failed");
    expect(r.value.legs.map((l) => l.instrument)).toEqual([CE_ID, PE_ID]);
  });
});
