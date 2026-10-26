import type { SafetyDecisionDTO } from "../contracts/index.js";

/**
 * Safety rules. Provenance: the frozen forward protocol exits after 2 completed trading sessions or at expiry.
 * There is no trading calendar yet, so completed sessions must be SUPPLIED by the caller; if absent the holding
 * rule is reported as NOT evaluated and is never estimated (no weekday-only approximation).
 */
export const SAFETY_RULES = { maxHoldingSessions: 2 } as const;

/**
 * Phase 1B.2 (A3, approved): the PROVISIONAL paper-safety cutoff. Normal actions (assess, review, confirm, monitor, exit)
 * stop at 15:30 Asia/Kolkata on the user-supplied expiry date, and the expiry closure applies from that instant.
 * Inclusive: the cutoff instant itself (15:30:00.000) is expired; 15:29:59.999 is the last moment of normal actions.
 * Asia/Kolkata has no daylight saving, so the fixed +05:30 offset is exact.
 */
export const EXPIRY_CUTOFF = {
  timeZone: "Asia/Kolkata",
  localTime: "15:30",
  utcOffset: "+05:30",
  note:
    "Provisional paper-safety cutoff: 15:30 Asia/Kolkata on the user-supplied expiry date. This is not a verified exchange calendar: " +
    "it does not account for exchange holidays, special sessions or changed market hours, and it is only as correct as the expiry date entered.",
} as const;

/**
 * The documented expiry convention (Phase 1B.1, D4: dates are read in India time). Phase 1B.2 (A3) moves the point of
 * expiry from 00:00 on the next day to the provisional 15:30 cutoff on the expiry date. No holiday or expiry calendar is
 * assumed.
 */
export const EXPIRY_CONVENTION = {
  timeZone: "Asia/Kolkata",
  expiredFrom:
    "15:30 Asia/Kolkata on the expiry date (provisional paper-safety cutoff; inclusive; not a verified exchange calendar, so holidays and special sessions are not accounted for)",
} as const;

/** The cutoff instant for an expiry date (YYYY-MM-DD), written in India time, e.g. 2026-10-06T15:30:00+05:30. */
export const expiryCutoffInstant = (expiry: string): string => `${expiry}T${EXPIRY_CUTOFF.localTime}:00${EXPIRY_CUTOFF.utcOffset}`;

/** Epoch ms of the cutoff. Throws on an invalid expiry date: it never guesses. */
export function expiryCutoffMs(expiry: string): number {
  const ms = Date.parse(expiryCutoffInstant(expiry));
  if (!Number.isFinite(ms)) throw new Error(`Not a valid expiry date: ${expiry}`);
  return ms;
}

/** True at and after the cutoff instant (inclusive). */
export const isAtOrPastExpiryCutoff = (expiry: string, nowMs: number): boolean => nowMs >= expiryCutoffMs(expiry);

const IST_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: EXPIRY_CONVENTION.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });

/** Calendar date (YYYY-MM-DD) in Asia/Kolkata of an instant. Throws on an unparseable time: it never guesses. */
export function istDateOf(instant: string | number): string {
  const ms = typeof instant === "number" ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) throw new Error(`Not a valid time: ${String(instant)}`);
  return IST_DATE.format(new Date(ms)); // en-CA formats as YYYY-MM-DD
}

/**
 * Decides expiry / holding-limit closure at the instant `asOf`. In the paper-trading service `asOf` is always the
 * trusted SERVER time (Phase 1B.1, D3). Expiry applies at and after the provisional cutoff (Phase 1B.2, A3). If both
 * rules apply, EXPIRY wins.
 */
export function evaluateSafety(a: { expiry: string; asOf: string; completedSessions: number | null }): SafetyDecisionDTO {
  const notEvaluated: string[] = [];
  const ms = Date.parse(a.asOf);
  if (!Number.isFinite(ms)) throw new Error(`Not a valid time: ${a.asOf}`);
  if (isAtOrPastExpiryCutoff(a.expiry, ms)) {
    return {
      action: "EXPIRE",
      reasons: [`Expiry ${a.expiry} has passed: the provisional paper-safety cutoff (${EXPIRY_CUTOFF.localTime} ${EXPIRY_CUTOFF.timeZone} on the expiry date) was reached as of ${istDateOf(ms)} (${EXPIRY_CONVENTION.timeZone}).`],
      notEvaluated,
    };
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
