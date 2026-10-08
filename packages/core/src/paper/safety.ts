import type { SafetyDecisionDTO } from "../contracts/index.js";

/**
 * Safety rules. Provenance: the frozen forward protocol exits after 2 completed trading sessions or at expiry.
 * There is no trading calendar yet, so completed sessions must be SUPPLIED by the caller; if absent the holding
 * rule is reported as NOT evaluated and is never estimated (no weekday-only approximation).
 */
export const SAFETY_RULES = { maxHoldingSessions: 2 } as const;

/** Calendar date (YYYY-MM-DD) of an ISO timestamp, as written (no timezone conversion). */
export const dateOf = (iso: string): string => iso.slice(0, 10);

/**
 * Expiry: a contract is treated as expired only when the as-of DATE is after the expiry DATE. The expiry day
 * itself is NOT treated as expired, because market hours are not configured yet.
 * If both rules apply, EXPIRY wins.
 */
export function evaluateSafety(a: { expiry: string; asOf: string; completedSessions: number | null }): SafetyDecisionDTO {
  const notEvaluated: string[] = [];
  if (dateOf(a.asOf) > a.expiry) {
    return { action: "EXPIRE", reasons: [`Expiry ${a.expiry} has passed as of ${dateOf(a.asOf)}.`], notEvaluated };
  }
  if (a.completedSessions === null) {
    notEvaluated.push("HOLDING_LIMIT not evaluated: completedSessions was not supplied (no trading calendar exists yet).");
  } else if (a.completedSessions >= SAFETY_RULES.maxHoldingSessions) {
    return {
      action: "AUTO_CLOSE",
      reasons: [`Holding limit reached: ${a.completedSessions} completed session(s) >= ${SAFETY_RULES.maxHoldingSessions}.`],
      notEvaluated,
    };
  }
  return { action: "NONE", reasons: [], notEvaluated };
}
