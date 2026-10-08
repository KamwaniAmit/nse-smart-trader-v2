import type { RiskResult } from "../contracts/index.js";
import {
  EXPIRY_PROXIMITY_ESCALATION_AT_OR_BELOW,
  RISK_BAND_POINTS,
  RISK_LEVEL_CUTOFFS,
  SCORED_FACTORS,
  validExpiryProximity,
} from "./rules.js";
import type { RiskBand } from "./rules.js";
import { insufficientRisk } from "./types.js";
import type { RiskEngine, RiskEngineInput } from "./types.js";

const ORDER: Readonly<Record<RiskBand, number>> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const atLeast = (a: RiskBand, b: RiskBand): RiskBand => (ORDER[a] >= ORDER[b] ? a : b);

/**
 * Pure, deterministic risk assessment following docs/RISK_ENGINE.md (rules v1).
 * It reads only the named risk inputs: the opportunity Score, Status and Expected Net Edge itself are never read.
 * Missing or invalid inputs are never guessed.
 */
export function assessRisk(input: RiskEngineInput): RiskResult {
  const raw = input as Readonly<Record<string, unknown>>;
  const banded: Array<{ field: string; weight: number; critical: boolean; band: RiskBand; value: unknown }> = [];
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  const invalid: string[] = [];

  for (const factor of SCORED_FACTORS) {
    const value = raw[factor.field];
    const band = factor.band(value);
    if (band === null) {
      (factor.required ? missingRequired : missingOptional).push(factor.field);
      if (value !== undefined && value !== null) invalid.push(factor.field);
    } else {
      banded.push({ field: factor.field, weight: factor.weight, critical: factor.critical, band, value });
    }
  }

  if (missingRequired.length > 0) {
    const note = invalid.some((f) => missingRequired.includes(f)) ? " (an invalid value counts as missing)" : "";
    return insufficientRisk(`Required risk input(s) unavailable: ${missingRequired.join(", ")}${note}. Risk is not guessed.`);
  }

  let weighted = 0;
  let totalWeight = 0;
  for (const b of banded) {
    weighted += b.weight * RISK_BAND_POINTS[b.band];
    totalWeight += b.weight;
  }
  const riskScore = Math.round((weighted / totalWeight) * 10) / 10;

  let level: RiskBand =
    riskScore >= RISK_LEVEL_CUTOFFS.highFrom ? "HIGH" : riskScore >= RISK_LEVEL_CUTOFFS.mediumFrom ? "MEDIUM" : "LOW";

  const reasons: string[] = banded.map((b) => `${b.field} = ${String(b.value)} -> ${b.band}`);
  const warnings: string[] = [];

  const criticalHigh = banded.filter((b) => b.critical && b.band === "HIGH").map((b) => b.field);
  if (criticalHigh.length > 0 && level !== "HIGH") {
    level = "HIGH";
    reasons.push(`Escalated to HIGH: critical factor(s) banded HIGH: ${criticalHigh.join(", ")} (weighted risk score ${riskScore} is shown unchanged)`);
  }

  const proximity = validExpiryProximity(raw["expiryProximity"]);
  if (proximity !== null && proximity <= EXPIRY_PROXIMITY_ESCALATION_AT_OR_BELOW && level !== "HIGH") {
    level = "HIGH";
    reasons.push(`Escalated to HIGH: expiryProximity = ${proximity} (expiring today or in the next session)`);
  } else if (raw["expiryProximity"] !== undefined && raw["expiryProximity"] !== null && proximity === null) {
    warnings.push("Ignored invalid input: expiryProximity");
  }

  const anyHigh = banded.filter((b) => b.band === "HIGH").map((b) => b.field);
  if (anyHigh.length > 0 && ORDER[level] < ORDER.MEDIUM) {
    level = atLeast(level, "MEDIUM");
    reasons.push(`Raised to at least MEDIUM: factor(s) banded HIGH: ${anyHigh.join(", ")}`);
  }

  if (missingOptional.length > 0) {
    warnings.push(`Not assessed (input unavailable): ${missingOptional.join(", ")}. The risk score is normalized over the inputs that were available.`);
  }
  const invalidOptional = invalid.filter((f) => missingOptional.includes(f));
  if (invalidOptional.length > 0) warnings.push(`Ignored invalid input(s): ${invalidOptional.join(", ")}`);

  return {
    riskLevel: level,
    riskScore,
    riskReasons: reasons,
    riskWarnings: warnings,
    riskDataStatus: missingOptional.length === 0 ? "COMPLETE" : "PARTIAL",
  };
}

export function createRiskEngine(): RiskEngine {
  return { assess: assessRisk };
}
