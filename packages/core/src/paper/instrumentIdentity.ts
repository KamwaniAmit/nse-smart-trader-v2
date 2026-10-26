import type { InstrumentCheck, InstrumentRefDTO, PaperCandidate } from "../contracts/index.js";

/**
 * Phase 1B.2 final review: a leg's instrument must identify exactly the contract described by the structured fields.
 *
 * The only instrument format in this repository that carries a contract identity is the manual identity built by the
 * candidate parser (`manualInstrument` in parse.ts):
 *   { provider: "manual", id: `${marketId}|${expiry}|${optionType}|${strike}` }
 * Each part is compared, by exact text, with what that same builder produces from the structured fields: market =
 * candidate.marketId, expiry = candidate.expiry, option type = leg.optionType, strike = String(leg.strike). No other
 * normalisation is applied (for example "22900.0" is not accepted for strike 22900). Other providers are opaque
 * identifiers (core never parses them), so none of their fields can be verified.
 *
 * Nothing here rewrites a supplied instrument or a structured field.
 */
export const MANUAL_PROVIDER = "manual";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date in YYYY-MM-DD form (the same rule the candidate parser uses for `expiry`). */
export const isRealCalendarDate = (s: string): boolean => {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export interface ManualInstrumentParts {
  market: string;
  expiry: string;
  optionType: string;
  strike: string;
}
export type ManualInstrumentRead = { ok: true; parts: ManualInstrumentParts } | { ok: false; detail: string };

const FORMAT = '"<market>|<expiry YYYY-MM-DD>|<CE or PE>|<strike>"';

/** Reads the four parts of a manual instrument id. Never guesses: anything else is unreadable. */
export function readManualInstrument(ref: InstrumentRefDTO): ManualInstrumentRead {
  if (ref.provider !== MANUAL_PROVIDER) {
    return { ok: false, detail: `a "${ref.provider}" instrument cannot be verified (only the manual format carries market, expiry, option type and strike)` };
  }
  const p = ref.id.split("|");
  if (p.length !== 4) return { ok: false, detail: `id "${ref.id}" must be ${FORMAT}` };
  const [market = "", expiry = "", optionType = "", strike = ""] = p;
  if (expiry.trim() === "") return { ok: false, detail: `id "${ref.id}" has no expiry` };
  if (!isRealCalendarDate(expiry)) return { ok: false, detail: `id "${ref.id}" has expiry "${expiry}", which is not a real calendar date (YYYY-MM-DD)` };
  if (market === "" || optionType === "" || strike === "") return { ok: false, detail: `id "${ref.id}" must be ${FORMAT} with no empty part` };
  return { ok: true, parts: { market, expiry, optionType, strike } };
}

/** The structured fields an instrument must match. A field left undefined (because it is itself invalid) is not compared. */
export interface ExpectedIdentity {
  marketId?: string;
  expiry?: string;
  optionType?: string;
  strike?: number;
}

/** Every way the instrument differs from the structured fields, or why it cannot be read. Empty = consistent. */
export function instrumentIdentityProblems(ref: InstrumentRefDTO, expected: ExpectedIdentity): string[] {
  const read = readManualInstrument(ref);
  if (!read.ok) return [read.detail];
  const { market, expiry, optionType, strike } = read.parts;
  const out: string[] = [];
  const differ = (what: string, got: string, want: string) => out.push(`instrument ${what} "${got}" does not match the ${what} "${want}" (neither is rewritten)`);
  if (expected.marketId !== undefined && market !== expected.marketId) differ("market", market, expected.marketId);
  if (expected.expiry !== undefined && expiry !== expected.expiry) differ("expiry", expiry, expected.expiry);
  if (expected.optionType !== undefined && optionType !== expected.optionType) differ("option type", optionType, expected.optionType);
  if (expected.strike !== undefined && strike !== String(expected.strike)) differ("strike", strike, String(expected.strike));
  return out;
}

export interface InstrumentCheckResult {
  /** The expiry the safety rules use: the candidate expiry, or an EARLIER readable instrument expiry on an older record. */
  expiryUsed: string;
  check: InstrumentCheck;
  /** Per leg, why the record is not CONSISTENT (empty when it is). */
  reasons: string[];
}

/**
 * For a STORED candidate. New candidates are refused by the parser unless every leg is consistent, so for them this is
 * CONSISTENT with the candidate expiry. Older records are never rewritten; for them:
 *  - UNVERIFIABLE: a leg's instrument cannot be read (opaque provider or malformed id);
 *  - MISMATCH: every instrument is readable, but a market, expiry, option type or strike differs.
 * The expiry used is the earliest readable date (candidate or instrument), so an inconsistent instrument can never push
 * the cutoff later. A record that is not CONSISTENT is never priced again (see service.ts).
 */
export function checkInstruments(candidate: Pick<PaperCandidate, "marketId" | "expiry" | "legs">): InstrumentCheckResult {
  let expiryUsed = candidate.expiry;
  let unreadable = false;
  const reasons: string[] = [];
  for (const leg of candidate.legs) {
    const label = `${leg.optionType} ${leg.strike}`;
    const read = readManualInstrument(leg.instrument);
    if (!read.ok) {
      unreadable = true;
      reasons.push(`${label}: ${read.detail}`);
      continue;
    }
    if (isRealCalendarDate(read.parts.expiry) && read.parts.expiry < expiryUsed) expiryUsed = read.parts.expiry; // YYYY-MM-DD orders as text
    for (const p of instrumentIdentityProblems(leg.instrument, { marketId: candidate.marketId, expiry: candidate.expiry, optionType: leg.optionType, strike: leg.strike })) {
      reasons.push(`${label}: ${p}`);
    }
  }
  const check: InstrumentCheck = unreadable ? "UNVERIFIABLE" : reasons.length > 0 ? "MISMATCH" : "CONSISTENT";
  return { expiryUsed, check, reasons };
}
