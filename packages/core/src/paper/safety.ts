import type { SafetyDecisionDTO } from "../contracts/index.js";

/**
 * Safety rules. Provenance: the frozen forward protocol exits after 2 completed trading sessions or at expiry.
 * There is no trading calendar yet, so completed sessions must be SUPPLIED by the caller; if absent the holding
 * rule is reported as NOT evaluated and is never estimated (no weekday-only approximation).
 */
export const SAFETY_RULES = { maxHoldingSessions: 2 } as const;

/**
 * Phase 1B.1 (D4): expiry dates are NSE contract dates, so they are read in India time.
 * The documented convention is unchanged from Phase 1B: the expiry day itself is NOT treated as expired, because
 * exchange market hours (and therefore an intraday expiry cutoff) are not configured. A contract therefore counts as
 * expired from 00:00 Asia/Kolkata on the calendar day after its expiry date. No holiday or expiry calendar is assumed.
 */
export const EXPIRY_CONVENTION = {
  timeZone: "Asia/Kolkata",
  expiredFrom: "00:00 Asia/Kolkata on the calendar day after the expiry date (the expiry day itself is not expired; market hours are not configured)",
} as const;

const IST_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: EXPIRY_CONVENTION.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });

/** Calendar date (YYYY-MM-DD) in Asia/Kolkata of an instant. Throws on an unparseable time: it never guesses. */
export function istDateOf(instant: string | number): string {
  const ms = typeof instant === "number" ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) throw new Error(`Not a valid time: ${String(instant)}`);
  return IST_DATE.format(new Date(ms)); // en-CA formats as YYYY-MM-DD
}

/**
 * Decides expiry / holding-limit closure at the instant `asOf`. In the paper-trading service `asOf` is always the
 * trusted SERVER time (Phase 1B.1, D3). If both rules apply, EXPIRY wins.
 */
export function evaluateSafety(a: { expiry: string; asOf: string; completedSessions: number | null }): SafetyDecisionDTO {
  const notEvaluated: string[] = [];
  const today = istDateOf(a.asOf);
  if (today > a.expiry) {
    return { action: "EXPIRE", reasons: [`Expiry ${a.expiry} has passed as of ${today} (${EXPIRY_CONVENTION.timeZone}).`], notEvaluated };
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
