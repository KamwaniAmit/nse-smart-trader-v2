import { describe, expect, it } from "vitest";
import { MARKET_IDS } from "@nsest/core";
import { DisabledOrderProvider, NullBrokerAdapter, getBrokerAdapter } from "../src/index.js";

describe("NullBrokerAdapter", () => {
  const adapter = new NullBrokerAdapter();

  it("reports NOT_CONNECTED from the session", async () => {
    expect(await adapter.session.getSessionStatus()).toEqual({ status: "NOT_CONNECTED" });
  });

  it("answers NOT_CONNECTED on every read port", async () => {
    const ref = { provider: "none", id: "x" };
    const answers = await Promise.all([
      adapter.quotes.getQuote(ref),
      adapter.marketData.getUnderlyingQuote("NIFTY"),
      adapter.optionChains.listExpiries("NIFTY"),
      adapter.optionChains.getOptionChain("NIFTY", "2026-01-29"),
      adapter.historical.getDailyCandles("NIFTY", "2026-01-01", "2026-01-31"),
      adapter.calendar.getTradingDaysToExpiry("NIFTY", "2026-01-01", "2026-01-29"),
    ]);
    for (const answer of answers) expect(answer).toEqual({ status: "NOT_CONNECTED" });
  });

  it("resolves no market (NOT_CONFIGURED for all six)", async () => {
    for (const marketId of MARKET_IDS) {
      expect((await adapter.resolver.resolveMarket(marketId)).status).toBe("NOT_CONFIGURED");
    }
  });
});

describe("DisabledOrderProvider", () => {
  const orders = new DisabledOrderProvider();

  it("rejects placeOrder with LIVE_ORDERS_DISABLED", async () => {
    await expect(orders.placeOrder()).rejects.toMatchObject({ code: "LIVE_ORDERS_DISABLED" });
  });
  it("rejects modifyOrder with LIVE_ORDERS_DISABLED", async () => {
    await expect(orders.modifyOrder()).rejects.toMatchObject({ code: "LIVE_ORDERS_DISABLED" });
  });
  it("rejects cancelOrder with LIVE_ORDERS_DISABLED", async () => {
    await expect(orders.cancelOrder()).rejects.toMatchObject({ code: "LIVE_ORDERS_DISABLED" });
  });
  it("is what the null adapter uses for orders", async () => {
    await expect(new NullBrokerAdapter().orders.placeOrder({ marketId: "NIFTY", instrument: { provider: "none", id: "1" }, side: "BUY", quantity: 1, limitPrice: null })).rejects.toMatchObject({
      code: "LIVE_ORDERS_DISABLED",
    });
  });
});

describe("getBrokerAdapter", () => {
  it('accepts only "none"', () => {
    expect(getBrokerAdapter("none").name).toBe("none");
  });

  it("fails closed for any other provider, including the deferred FYERS adapter", () => {
    for (const name of ["fyers", "FYERS", "some-other-broker", ""]) {
      expect(() => getBrokerAdapter(name), name).toThrowError(/PROVIDER_NOT_AVAILABLE/);
    }
  });
});
