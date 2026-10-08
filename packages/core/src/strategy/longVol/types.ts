import type { MarketId, OpportunityStatus, RiskFilter, RiskResult } from "../../contracts/index.js";
import type { BrokerRef } from "../../instruments/brokerRef.js";

// LONG VOL = BUY CE + BUY PE. Type boundaries only. No calculations in Phase 1A.
// Frozen definitions are documented in docs/STRATEGY_FREEZE.md.

export type LongVolStructure = "STRADDLE" | "STRANGLE";

export interface LongVolLeg {
  instrument: BrokerRef | null;
  strike: number | null;
  /** Executable entry price for this leg (the ask). Null when unavailable. */
  ask: number | null;
  /** Executable exit price for this leg (the bid). Null when unavailable. */
  bid: number | null;
}

export interface LongVolOpportunity {
  id: string;
  marketId: MarketId;
  structure: LongVolStructure;
  expiry: string | null;
  ce: LongVolLeg;
  pe: LongVolLeg;
  lotSize: number | null;
  /** CE Ask + PE Ask. Null when either ask is unavailable. */
  entryPremium: number | null;
  /** Score, Risk and Expected Net Edge are three independent outputs. */
  score: number | null;
  expectedNetEdge: number | null;
  risk: RiskResult;
  capitalRequirement: number | null;
  numberOfLots: number | null;
  status: OpportunityStatus;
  reasons: string[];
  asOf: string | null;
}

export interface LongVolScanRequest {
  marketId: MarketId;
  maxCapitalAllocation: number;
  riskFilter: RiskFilter;
}

export type LongVolScanResult =
  | { status: "OK"; opportunities: LongVolOpportunity[] }
  | { status: "NOT_CONFIGURED" | "NOT_CONNECTED" | "DATA_INSUFFICIENT"; reason: string };

/** Contract for a future scanner. No implementation exists in Phase 1A. */
export interface LongVolScanner {
  scan(request: LongVolScanRequest): Promise<LongVolScanResult>;
}
