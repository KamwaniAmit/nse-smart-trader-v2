import type {
  CandidateInputDTO,
  ConfirmRequestDTO,
  ExitRequestDTO,
  InstrumentRefDTO,
  LegQuoteDTO,
  MonitorRequestDTO,
  PaperCandidate,
  PaperLeg,
  PaperQuote,
  SafetyCheckRequestDTO,
} from "../contracts/index.js";
import { MARKET_IDS, PAPER_SOURCES, PAPER_STRUCTURES } from "../contracts/index.js";

// Strict parsing of untyped JSON. Anything malformed is an error: nothing is silently repaired or defaulted
// (except explicit optional fields, which become null).

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

interface NumOpts {
  min?: number;
  positive?: boolean;
  integer?: boolean;
}

function num(o: Record<string, unknown>, key: string, errs: string[], opts: NumOpts = {}): number | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    errs.push(`${key} must be a finite number or null`);
    return null;
  }
  if (opts.positive && v <= 0) errs.push(`${key} must be greater than 0`);
  if (opts.min !== undefined && v < opts.min) errs.push(`${key} must be at least ${opts.min}`);
  if (opts.integer && !Number.isInteger(v)) errs.push(`${key} must be a whole number`);
  return v;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (s: string): boolean => {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // An impossible date (month 13, Feb 30) is an Invalid Date: reject it, never throw.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const isTimestamp = (s: string): boolean => /^\d{4}-\d{2}-\d{2}(T[0-9:.+\-Zz]+)?$/.test(s) && isRealDate(s.slice(0, 10)) && !Number.isNaN(Date.parse(s));

function instrumentRef(v: unknown, where: string, errs: string[]): InstrumentRefDTO | null {
  if (!isObj(v) || typeof v["provider"] !== "string" || typeof v["id"] !== "string" || v["provider"] === "" || v["id"] === "") {
    errs.push(`${where} must be { provider, id } with non-empty strings`);
    return null;
  }
  return { provider: v["provider"], id: v["id"] };
}

/** Identity for a hand-entered leg. It is NOT broker-verified; the provider says so. */
export const manualInstrument = (marketId: string, expiry: string, optionType: string, strike: number): InstrumentRefDTO => ({
  provider: "manual",
  id: `${marketId}|${expiry}|${optionType}|${strike}`,
});

function parseQuote(v: unknown, where: string, errs: string[]): PaperQuote {
  const q = isObj(v) ? v : {};
  if (!isObj(v)) errs.push(`${where}.quote must be an object`);
  const sub: string[] = [];
  const bid = num(q, "bid", sub);
  const ask = num(q, "ask", sub);
  const ltp = num(q, "ltp", sub);
  const bidQty = num(q, "bidQty", sub, { min: 0 });
  const askQty = num(q, "askQty", sub, { min: 0 });
  const volume = num(q, "volume", sub, { min: 0 });
  const oi = num(q, "oi", sub, { min: 0 });
  for (const e of sub) errs.push(`${where}.quote.${e}`);
  return { bid, ask, ltp, bidQty, askQty, volume, oi };
}

export function parseCandidateInput(raw: unknown, ctx: { now: string; newId: () => string }): ParseResult<PaperCandidate> {
  const errs: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["Request body must be a JSON object"] };

  const source = raw["source"];
  if (typeof source !== "string" || !(PAPER_SOURCES as readonly string[]).includes(source)) errs.push(`source must be one of ${PAPER_SOURCES.join(", ")}`);
  const marketId = raw["marketId"];
  if (typeof marketId !== "string" || !(MARKET_IDS as readonly string[]).includes(marketId)) errs.push(`marketId must be one of ${MARKET_IDS.join(", ")}`);
  const structure = raw["structure"];
  if (typeof structure !== "string" || !(PAPER_STRUCTURES as readonly string[]).includes(structure)) errs.push(`structure must be one of ${PAPER_STRUCTURES.join(", ")}`);
  const expiry = raw["expiry"];
  if (typeof expiry !== "string" || !isRealDate(expiry)) errs.push("expiry must be a real calendar date, YYYY-MM-DD");
  const lotSize = num(raw, "lotSize", errs, { positive: true, integer: true });
  if (raw["lotSize"] === undefined || raw["lotSize"] === null) errs.push("lotSize is required (no lot size is assumed)");

  if (source === "LONG_VOL" && structure !== "STRADDLE" && structure !== "STRANGLE") errs.push("LONG_VOL requires structure STRADDLE or STRANGLE");
  if (source === "BEST_OPPORTUNITY" && structure !== "SINGLE_CALL" && structure !== "SINGLE_PUT") errs.push("BEST_OPPORTUNITY requires structure SINGLE_CALL or SINGLE_PUT");

  const asOfRaw = raw["asOf"];
  let asOf = ctx.now;
  if (asOfRaw !== undefined && asOfRaw !== null) {
    if (typeof asOfRaw === "string" && isTimestamp(asOfRaw)) asOf = asOfRaw;
    else errs.push("asOf must be an ISO date or timestamp");
  }

  const dataSourceRaw = raw["dataSource"];
  const dataSource = dataSourceRaw === "BROKER" ? "BROKER" : "MANUAL";
  if (dataSourceRaw !== undefined && dataSourceRaw !== "MANUAL" && dataSourceRaw !== "BROKER") errs.push("dataSource must be MANUAL or BROKER");

  // legs
  const legs: PaperLeg[] = [];
  const legsRaw = raw["legs"];
  if (!Array.isArray(legsRaw)) {
    errs.push("legs must be an array");
  } else {
    legsRaw.forEach((l: unknown, i) => {
      const where = `legs[${i}]`;
      if (!isObj(l)) {
        errs.push(`${where} must be an object`);
        return;
      }
      const optionType = l["optionType"];
      if (optionType !== "CE" && optionType !== "PE") errs.push(`${where}.optionType must be CE or PE`);
      const sub: string[] = [];
      const strike = num(l, "strike", sub, { positive: true });
      if (l["strike"] === undefined || l["strike"] === null) sub.push("strike is required");
      for (const e of sub) errs.push(`${where}.${e}`);
      let instrument: InstrumentRefDTO | null = null;
      if (l["instrument"] !== undefined && l["instrument"] !== null) instrument = instrumentRef(l["instrument"], `${where}.instrument`, errs);
      else if ((optionType === "CE" || optionType === "PE") && strike !== null && typeof marketId === "string" && typeof expiry === "string") {
        instrument = manualInstrument(marketId, expiry, optionType, strike);
      }
      const quote = parseQuote(l["quote"], where, errs);
      if ((optionType === "CE" || optionType === "PE") && strike !== null && instrument !== null) {
        legs.push({ optionType, strike, instrument, quote });
      }
    });
  }

  if (typeof structure === "string" && legs.length === (Array.isArray(legsRaw) ? legsRaw.length : -1)) {
    const ce = legs.filter((l) => l.optionType === "CE");
    const pe = legs.filter((l) => l.optionType === "PE");
    if (structure === "STRADDLE" || structure === "STRANGLE") {
      if (legs.length !== 2 || ce.length !== 1 || pe.length !== 1) errs.push(`${structure} needs exactly one CE leg and one PE leg`);
      else if (structure === "STRADDLE" && ce[0]?.strike !== pe[0]?.strike) errs.push("STRADDLE needs the CE and PE at the same strike");
      else if (structure === "STRANGLE" && !((ce[0]?.strike ?? 0) > (pe[0]?.strike ?? 0))) errs.push("STRANGLE needs the CE strike above the PE strike");
    } else if (structure === "SINGLE_CALL") {
      if (legs.length !== 1 || ce.length !== 1) errs.push("SINGLE_CALL needs exactly one CE leg");
    } else if (structure === "SINGLE_PUT") {
      if (legs.length !== 1 || pe.length !== 1) errs.push("SINGLE_PUT needs exactly one PE leg");
    }
    if (new Set(legs.map((l) => `${l.instrument.provider}|${l.instrument.id}`)).size !== legs.length) errs.push("Each leg must be a different instrument");
  }

  const spot = num(raw, "spot", errs, { positive: true });
  const score = num(raw, "score", errs);
  const expectedMove = num(raw, "expectedMove", errs);
  const impliedMove = num(raw, "impliedMove", errs);
  const expectedNetEdge = num(raw, "expectedNetEdge", errs);
  const iv = num(raw, "iv", errs, { min: 0 });
  const rv20 = num(raw, "rv20", errs, { min: 0 });
  const tradingDaysToExpiry = num(raw, "tradingDaysToExpiry", errs, { min: 0, integer: true });
  const maxCapitalAllocation = num(raw, "maxCapitalAllocation", errs, { positive: true });
  const entryCosts = num(raw, "entryCosts", errs, { min: 0 });
  const requestedLots = num(raw, "requestedLots", errs, { positive: true, integer: true });
  const rvRegimeRaw = raw["rvRegime"];
  let rvRegime: string | null = null;
  if (rvRegimeRaw !== undefined && rvRegimeRaw !== null) {
    if (rvRegimeRaw === "RV_ACCELERATING" || rvRegimeRaw === "RV_DECELERATING") rvRegime = rvRegimeRaw;
    else errs.push("rvRegime must be RV_ACCELERATING, RV_DECELERATING or null");
  }
  const idRaw = raw["candidateId"];
  if (idRaw !== undefined && idRaw !== null && (typeof idRaw !== "string" || idRaw === "")) errs.push("candidateId must be a non-empty string");

  if (errs.length > 0) return { ok: false, errors: errs };

  return {
    ok: true,
    value: {
      candidateId: typeof idRaw === "string" ? idRaw : `cand_${ctx.newId()}`,
      source: source as PaperCandidate["source"],
      marketId: marketId as PaperCandidate["marketId"],
      structure: structure as PaperCandidate["structure"],
      expiry: expiry as string,
      lotSize: lotSize as number,
      dataSource,
      asOf,
      legs,
      spot,
      score,
      expectedMove,
      impliedMove,
      expectedNetEdge,
      iv,
      rv20,
      rvRegime,
      tradingDaysToExpiry,
      maxCapitalAllocation,
      entryCosts,
      requestedLots,
    },
  };
}

function parseLegQuotes(raw: unknown, key: string, errs: string[], required: boolean): LegQuoteDTO[] {
  if (raw === undefined || raw === null) {
    if (required) errs.push(`${key} is required`);
    return [];
  }
  if (!Array.isArray(raw)) {
    errs.push(`${key} must be an array`);
    return [];
  }
  const out: LegQuoteDTO[] = [];
  raw.forEach((q: unknown, i) => {
    const where = `${key}[${i}]`;
    if (!isObj(q)) {
      errs.push(`${where} must be an object`);
      return;
    }
    const instrument = instrumentRef(q["instrument"], `${where}.instrument`, errs);
    const sub: string[] = [];
    const bid = num(q, "bid", sub);
    const ask = num(q, "ask", sub);
    const ltp = num(q, "ltp", sub);
    const bidQty = num(q, "bidQty", sub, { min: 0 });
    const askQty = num(q, "askQty", sub, { min: 0 });
    const volume = num(q, "volume", sub, { min: 0 });
    const oi = num(q, "oi", sub, { min: 0 });
    for (const e of sub) errs.push(`${where}.${e}`);
    if (instrument !== null) out.push({ instrument, bid, ask, ltp, bidQty, askQty, volume, oi });
  });
  return out;
}

function optionalTimestamp(raw: Record<string, unknown>, key: string, errs: string[]): string | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" && isTimestamp(v)) return v;
  errs.push(`${key} must be an ISO date or timestamp`);
  return undefined;
}

export function parseConfirmRequest(raw: unknown): ParseResult<ConfirmRequestDTO> {
  if (!isObj(raw)) return { ok: false, errors: ["Request body must be a JSON object"] };
  if (typeof raw["confirmed"] !== "boolean") return { ok: false, errors: ["confirmed must be a boolean"] };
  return { ok: true, value: { confirmed: raw["confirmed"] } };
}

export function parseMonitorRequest(raw: unknown): ParseResult<MonitorRequestDTO> {
  if (!isObj(raw)) return { ok: false, errors: ["Request body must be a JSON object"] };
  const errs: string[] = [];
  const quotes = parseLegQuotes(raw["quotes"], "quotes", errs, true);
  const asOf = optionalTimestamp(raw, "asOf", errs);
  const tradingDaysToExpiry = num(raw, "tradingDaysToExpiry", errs, { min: 0, integer: true });
  const spot = num(raw, "spot", errs, { positive: true });
  const exitCosts = num(raw, "exitCosts", errs, { min: 0 });
  if (errs.length > 0) return { ok: false, errors: errs };
  return { ok: true, value: { ...(asOf ? { asOf } : {}), quotes, tradingDaysToExpiry, spot, exitCosts } };
}

export function parseExitRequest(raw: unknown): ParseResult<ExitRequestDTO> {
  if (!isObj(raw)) return { ok: false, errors: ["Request body must be a JSON object"] };
  const errs: string[] = [];
  const quotes = parseLegQuotes(raw["quotes"], "quotes", errs, true);
  const asOf = optionalTimestamp(raw, "asOf", errs);
  const exitCosts = num(raw, "exitCosts", errs, { min: 0 });
  if (errs.length > 0) return { ok: false, errors: errs };
  return { ok: true, value: { ...(asOf ? { asOf } : {}), quotes, exitCosts } };
}

export function parseSafetyCheckRequest(raw: unknown): ParseResult<SafetyCheckRequestDTO> {
  if (!isObj(raw)) return { ok: false, errors: ["Request body must be a JSON object"] };
  const errs: string[] = [];
  const asOf = optionalTimestamp(raw, "asOf", errs);
  if (asOf === undefined && errs.length === 0) errs.push("asOf is required");
  const completedSessions = num(raw, "completedSessions", errs, { min: 0, integer: true });
  const quotes = parseLegQuotes(raw["quotes"], "quotes", errs, false);
  const exitCosts = num(raw, "exitCosts", errs, { min: 0 });
  if (errs.length > 0 || asOf === undefined) return { ok: false, errors: errs };
  return { ok: true, value: { asOf, completedSessions, quotes, exitCosts } };
}

export type { CandidateInputDTO };
