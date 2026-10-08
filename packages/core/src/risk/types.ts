import { RISK_FILTER_OPTIONS, RISK_LEVELS } from "../contracts/index.js";
import type { RiskDataStatus, RiskFilter, RiskLevel, RiskResult } from "../contracts/index.js";

export { RISK_FILTER_OPTIONS, RISK_LEVELS };
export type { RiskDataStatus, RiskFilter, RiskLevel, RiskResult };

/**
 * Names of the measurable factors a future Risk Engine may consume.
 * CONTRACT ONLY: no thresholds, weights or classification rules exist in Phase 1A.
 * Deliberately absent: the opportunity score, the opportunity status, and
 * the capital gate result. Risk must not be derived from the opportunity score.
 * (Decided: the QUALITY of Expected Net Edge is an accepted Risk input. Risk must never
 * calculate, replace or override Expected Net Edge: see docs/DECISIONS.md.)
 */
export const RISK_INPUT_FIELDS = [
  "expectedNetEdgeQuality",
  "ivRvRelationship",
  "rvRegime",
  "bidAskSpreadQuality",
  "liquidityVolume",
  "openInterest",
  "daysToExpiry",
  "premiumRequirement",
  "capitalUtilization",
  "maxLossDefined",
  "slippageSensitivity",
  "dataCompleteness",
  "contractLiquidity",
  "structureType",
  "distanceFromAtm",
  "expiryProximity",
] as const;

export type RiskInputField = (typeof RISK_INPUT_FIELDS)[number];

/** Plain-object, broker-free input. Any missing input means the engine must not guess. */
export type RiskEngineInput = { readonly [K in RiskInputField]?: number | string | boolean | null };

/** A future Risk Engine must be pure and deterministic. No implementation exists in Phase 1A. */
export interface RiskEngine {
  assess(input: RiskEngineInput): RiskResult;
}

/** The only Phase 1A risk output: "we cannot tell". Never a guess. */
export function insufficientRisk(reason: string): RiskResult {
  return {
    riskLevel: null,
    riskScore: null,
    riskReasons: [],
    riskWarnings: [reason],
    riskDataStatus: "INSUFFICIENT",
  };
}
