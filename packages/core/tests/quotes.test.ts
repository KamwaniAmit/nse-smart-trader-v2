import { describe, expect, it } from "vitest";
import { assessQuote } from "../src/index.js";

describe("assessQuote", () => {
  it("accepts a valid bid/ask", () => {
    expect(assessQuote({ bid: 99.5, ask: 100 })).toEqual({ executable: true });
  });

  it("accepts bid equal to ask (zero spread is not crossed)", () => {
    expect(assessQuote({ bid: 100, ask: 100 })).toEqual({ executable: true });
  });

  it("rejects a missing bid as INVALID_BID", () => {
    expect(assessQuote({ bid: null, ask: 100 })).toEqual({ executable: false, reason: "INVALID_BID" });
  });

  it("rejects a zero or negative bid", () => {
    expect(assessQuote({ bid: 0, ask: 100 })).toEqual({ executable: false, reason: "INVALID_BID" });
    expect(assessQuote({ bid: -1, ask: 100 })).toEqual({ executable: false, reason: "INVALID_BID" });
  });

  it("rejects a zero ask as INVALID_ASK", () => {
    expect(assessQuote({ bid: 99, ask: 0 })).toEqual({ executable: false, reason: "INVALID_ASK" });
  });

  it("rejects a missing ask as INVALID_ASK", () => {
    expect(assessQuote({ bid: 99, ask: null })).toEqual({ executable: false, reason: "INVALID_ASK" });
  });

  it("rejects non-finite numbers", () => {
    expect(assessQuote({ bid: Number.NaN, ask: 100 })).toEqual({ executable: false, reason: "INVALID_BID" });
    expect(assessQuote({ bid: 99, ask: Number.POSITIVE_INFINITY })).toEqual({ executable: false, reason: "INVALID_ASK" });
  });

  it("rejects a crossed market (ask below bid)", () => {
    expect(assessQuote({ bid: 101, ask: 100 })).toEqual({ executable: false, reason: "CROSSED_MARKET" });
  });

  it("never substitutes LTP when bid/ask is missing", () => {
    const quoteWithLtp = { bid: null, ask: 100, ltp: 99 };
    expect(assessQuote(quoteWithLtp)).toEqual({ executable: false, reason: "INVALID_BID" });
  });
});
