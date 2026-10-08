import type { CapitalAssessment, PaperCandidate, RiskAssessmentRecord } from "../contracts/index.js";
import { RISK_RULES_VERSION, SCORED_FACTORS } from "../risk/rules.js";
import { assessRisk } from "../risk/engine.js";
import type { RiskEngineInput } from "../risk/types.js";
import { round4 } from "./money.js";
import { assessEntry } from "./pricing.js";

type RiskInputs = Record<string, number | string | boolean | null>;

const minOrNull = (values: ReadonlyArray<number | null>): number | null => {
  if (values.length === 0 || values.some((v) => v === null)) return null;
  return Math.min(...(values as number[]));
};

/**
 * Turns a candidate (plus its capital assessment) into the named Risk Engine inputs. This only MEASURES things that are
 * on the candidate. It does not calculate Expected Net Edge, Score, Expected Move or Implied Move: those arrive from
 * the strategy layer as plain numbers. A value that cannot be measured is null (never guessed).
 */
export function buildRiskInputs(candidate: PaperCandidate, capital: CapitalAssessment): RiskInputs {
  const entry = assessEntry(candidate);
  const lots = capital.lots ?? 1;
  const orderQty = lots * candidate.lotSize;

  const depth = minOrNull(
    candidate.legs.map((leg) => (leg.quote.bidQty !== null && leg.quote.askQty !== null ? Math.min(leg.quote.bidQty, leg.quote.askQty) : null)),
  );

  const premiumReq = capital.premiumRequirement;
  const netEdgeRatio =
    candidate.expectedNetEdge !== null && premiumReq !== null && premiumReq > 0 ? round4(candidate.expectedNetEdge / premiumReq) : null;

  const ivRv = candidate.iv !== null && candidate.rv20 !== null && candidate.rv20 > 0 ? round4(candidate.iv / candidate.rv20) : null;

  const distance =
    candidate.spot !== null && candidate.spot > 0
      ? round4(Math.max(...candidate.legs.map((leg) => (Math.abs(leg.strike - (candidate.spot as number)) / (candidate.spot as number)) * 100)))
      : null;

  const inputs: RiskInputs = {
    bidAskSpreadQuality: entry.spreadPct,
    daysToExpiry: candidate.tradingDaysToExpiry,
    expiryProximity: candidate.tradingDaysToExpiry,
    capitalUtilization: capital.utilizationPct,
    // STRUCTURAL: every Phase 1B structure is premium-paying, so maximum loss is the premium paid.
    maxLossDefined: true,
    liquidityVolume: minOrNull(candidate.legs.map((l) => l.quote.volume)),
    openInterest: minOrNull(candidate.legs.map((l) => l.quote.oi)),
    contractLiquidity: depth === null || orderQty <= 0 ? null : round4(depth / orderQty),
    expectedNetEdgeQuality: netEdgeRatio,
    ivRvRelationship: ivRv,
    rvRegime: candidate.rvRegime,
    structureType: candidate.structure,
    distanceFromAtm: distance,
    premiumRequirement: premiumReq,
  };

  // Recorded for audit only (not scored): the share of the 12 scored inputs that could be measured.
  const available = SCORED_FACTORS.filter((f) => f.band(inputs[f.field]) !== null).length;
  inputs["dataCompleteness"] = round4(available / SCORED_FACTORS.length);
  return inputs;
}

/** Runs the engine and keeps the inputs and the rules version with the result, so the assessment is auditable. */
export function assessRiskRecord(inputs: RiskInputs, assessedAt: string): RiskAssessmentRecord {
  return {
    result: assessRisk(inputs as RiskEngineInput),
    rulesVersion: RISK_RULES_VERSION,
    inputs: { ...inputs },
    assessedAt,
  };
}
