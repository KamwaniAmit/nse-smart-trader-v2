import type { MarketId, RiskResult } from "../contracts/index.js";
import type { BrokerRef } from "../instruments/brokerRef.js";
import type { OptionType } from "../marketdata/types.js";

// Paper-trade domain contracts. One lifecycle shared by LONG VOL and Best Opportunities.
// Contracts only: no persistence, no state machine, no P&L logic in Phase 1A.

export const PAPER_TRADE_STATUSES = [
  "PAPER_SELECTED", // user picked a candidate; NOT yet confirmed; not a position
  "PAPER_OPEN", // user explicitly confirmed; entry snapshot recorded
  "PAPER_CLOSED", // exited with a valid bid-based exit
  "PAPER_EXPIRED", // expiry passed without a valid exit price (exit price stays null)
  "PAPER_AUTO_CLOSED", // closed by a safety rule. Final naming vs PAPER_EXPIRED: see docs/DECISIONS.md
] as const;
export type PaperTradeStatus = (typeof PAPER_TRADE_STATUSES)[number];

export type RecordClass = "VALIDATION" | "FORWARD_RESEARCH";

export type PaperStrategyKind = "LONG_VOL" | "BEST_OPPORTUNITY";

/** The exact stored identity of a leg. Monitoring must use this, never a strike/expiry search. */
export interface PaperTradeLeg {
  instrument: BrokerRef;
  optionType: OptionType;
  strike: number;
  expiry: string;
  lotSize: number;
}

/** What the scanner proposed. A candidate is NOT a trade. */
export interface PaperTradeCandidate {
  candidateId: string;
  strategy: PaperStrategyKind;
  marketId: MarketId;
  legs: PaperTradeLeg[];
}

/** Risk at the moment of entry. Never overwritten later. */
export interface EntryRiskSnapshot extends RiskResult {
  riskSnapshotTimestamp: string;
}

export interface PaperTradeEntry {
  timestamp: string;
  /** Entry price per leg = that leg's ask. Never LTP, midpoint or theoretical. */
  legAsks: number[];
  combinedEntryPremium: number;
  entryCosts: number | null;
  lots: number;
  recordClass: RecordClass;
  riskSnapshot: EntryRiskSnapshot;
}

export interface PaperTradeExit {
  timestamp: string;
  /** Exit price per leg = that leg's bid. Null entries mean no valid bid existed. */
  legBids: (number | null)[];
  exitPremium: number | null;
  grossPnl: number | null;
  netPnl: number | null;
  pnlStatus: "VALID" | "DATA_INSUFFICIENT";
  reason: string;
}

export interface PaperTrade {
  tradeId: string;
  status: PaperTradeStatus;
  candidate: PaperTradeCandidate;
  entry: PaperTradeEntry | null;
  exit: PaperTradeExit | null;
  /** Live risk. Displayed separately from entry risk; never replaces it. */
  currentRisk: RiskResult | null;
}
