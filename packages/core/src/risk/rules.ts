import type { RiskInputField } from "./types.js";

// The code form of docs/RISK_ENGINE.md. Change a number here only together with that document,
// a new RISK_RULES_VERSION, and the tests. Provenance (LEGACY / SPEC / STRUCTURAL / DEFAULT) is in the document.

export const RISK_RULES_VERSION = "1.0.0";

export type RiskBand = "LOW" | "MEDIUM" | "HIGH";

export const RISK_BAND_POINTS: Readonly<Record<RiskBand, number>> = { LOW: 0, MEDIUM: 50, HIGH: 100 };

/** Equal thirds of 0..100. Provenance: DEFAULT. */
export const RISK_LEVEL_CUTOFFS = { mediumFrom: 34, highFrom: 67 } as const;

/** Expiring today or in the next session. Provenance: SPEC (2-session safety rule). */
export const EXPIRY_PROXIMITY_ESCALATION_AT_OR_BELOW = 1;

export const RISK_THRESHOLDS = {
  spreadPct: { lowMax: 2.5, mediumMax: 5 },
  tradingDaysToExpiry: { highBelow: 2, lowMin: 7, lowMax: 30 },
  capitalUtilizationPct: { lowMax: 50, mediumMax: 100 },
  volume: { lowMin: 5000, mediumMin: 2500 },
  openInterest: { lowMin: 10000, mediumMin: 5000 },
  depthRatio: { lowMin: 5, mediumMin: 1 },
  netEdgeRatio: { lowMin: 0.05 },
  ivRvRatio: { lowBelow: 1, highFrom: 2 },
  distanceFromAtmPct: { lowMax: 1, mediumMax: 3 },
} as const;

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nonNegative = (v: unknown): number | null => {
  const n = finite(v);
  return n !== null && n >= 0 ? n : null;
};
const nonNegativeInteger = (v: unknown): number | null => {
  const n = nonNegative(v);
  return n !== null && Number.isInteger(n) ? n : null;
};

export interface ScoredFactor {
  readonly field: RiskInputField;
  readonly weight: number;
  readonly required: boolean;
  /** A HIGH on a critical factor forces an overall HIGH. */
  readonly critical: boolean;
  /** Returns the band, or null when the value is unavailable/invalid. */
  readonly band: (value: unknown) => RiskBand | null;
}

const T = RISK_THRESHOLDS;

export const SCORED_FACTORS: readonly ScoredFactor[] = [
  {
    field: "bidAskSpreadQuality", weight: 18, required: true, critical: true,
    band: (v) => {
      const n = nonNegative(v);
      return n === null ? null : n <= T.spreadPct.lowMax ? "LOW" : n <= T.spreadPct.mediumMax ? "MEDIUM" : "HIGH";
    },
  },
  {
    field: "daysToExpiry", weight: 14, required: true, critical: true,
    band: (v) => {
      const n = nonNegativeInteger(v);
      if (n === null) return null;
      if (n < T.tradingDaysToExpiry.highBelow) return "HIGH";
      if (n >= T.tradingDaysToExpiry.lowMin && n <= T.tradingDaysToExpiry.lowMax) return "LOW";
      return "MEDIUM";
    },
  },
  {
    field: "capitalUtilization", weight: 14, required: true, critical: true,
    band: (v) => {
      const n = nonNegative(v);
      return n === null ? null : n <= T.capitalUtilizationPct.lowMax ? "LOW" : n <= T.capitalUtilizationPct.mediumMax ? "MEDIUM" : "HIGH";
    },
  },
  {
    field: "maxLossDefined", weight: 8, required: false, critical: true,
    band: (v) => (typeof v === "boolean" ? (v ? "LOW" : "HIGH") : null),
  },
  {
    field: "liquidityVolume", weight: 8, required: false, critical: false,
    band: (v) => {
      const n = nonNegative(v);
      return n === null ? null : n >= T.volume.lowMin ? "LOW" : n >= T.volume.mediumMin ? "MEDIUM" : "HIGH";
    },
  },
  {
    field: "openInterest", weight: 8, required: false, critical: false,
    band: (v) => {
      const n = nonNegative(v);
      return n === null ? null : n >= T.openInterest.lowMin ? "LOW" : n >= T.openInterest.mediumMin ? "MEDIUM" : "HIGH";
    },
  },
  {
    field: "contractLiquidity", weight: 4, required: false, critical: true,
    band: (v) => {
      const n = nonNegative(v);
      return n === null ? null : n >= T.depthRatio.lowMin ? "LOW" : n >= T.depthRatio.mediumMin ? "MEDIUM" : "HIGH";
    },
  },
  {
    field: "expectedNetEdgeQuality", weight: 10, required: false, critical: false,
    band: (v) => {
      const n = finite(v);
      return n === null ? null : n >= T.netEdgeRatio.lowMin ? "LOW" : n > 0 ? "MEDIUM" : "HIGH";
    },
  },
  {
    field: "ivRvRelationship", weight: 4, required: false, critical: false,
    band: (v) => {
      const n = nonNegative(v);
      return n === null ? null : n < T.ivRvRatio.lowBelow ? "LOW" : n < T.ivRvRatio.highFrom ? "MEDIUM" : "HIGH";
    },
  },
  {
    field: "rvRegime", weight: 4, required: false, critical: false,
    band: (v) => (v === "RV_ACCELERATING" ? "LOW" : v === "RV_DECELERATING" ? "MEDIUM" : null),
  },
  {
    field: "structureType", weight: 4, required: false, critical: false,
    band: (v) => (v === "STRADDLE" ? "LOW" : v === "STRANGLE" || v === "SINGLE_CALL" || v === "SINGLE_PUT" ? "MEDIUM" : null),
  },
  {
    field: "distanceFromAtm", weight: 4, required: false, critical: false,
    band: (v) => {
      const n = nonNegative(v);
      return n === null ? null : n <= T.distanceFromAtmPct.lowMax ? "LOW" : n <= T.distanceFromAtmPct.mediumMax ? "MEDIUM" : "HIGH";
    },
  },
];

export const TOTAL_SCORED_WEIGHT: number = SCORED_FACTORS.reduce((sum, f) => sum + f.weight, 0);

/** Band for one input, or null if the value is unavailable/invalid. Used by tests and by display code. */
export function bandOf(field: RiskInputField, value: unknown): RiskBand | null {
  const factor = SCORED_FACTORS.find((f) => f.field === field);
  return factor ? factor.band(value) : null;
}

/** expiryProximity is escalation-only (not a weighted factor). Returns the value if valid, else null. */
export function validExpiryProximity(value: unknown): number | null {
  return nonNegativeInteger(value);
}
