import { describe, expect, it } from "vitest";
import { MARKET_DISPLAY_NAMES, MARKET_IDS, getMarketDefinitions } from "../src/index.js";

const UNRESOLVED_FIELDS = [
  "exchange",
  "segment",
  "underlyingKind",
  "instrumentKey",
  "lotSize",
  "tickSize",
  "expiryRules",
  "strikeRules",
  "tradingHours",
  "currency",
  "derivativesAvailability",
] as const;

describe("market definitions", () => {
  const definitions = getMarketDefinitions();

  it("defines exactly the six requested markets, in order", () => {
    expect(definitions.map((d) => d.marketId)).toEqual(["NIFTY", "BANKNIFTY", "SMALLCAP", "GOLD", "SILVER", "CRUDEOIL"]);
    expect(definitions.map((d) => d.marketId)).toEqual([...MARKET_IDS]);
  });

  it("uses the requested display names", () => {
    expect(MARKET_DISPLAY_NAMES.BANKNIFTY).toBe("BANK NIFTY");
    expect(MARKET_DISPLAY_NAMES.SMALLCAP).toBe("SMALL CAP");
    expect(MARKET_DISPLAY_NAMES.CRUDEOIL).toBe("CRUDE OIL");
  });

  it("leaves every instrument/contract field explicitly UNRESOLVED (nothing invented)", () => {
    for (const definition of definitions) {
      for (const field of UNRESOLVED_FIELDS) {
        expect(definition[field].status, `${definition.marketId}.${field}`).toBe("UNRESOLVED");
      }
    }
  });

  it("has no invented instrument key", () => {
    for (const d of definitions) expect(d.instrumentKey.status).toBe("UNRESOLVED");
  });

  it("has no invented lot size or tick size", () => {
    for (const d of definitions) {
      expect(d.lotSize.status).toBe("UNRESOLVED");
      expect(d.tickSize.status).toBe("UNRESOLVED");
    }
  });

  it("has no invented expiry, strike or trading-hours rules", () => {
    for (const d of definitions) {
      expect(d.expiryRules.status).toBe("UNRESOLVED");
      expect(d.strikeRules.status).toBe("UNRESOLVED");
      expect(d.tradingHours.status).toBe("UNRESOLVED");
    }
  });

  it("flags only SMALLCAP as requiring explicit resolution", () => {
    expect(definitions.filter((d) => d.requiresExplicitResolution).map((d) => d.marketId)).toEqual(["SMALLCAP"]);
  });

  it("explains in plain words that SMALL CAP is not a defined instrument", () => {
    const smallCap = definitions.find((d) => d.marketId === "SMALLCAP");
    expect(smallCap?.instrumentKey.status === "UNRESOLVED" && smallCap.instrumentKey.reason).toMatch(/not a defined instrument/i);
  });

  it("is frozen so callers cannot mutate the catalogue", () => {
    expect(Object.isFrozen(definitions)).toBe(true);
    expect(Object.isFrozen(definitions[0])).toBe(true);
  });
});
