import { describe, expect, it } from "vitest";
import { InstrumentSubstitutionError, MARKET_IDS, NotConfiguredResolver, assertNoSubstitution } from "../src/index.js";
import type { ResolutionResult } from "../src/index.js";

describe("NotConfiguredResolver", () => {
  const resolver = new NotConfiguredResolver();

  it("returns NOT_CONFIGURED for every market, echoing the requested market", async () => {
    for (const marketId of MARKET_IDS) {
      const result = await resolver.resolveMarket(marketId);
      expect(result.status).toBe("NOT_CONFIGURED");
      expect(result.marketId).toBe(marketId);
    }
  });

  it("says SMALL CAP needs explicit resolution", async () => {
    const result = await resolver.resolveMarket("SMALLCAP");
    expect(result.status === "NOT_CONFIGURED" && result.reason).toMatch(/explicit resolution/i);
  });
});

describe("assertNoSubstitution", () => {
  it("accepts a result for the requested market", () => {
    const ok: ResolutionResult = { status: "NOT_CONFIGURED", marketId: "GOLD", reason: "x" };
    expect(() => assertNoSubstitution("GOLD", ok)).not.toThrow();
  });

  it("rejects a result for a different market", () => {
    const wrong: ResolutionResult = { status: "NOT_CONFIGURED", marketId: "NIFTY", reason: "x" };
    expect(() => assertNoSubstitution("SMALLCAP", wrong)).toThrow(InstrumentSubstitutionError);
  });

  it("rejects substitution even when the other result is RESOLVED", () => {
    const wrong: ResolutionResult = { status: "RESOLVED", marketId: "NIFTY", ref: { provider: "test", id: "1" } };
    try {
      assertNoSubstitution("SMALLCAP", wrong);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as InstrumentSubstitutionError).code).toBe("INSTRUMENT_SUBSTITUTION");
    }
  });
});
