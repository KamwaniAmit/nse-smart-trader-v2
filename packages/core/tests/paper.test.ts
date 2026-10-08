import { describe, expect, it } from "vitest";
import { PAPER_TRADE_STATUSES } from "../src/index.js";
import type { PaperTrade, PaperTradeEntry } from "../src/index.js";

// Contract-shape tests: paper trading has no logic in Phase 1A.

const entry: PaperTradeEntry = {
  timestamp: "2026-01-01T09:30:00.000Z",
  legAsks: [10, 12],
  combinedEntryPremium: 22,
  entryCosts: null,
  lots: 1,
  recordClass: "FORWARD_RESEARCH",
  riskSnapshot: {
    riskLevel: "MEDIUM",
    riskScore: null,
    riskReasons: [],
    riskWarnings: [],
    riskDataStatus: "PARTIAL",
    riskSnapshotTimestamp: "2026-01-01T09:30:00.000Z",
  },
};

describe("paper trade contract", () => {
  it("lists the lifecycle statuses (final expiry naming is an open decision)", () => {
    expect([...PAPER_TRADE_STATUSES]).toEqual(["PAPER_SELECTED", "PAPER_OPEN", "PAPER_CLOSED", "PAPER_EXPIRED", "PAPER_AUTO_CLOSED"]);
  });

  it("a trade stores an entry-time risk snapshot with its own timestamp", () => {
    expect(entry.riskSnapshot.riskLevel).toBe("MEDIUM");
    expect(entry.riskSnapshot.riskSnapshotTimestamp).toBe(entry.timestamp);
  });

  it("current risk is a separate field and can differ from entry risk", () => {
    const trade: PaperTrade = {
      tradeId: "t1",
      status: "PAPER_OPEN",
      candidate: { candidateId: "c1", strategy: "LONG_VOL", marketId: "NIFTY", legs: [] },
      entry,
      exit: null,
      currentRisk: { riskLevel: "HIGH", riskScore: null, riskReasons: [], riskWarnings: [], riskDataStatus: "PARTIAL" },
    };
    expect(trade.entry?.riskSnapshot.riskLevel).toBe("MEDIUM");
    expect(trade.currentRisk?.riskLevel).toBe("HIGH");
  });

  it("an exit without a valid bid carries null prices and DATA_INSUFFICIENT P&L, never a made-up number", () => {
    const exit: NonNullable<PaperTrade["exit"]> = {
      timestamp: "2026-01-03T09:30:00.000Z",
      legBids: [null, null],
      exitPremium: null,
      grossPnl: null,
      netPnl: null,
      pnlStatus: "DATA_INSUFFICIENT",
      reason: "expiry passed with no valid bid",
    };
    expect(exit.exitPremium).toBeNull();
    expect(exit.pnlStatus).toBe("DATA_INSUFFICIENT");
  });
});
