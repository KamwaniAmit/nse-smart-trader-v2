import type {
  CapitalAssessment,
  InstrumentRefDTO,
  LegQuoteDTO,
  PaperCandidate,
  PaperLeg,
  PaperPnl,
} from "../contracts/index.js";
import { assessQuote } from "../marketdata/assessQuote.js";
import { fromPaise, round4, toPaise } from "./money.js";

export const legLabel = (leg: Pick<PaperLeg, "optionType" | "strike">): string => `${leg.optionType} ${leg.strike}`;

// ---- Entry: Entry premium = sum of executable ASKS (for LONG VOL: CE Ask + PE Ask) -------------------------

export interface EntryAssessment {
  status: "EXECUTABLE" | "DATA_INSUFFICIENT";
  combinedEntryPremium: number | null;
  spreadPct: number | null;
  reasons: string[];
}

/**
 * Entry needs a full executable quote on every leg (valid bid AND ask, ask >= bid). LTP is never read.
 * If any leg is not executable the whole entry is DATA_INSUFFICIENT and no premium is produced.
 */
export function assessEntry(candidate: Pick<PaperCandidate, "legs">): EntryAssessment {
  const reasons: string[] = [];
  for (const leg of candidate.legs) {
    const verdict = assessQuote({ bid: leg.quote.bid, ask: leg.quote.ask });
    if (!verdict.executable) reasons.push(`${legLabel(leg)}: ${verdict.reason}`);
  }
  if (reasons.length > 0) return { status: "DATA_INSUFFICIENT", combinedEntryPremium: null, spreadPct: null, reasons };

  let askPaise = 0;
  let bidPaise = 0;
  for (const leg of candidate.legs) {
    askPaise += toPaise(leg.quote.ask as number);
    bidPaise += toPaise(leg.quote.bid as number);
  }
  return {
    status: "EXECUTABLE",
    combinedEntryPremium: fromPaise(askPaise),
    spreadPct: askPaise > 0 ? round4(((askPaise - bidPaise) / askPaise) * 100) : null,
    reasons: [],
  };
}

// ---- Capital (frozen formulas) -----------------------------------------------------------------------------
//   premiumRequirement      = combinedEntryPremium x lotSize
//   totalCapitalRequirement = premiumRequirement + entry costs
//   numberOfLots            = floor(maxCapitalAllocation / totalCapitalRequirement)
// Capital is a gate. Nothing is guessed: unknown costs or allocation mean NOT_EVALUATED.

export function computeCapital(a: {
  combinedEntryPremium: number | null;
  lotSize: number;
  entryCosts: number | null;
  maxCapitalAllocation: number | null;
  requestedLots: number | null;
}): CapitalAssessment {
  const reasons: string[] = [];
  const premiumPaise = a.combinedEntryPremium === null ? null : toPaise(a.combinedEntryPremium) * a.lotSize;
  const totalPaise = premiumPaise !== null && a.entryCosts !== null ? premiumPaise + toPaise(a.entryCosts) : null;
  const allocPaise = a.maxCapitalAllocation === null ? null : toPaise(a.maxCapitalAllocation);

  const numberOfLots = totalPaise !== null && totalPaise > 0 && allocPaise !== null ? Math.floor(allocPaise / totalPaise) : null;
  const lots = a.requestedLots ?? (numberOfLots !== null && numberOfLots >= 1 ? numberOfLots : null);

  let gate: CapitalAssessment["gate"] = "NOT_EVALUATED";
  if (premiumPaise === null) {
    reasons.push("No executable entry premium, so capital cannot be evaluated.");
  } else if (allocPaise === null) {
    reasons.push("maxCapitalAllocation was not provided.");
  } else if (totalPaise === null) {
    reasons.push("Entry costs were not provided; the frozen capital formula is premium + entry costs, so it is not guessed.");
  } else if (numberOfLots === null || numberOfLots < 1) {
    gate = "FAIL";
    reasons.push(`One lot needs ${fromPaise(totalPaise)} but the allocation is ${fromPaise(allocPaise)}.`);
  } else if (a.requestedLots !== null && a.requestedLots * totalPaise > allocPaise) {
    gate = "FAIL";
    reasons.push(`${a.requestedLots} lot(s) need ${fromPaise(a.requestedLots * totalPaise)} but the allocation is ${fromPaise(allocPaise)}.`);
  } else {
    gate = "PASS";
  }

  const utilizationPct =
    lots !== null && totalPaise !== null && allocPaise !== null && allocPaise > 0
      ? round4(((lots * totalPaise) / allocPaise) * 100)
      : null;

  return {
    premiumRequirement: premiumPaise === null ? null : fromPaise(premiumPaise),
    entryCosts: a.entryCosts,
    totalCapitalRequirement: totalPaise === null ? null : fromPaise(totalPaise),
    maxCapitalAllocation: a.maxCapitalAllocation,
    numberOfLots,
    requestedLots: a.requestedLots,
    lots,
    utilizationPct,
    gate,
    reasons,
  };
}

// ---- Exit: Exit premium = sum of executable BIDS (for LONG VOL: CE Bid + PE Bid) -----------------------------

const sameInstrument = (a: InstrumentRefDTO, b: InstrumentRefDTO): boolean => a.provider === b.provider && a.id === b.id;

/**
 * Finds the bid for each leg by EXACT instrument identity. A quote for another strike, another expiry or
 * another instrument is ignored, never substituted. A missing, zero, negative or non-finite bid is "no price".
 * LTP, model price and every other field are never read.
 */
export function resolveLegBids(
  legs: ReadonlyArray<{ instrument: InstrumentRefDTO }>,
  quotes: readonly LegQuoteDTO[],
): { bids: Array<number | null>; reasons: string[] } {
  const reasons: string[] = [];
  const bids = legs.map((leg) => {
    const matches = quotes.filter((q) => sameInstrument(q.instrument, leg.instrument));
    if (matches.length === 0) {
      reasons.push(`${leg.instrument.id}: no quote supplied for this exact instrument`);
      return null;
    }
    const distinct = new Set(matches.map((m) => m.bid));
    if (distinct.size > 1) {
      reasons.push(`${leg.instrument.id}: conflicting bids supplied; ambiguous, so not used`);
      return null;
    }
    const bid = matches[0]?.bid;
    if (typeof bid !== "number" || !Number.isFinite(bid) || bid <= 0) {
      reasons.push(`${leg.instrument.id}: bid is missing or not positive (LTP is never used instead)`);
      return null;
    }
    return bid;
  });
  return { bids, reasons };
}

export function exitPremiumOf(bids: ReadonlyArray<number | null>): number | null {
  let paise = 0;
  for (const bid of bids) {
    if (bid === null) return null;
    paise += toPaise(bid);
  }
  return bids.length === 0 ? null : fromPaise(paise);
}

// ---- P&L ----------------------------------------------------------------------------------------------------
//   gross = (exitPremium - entryPremium) x lotSize x lots
//   net   = gross - entryCosts - exitCosts (only when BOTH costs are known)

export function computePnl(a: {
  entryPremium: number;
  exitPremium: number | null;
  lotSize: number;
  lots: number;
  entryCosts: number | null;
  exitCosts: number | null;
}): PaperPnl {
  if (a.exitPremium === null) {
    return {
      status: "DATA_INSUFFICIENT",
      reason: "No valid executable exit price (every leg needs a positive bid). P&L is not estimated.",
      grossPnl: null,
      netPnl: null,
      netStatus: "DATA_INSUFFICIENT",
    };
  }
  const grossPaise = (toPaise(a.exitPremium) - toPaise(a.entryPremium)) * a.lotSize * a.lots;
  if (a.entryCosts === null || a.exitCosts === null) {
    return {
      status: "VALID",
      reason: null,
      grossPnl: fromPaise(grossPaise),
      netPnl: null,
      netStatus: "COSTS_UNAVAILABLE",
    };
  }
  return {
    status: "VALID",
    reason: null,
    grossPnl: fromPaise(grossPaise),
    netPnl: fromPaise(grossPaise - toPaise(a.entryCosts) - toPaise(a.exitCosts)),
    netStatus: "VALID",
  };
}
