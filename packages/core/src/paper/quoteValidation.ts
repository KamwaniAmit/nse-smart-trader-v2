import type { EntryQuoteDTO, InstrumentRefDTO, PaperLeg } from "../contracts/index.js";
import { assessQuote } from "../marketdata/assessQuote.js";
import { legLabel } from "./pricing.js";
import { checkEntryTime } from "./time.js";

/**
 * Phase 1B.2: ONE validation for every price that values a trade: confirmation (entry), monitor, exit and a holding-limit
 * closure. It uses the unchanged Phase 1A bid/ask rule (assessQuote: positive bid AND ask, ask not below bid) and checks
 * each quote's own user-entry time against the server clock. It never reads a last-traded price; duplicates are compared
 * with a key supplied by the caller.
 *
 * Order of checks (the first failing class decides the code):
 *   1. a quote for an instrument that is not a leg of the trade      -> INVALID_REQUEST (never substituted)
 *   2. a missing leg, conflicting duplicates, or a non-executable
 *      bid/ask (missing, zero, negative, crossed)                    -> DATA_INSUFFICIENT
 *   3. a missing, malformed, future (beyond the client-clock
 *      tolerance) or too-old entry time                              -> QUOTE_NOT_FRESH
 */
export interface TimedLegQuote {
  leg: PaperLeg;
  quote: EntryQuoteDTO;
  /** When the user typed this leg's prices (user-entry time, not an exchange time). */
  enteredAt: string;
  /** Server time minus enteredAt, in ms. */
  entryAgeMs: number;
}

export type TimedQuotesResult =
  | { ok: true; legs: TimedLegQuote[] }
  | {
      ok: false;
      code: "INVALID_REQUEST" | "DATA_INSUFFICIENT" | "QUOTE_NOT_FRESH";
      reasons: string[];
      /** Per leg, the single unambiguous quote supplied (or null). Used only for informational risk inputs, never for P&L. */
      unambiguous: Array<EntryQuoteDTO | null>;
    };

export interface TimedQuoteRule {
  /** Maximum time since entry, in ms (inclusive). */
  maxAgeMs: number;
  /** "quote" at confirmation, "manual price" for monitor / exit / holding-limit prices. */
  noun: string;
  /** Identity of a quote for duplicate detection: equal keys = identical copies. */
  key: (q: EntryQuoteDTO) => string;
}

const sameInstrument = (a: InstrumentRefDTO, b: InstrumentRefDTO): boolean => a.provider === b.provider && a.id === b.id;

/** Quotes whose instrument is not a leg of the trade. */
export function foreignQuoteReasons(legs: readonly PaperLeg[], quotes: readonly EntryQuoteDTO[]): string[] {
  return quotes
    .filter((q) => !legs.some((l) => sameInstrument(l.instrument, q.instrument)))
    .map((q) => `${q.instrument.id}: not a leg of this trade (another strike, expiry or instrument is never substituted)`);
}

export function resolveTimedQuotes(legs: readonly PaperLeg[], quotes: readonly EntryQuoteDTO[], nowMs: number, rule: TimedQuoteRule): TimedQuotesResult {
  const unambiguous: Array<EntryQuoteDTO | null> = legs.map((leg) => {
    const matches = quotes.filter((q) => sameInstrument(q.instrument, leg.instrument));
    return matches.length > 0 && new Set(matches.map(rule.key)).size === 1 ? (matches[0] as EntryQuoteDTO) : null;
  });
  const foreign = foreignQuoteReasons(legs, quotes);
  if (foreign.length > 0) return { ok: false, code: "INVALID_REQUEST", reasons: foreign, unambiguous };

  const priceReasons: string[] = [];
  const timeReasons: string[] = [];
  const timed: TimedLegQuote[] = [];
  legs.forEach((leg, i) => {
    const label = legLabel(leg);
    const matches = quotes.filter((q) => sameInstrument(q.instrument, leg.instrument));
    if (matches.length === 0) {
      priceReasons.push(`${label}: no ${rule.noun} supplied for this exact instrument`);
      return;
    }
    const q = unambiguous[i];
    if (q === null || q === undefined) {
      priceReasons.push(`${label}: conflicting quotes supplied; ambiguous, so not used`);
      return;
    }
    const verdict = assessQuote({ bid: q.bid, ask: q.ask ?? null });
    if (!verdict.executable) priceReasons.push(`${label}: ${verdict.reason} (only a valid bid and ask are used; LTP and theoretical prices never are)`);
    const time = checkEntryTime(q.asOf, nowMs, rule.maxAgeMs, `${label}: ${rule.noun}`);
    if (time.problem !== null) timeReasons.push(time.problem);
    else if (verdict.executable) timed.push({ leg, quote: q, enteredAt: q.asOf as string, entryAgeMs: nowMs - time.ms });
  });
  if (priceReasons.length > 0) return { ok: false, code: "DATA_INSUFFICIENT", reasons: [...priceReasons, ...timeReasons], unambiguous };
  if (timeReasons.length > 0) return { ok: false, code: "QUOTE_NOT_FRESH", reasons: timeReasons, unambiguous };
  return { ok: true, legs: timed };
}
