import type { MarketId, OpportunityStatus, RiskFilter, RiskResult } from "../../contracts/index.js";
import type { BrokerRef } from "../../instruments/brokerRef.js";

// Best Opportunities: type boundaries only. No candidate generation in Phase 1A.
// It shares the single Risk contract with LONG VOL; there is no second risk model.

export type OpportunityDirection = "CALL" | "PUT" | "AVOID";

export interface BestOpportunityCandidate {
  id: string;
  marketId: MarketId;
  instrument: BrokerRef | null;
  direction: OpportunityDirection;
  score: number | null;
  expectedNetEdge: number | null;
  capitalRequirement: number | null;
  risk: RiskResult;
  status: OpportunityStatus;
  rank: number | null;
  reasons: string[];
}

export interface BestOpportunitiesQuery {
  riskFilter: RiskFilter;
  maxCapitalAllocation: number | null;
}

export type BestOpportunitiesResult =
  | { status: "OK"; candidates: BestOpportunityCandidate[] }
  | { status: "NOT_CONFIGURED" | "NOT_CONNECTED" | "DATA_INSUFFICIENT"; reason: string };

export interface BestOpportunitiesScanner {
  scan(query: BestOpportunitiesQuery): Promise<BestOpportunitiesResult>;
}
