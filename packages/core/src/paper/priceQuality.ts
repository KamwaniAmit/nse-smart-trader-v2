import type { ExitLegPrice, PaperPnl, PaperTradeRecord, PriceQualityDTO, PriceQualityFlag, PriceQualityLevel } from "../contracts/index.js";
import { checkInstruments } from "./instrumentIdentity.js";
import { expiryCutoffInstant, expiryCutoffMs } from "./safety.js";
import { TIME_RULES, parseStrictTimestamp } from "./time.js";

/**
 * Phase 1B.2 (A10, D4): the quality of the evidence behind a trade's shown P&L, derived WHEN READ from the stored record.
 * Pure: it never changes the record, and the result is never written to the journal or the raw export.
 *
 * MANUAL_ENTRY_CHECKED only means the application's manual-input validation rules passed. Nothing in this application is
 * exchange-sourced, exchange-timestamped or independently verified, and a time a user typed never implies it.
 * Ambiguous or inconsistent records are never upgraded: they stay UNVERIFIED_LEGACY (or SUPERSEDED_RULE).
 */
const WARNINGS: Readonly<Record<PriceQualityFlag, string>> = {
  LEGACY_ENTRY_SNAPSHOT_V1: "Entry recorded by Phase 1B: the entry price came from review-time quotes, not from prices re-entered at confirmation.",
  UNREALIZED_FROM_UNCHECKED_MONITOR: "The unrealized P&L comes from a monitor update whose ask and price entry times were not checked.",
  ASK_AND_PRICE_AGE_NOT_CHECKED: "Recorded before Phase 1B.2: the ask and the price entry time were not checked.",
  UNVERIFIED_PRICE_TIME: "The record carries a price time supplied by the client or the server; it is not a verified observation time.",
  PRICED_FROM_EARLIER_MONITOR_BID: "Valued from an earlier monitored bid. This is no longer allowed: an old bid is not an exit price.",
  EXPIRY_PRICED_FROM_TYPED_BIDS: "The expiry closure was valued from bids typed at closure. This is no longer allowed: there is no approved settlement-price source.",
  SESSION_COUNT_USER_PROVIDED: "The holding-limit closure used a completed-session count entered by the user; there is no trading calendar.",
  ACTION_AFTER_EXPIRY_CUTOFF: "The trade was opened or exited at or after the contract's 15:30 IST paper-safety cutoff. This is no longer allowed.",
  PROVENANCE_INCOMPLETE: "The record claims checked manual prices, but the entry times, ask or provenance needed to show that are missing.",
  PROVENANCE_INCONSISTENT: "The record claims checked manual prices, but its recorded values do not satisfy the manual-input rules.",
  INSTRUMENT_IDENTITY_UNVERIFIED:
    "Older record: the legs' instruments do not verifiably match the market, expiry, option type and strike, so the prices recorded for them are not attributed to a verified contract.",
  UNREALIZED_SNAPSHOT_AFTER_CUTOFF:
    "The contract has reached its provisional 15:30 IST paper-safety cutoff. The unrealized P&L shown is a historical snapshot, not a current or executable valuation.",
};

/** M1: the note when an open trade is read at or after its cutoff. `recordedAt` is the server time of the snapshot. */
const afterCutoffNote = (recordedAt: string, cutoff: string): string =>
  `Historical snapshot: the contract reached its provisional paper-safety cutoff (${cutoff}). The unrealized P&L shown was recorded by the server at ${recordedAt}; ` +
  "it is not a current or executable valuation, it is not exchange-verified, and it is not realized P&L. There is no current price. " +
  "Run the safety check: the expiry closure is unpriced (no approved settlement-price source).";

const NOTES: Readonly<Record<PriceQualityLevel, string>> = {
  MANUAL_ENTRY_CHECKED:
    "Valued from prices entered manually. The application's manual-input validation rules passed (exact legs, valid bid and ask, entered within the allowed time limit). This is not exchange-sourced, exchange-timestamped or independently verified data.",
  UNVERIFIED_LEGACY: "The prices behind this P&L were not checked by the current manual-input rules. Treat the figure as unverified.",
  SUPERSEDED_RULE: "This P&L was produced by a rule that is no longer allowed. It is kept as history only.",
  NO_PRICE: "There is no valid P&L for this trade, so there is no price to assess.",
  // Used only through afterCutoffNote (which names the recorded time); kept here so every level has a note.
  HISTORICAL_SNAPSHOT:
    "The contract reached its provisional paper-safety cutoff. The unrealized P&L shown is a historical snapshot recorded earlier; it is not a current or executable valuation, it is not exchange-verified, and it is not realized P&L.",
};

const isCheckedLeg = (b: ExitLegPrice): boolean =>
  typeof b.ask === "number" && typeof b.enteredAt === "string" && parseStrictTimestamp(b.enteredAt) !== null && typeof b.entryAgeMs === "number" && Number.isFinite(b.entryAgeMs);

const inRule = (b: ExitLegPrice, maxAgeMs: number, maxSkewMs: number): boolean =>
  typeof b.bid === "number" && b.bid > 0 && typeof b.ask === "number" && b.ask >= b.bid && typeof b.entryAgeMs === "number" && b.entryAgeMs <= maxAgeMs && b.entryAgeMs >= -maxSkewMs;

const atOrAfter = (iso: string | undefined, cutoffMs: number | null): boolean => {
  if (iso === undefined || cutoffMs === null) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= cutoffMs;
};

const safeCutoffMs = (expiry: string): number | null => {
  try {
    return expiryCutoffMs(expiry);
  } catch {
    return null;
  }
};

/**
 * @param nowMs The trusted SERVER time of the read (M1). When given, an open trade read at or after its contract's cutoff
 *   is flagged UNREALIZED_SNAPSHOT_AFTER_CUTOFF and its level is NO_PRICE. Client-supplied times are never used for this.
 *   When omitted, the result depends on the stored record only (unchanged Phase 1B.2 behaviour).
 */
export function assessPriceQuality(trade: PaperTradeRecord, nowMs?: number): PriceQualityDTO {
  const flags: PriceQualityFlag[] = [];
  const add = (f: PriceQualityFlag): void => {
    if (!flags.includes(f)) flags.push(f);
  };
  const ids = checkInstruments(trade.candidate); // final review: never later than a readable instrument expiry
  const expiryUsed = ids.expiryUsed;
  const cutoffMs = safeCutoffMs(expiryUsed);

  const entry = trade.entry;
  const exit = trade.exit;
  if (entry !== null && entry.snapshotVersion === 1) add("LEGACY_ENTRY_SNAPSHOT_V1");
  if (ids.check !== "CONSISTENT") add("INSTRUMENT_IDENTITY_UNVERIFIED"); // never upgraded to MANUAL_ENTRY_CHECKED
  if (entry !== null && atOrAfter(entry.capturedAt, cutoffMs)) add("ACTION_AFTER_EXPIRY_CUTOFF");

  let pnl: PaperPnl | null = null;
  if (exit !== null) {
    pnl = trade.realizedPnl;
    if (exit.trigger !== "EXPIRY" && atOrAfter(exit.timestamp, cutoffMs)) add("ACTION_AFTER_EXPIRY_CUTOFF");
    if (exit.basis === "LAST_VALID_MONITOR_BID") add("PRICED_FROM_EARLIER_MONITOR_BID");
    if (exit.trigger === "EXPIRY" && exit.exitPremium !== null) add("EXPIRY_PRICED_FROM_TYPED_BIDS");
    if (exit.trigger === "HOLDING_LIMIT") add("SESSION_COUNT_USER_PROVIDED");
    if (typeof exit.priceAsOf === "string") add("UNVERIFIED_PRICE_TIME");
    if (exit.exitPremium !== null) {
      const claimsChecked = exit.valuationStatus === "MANUAL_ENTRY_CHECKED" || exit.priceProvenance === "MANUAL_USER_ENTRY";
      if (!claimsChecked) {
        add("ASK_AND_PRICE_AGE_NOT_CHECKED");
      } else if (exit.valuationStatus !== "MANUAL_ENTRY_CHECKED" || exit.priceProvenance !== "MANUAL_USER_ENTRY" || exit.legBids.length === 0 || !exit.legBids.every(isCheckedLeg)) {
        add("PROVENANCE_INCOMPLETE");
      } else {
        const maxAge = exit.valuationRule?.maxManualPriceAgeMs ?? TIME_RULES.maxManualPriceAgeMs;
        const maxSkew = exit.valuationRule?.maxFutureSkewMs ?? TIME_RULES.maxFutureSkewMs;
        if (!exit.legBids.every((b) => inRule(b, Math.min(maxAge, TIME_RULES.maxManualPriceAgeMs), Math.min(maxSkew, TIME_RULES.maxFutureSkewMs)))) add("PROVENANCE_INCONSISTENT");
      }
    }
  } else if (trade.state === "PAPER_OPEN" && trade.lastMonitor !== null) {
    pnl = trade.lastMonitor.unrealized;
    const lm = trade.lastMonitor;
    const checked = lm.priceProvenance === "MANUAL_USER_ENTRY" && lm.legs.length > 0 && lm.legs.every((l) => typeof l.enteredAt === "string" && typeof l.entryAgeMs === "number");
    if (pnl.status === "VALID" && !checked) add("UNREALIZED_FROM_UNCHECKED_MONITOR");
    // M1: decided by the server read time and the approved cutoff only. No age threshold is applied before the cutoff.
    if (pnl.status === "VALID" && nowMs !== undefined && Number.isFinite(nowMs) && cutoffMs !== null && nowMs >= cutoffMs) add("UNREALIZED_SNAPSHOT_AFTER_CUTOFF");
  }

  let level: PriceQualityLevel;
  const afterCutoff = flags.includes("UNREALIZED_SNAPSHOT_AFTER_CUTOFF");
  if (pnl === null || pnl.status !== "VALID") level = "NO_PRICE";
  else if (afterCutoff) level = "HISTORICAL_SNAPSHOT"; // a recorded figure exists, but it is not a current price
  else if (flags.some((f) => f === "PRICED_FROM_EARLIER_MONITOR_BID" || f === "EXPIRY_PRICED_FROM_TYPED_BIDS" || f === "ACTION_AFTER_EXPIRY_CUTOFF")) level = "SUPERSEDED_RULE";
  else if (flags.some((f) => f !== "SESSION_COUNT_USER_PROVIDED")) level = "UNVERIFIED_LEGACY";
  else level = "MANUAL_ENTRY_CHECKED";

  const note = afterCutoff && trade.lastMonitor !== null ? afterCutoffNote(trade.lastMonitor.asOf, expiryCutoffInstant(expiryUsed)) : NOTES[level];
  return { level, flags, warnings: flags.map((f) => WARNINGS[f]), note };
}
