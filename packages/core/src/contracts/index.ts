// Shared, broker-independent contracts. TYPES AND CONSTANTS ONLY.
// This is the ONLY part of @nsest/core that the web app may import
// ("@nsest/core/contracts"). No logic, no I/O, no broker knowledge.

export const MARKET_IDS = ["NIFTY", "BANKNIFTY", "SMALLCAP", "GOLD", "SILVER", "CRUDEOIL"] as const;
export type MarketId = (typeof MARKET_IDS)[number];

export type MarketCategory = "INDEX" | "COMMODITY";

export const MARKET_DISPLAY_NAMES: Readonly<Record<MarketId, string>> = {
  NIFTY: "NIFTY",
  BANKNIFTY: "BANK NIFTY",
  SMALLCAP: "SMALL CAP",
  GOLD: "GOLD",
  SILVER: "SILVER",
  CRUDEOIL: "CRUDE OIL",
};

// ---- Risk (contracts only; no thresholds exist in Phase 1A) ----------------
export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_FILTER_OPTIONS = ["ALL", "LOW", "MEDIUM", "HIGH"] as const;
export type RiskFilter = (typeof RISK_FILTER_OPTIONS)[number];

export type RiskDataStatus = "COMPLETE" | "PARTIAL" | "INSUFFICIENT";

/** Risk is its own dimension: it carries no score, edge, capital or status. */
export interface RiskResult {
  riskLevel: RiskLevel | null;
  riskScore: number | null;
  riskReasons: string[];
  riskWarnings: string[];
  riskDataStatus: RiskDataStatus;
}

// ---- Opportunity status (frozen set) ---------------------------------------
export const OPPORTUNITY_STATUSES = ["QUALIFIED", "WATCH", "FILTERED", "REJECTED", "DATA_INSUFFICIENT"] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

// ---- API DTOs ---------------------------------------------------------------
export type ResolutionStatus = "RESOLVED" | "NOT_CONFIGURED" | "DATA_INSUFFICIENT";

export interface HealthResponse {
  status: "ok";
  phase: "1A";
  brokerProvider: "none";
  brokerConnected: boolean;
  liveOrdersEnabled: false;
}

export interface MarketSummaryDTO {
  marketId: MarketId;
  displayName: string;
  category: MarketCategory;
  status: ResolutionStatus;
  reason: string;
  requiresExplicitResolution: boolean;
}

export interface MarketsResponse {
  markets: MarketSummaryDTO[];
}
