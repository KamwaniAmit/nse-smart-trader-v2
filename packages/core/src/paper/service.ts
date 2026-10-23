import type {
  AssessResponseDTO,
  EntryQuoteDTO,
  JournalEventRecord,
  JournalExport,
  LastValidExit,
  PaperCandidate,
  PaperEntrySnapshot,
  PaperErrorCode,
  PaperExitRecord,
  PaperLeg,
  PaperLifecycleState,
  PaperMonitorSnapshot,
  PaperReview,
  PaperTradeRecord,
  RiskFilter,
  SafetyCheckResponseDTO,
} from "../contracts/index.js";
import { JournalRepositoryError } from "../journal/repository.js";
import { assessQuote } from "../marketdata/assessQuote.js";
import type { JournalRepository } from "../journal/repository.js";
import { filterByRisk } from "../risk/filter.js";
import { deepFreeze } from "./freeze.js";
import { fromPaise, toPaise } from "./money.js";
import {
  parseCandidateInput,
  parseConfirmRequest,
  parseExitRequest,
  parseMonitorRequest,
  parseSafetyCheckRequest,
} from "./parse.js";
import type { ParseResult } from "./parse.js";
import { assessEntry, computeCapital, computePnl, exitPremiumOf, legLabel, resolveLegBids } from "./pricing.js";
import { assessRiskRecord, buildRiskInputs } from "./riskInputs.js";
import { evaluateSafety } from "./safety.js";
import { TIME_RULES, checkEventTime, parseStrictTimestamp } from "./time.js";

export interface PaperTradingDeps {
  repository: JournalRepository;
  now: () => string;
  newId: () => string;
}

export interface ServiceError {
  code: PaperErrorCode;
  message: string;
  details?: string[];
  trade?: PaperTradeRecord;
}
export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

const fail = (code: PaperErrorCode, message: string, details?: string[], trade?: PaperTradeRecord): { ok: false; error: ServiceError } => ({
  ok: false,
  error: { code, message, ...(details ? { details } : {}), ...(trade ? { trade } : {}) },
});
const good = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

const invalid = (p: Extract<ParseResult<unknown>, { ok: false }>) => fail("INVALID_REQUEST", "The request is not valid.", p.errors);

/** Builds the review: executable entry check, capital and risk. Pure; nothing is stored. */
export function buildReview(candidate: PaperCandidate, at: string): PaperReview {
  const entry = assessEntry(candidate);
  const capital = computeCapital({
    combinedEntryPremium: entry.combinedEntryPremium,
    lotSize: candidate.lotSize,
    entryCosts: candidate.entryCosts,
    maxCapitalAllocation: candidate.maxCapitalAllocation,
    requestedLots: candidate.requestedLots,
  });
  return {
    entryStatus: entry.status,
    entryReasons: entry.reasons,
    combinedEntryPremium: entry.combinedEntryPremium,
    spreadPct: entry.spreadPct,
    capital,
    risk: assessRiskRecord(buildRiskInputs(candidate, capital), at),
    reviewedAt: at,
  };
}

const SNAPSHOT_CANDIDATE_FIELDS = ["spot", "tradingDaysToExpiry", "maxCapitalAllocation", "entryCosts", "expectedNetEdge", "score", "expectedMove", "impliedMove", "iv", "rv20", "rvRegime"] as const;
const CARRIED_FIELDS = ["expectedNetEdge", "iv", "rv20", "rvRegime", "maxCapitalAllocation", "entryCosts"] as const;

function missingMarketData(candidate: PaperCandidate): string[] {
  const missing: string[] = SNAPSHOT_CANDIDATE_FIELDS.filter((k) => candidate[k] === null);
  for (const leg of candidate.legs) {
    for (const k of ["volume", "oi", "bidQty", "askQty"] as const) if (leg.quote[k] === null) missing.push(`${legLabel(leg)}.${k}`);
  }
  return missing;
}

const sameInstrument = (a: { provider: string; id: string }, b: { provider: string; id: string }): boolean => a.provider === b.provider && a.id === b.id;

interface FreshLeg extends PaperLeg {
  quoteAsOf: string;
  quoteAgeMs: number;
}
type FreshQuotesResult = { ok: true; legs: FreshLeg[] } | { ok: false; code: "INVALID_REQUEST" | "DATA_INSUFFICIENT" | "QUOTE_NOT_FRESH"; reasons: string[] };

/**
 * Phase 1B.1 (D1). Validates the fresh entry quotes sent with a confirmation, against the TRUSTED server clock:
 *  - one quote per leg, for the EXACT stored instrument (another strike, expiry or instrument is refused, never used);
 *  - an executable bid AND ask (LTP, theoretical or review-time prices are never substituted);
 *  - a quote time that is a full timestamp with a zone, not later than server time + allowed skew, and not older
 *    than TIME_RULES.maxQuoteAgeMs (60 s).
 * Wrong instruments are an INVALID_REQUEST; missing or non-executable prices are DATA_INSUFFICIENT; a missing, invalid,
 * stale or future quote time is QUOTE_NOT_FRESH.
 */
export function resolveFreshEntryQuotes(legs: readonly PaperLeg[], quotes: readonly EntryQuoteDTO[] | undefined, nowMs: number): FreshQuotesResult {
  if (quotes === undefined || quotes.length === 0) {
    return { ok: false, code: "DATA_INSUFFICIENT", reasons: ["Fresh executable quotes (bid, ask and quote time) are required for every leg. Review-time prices are never reused."] };
  }
  const foreign = quotes.filter((q) => !legs.some((l) => sameInstrument(l.instrument, q.instrument)));
  if (foreign.length > 0) {
    return { ok: false, code: "INVALID_REQUEST", reasons: foreign.map((q) => `${q.instrument.id}: not a leg of this trade (another strike, expiry or instrument is never substituted)`) };
  }
  const priceReasons: string[] = [];
  const timeReasons: string[] = [];
  const fresh: FreshLeg[] = [];
  for (const leg of legs) {
    const label = legLabel(leg);
    const matches = quotes.filter((q) => sameInstrument(q.instrument, leg.instrument));
    if (matches.length === 0) {
      priceReasons.push(`${label}: no fresh quote supplied for this exact instrument`);
      continue;
    }
    if (new Set(matches.map((m) => JSON.stringify([m.bid, m.ask ?? null, m.asOf ?? null]))).size > 1) {
      priceReasons.push(`${label}: conflicting quotes supplied; ambiguous, so not used`);
      continue;
    }
    const q = matches[0] as EntryQuoteDTO;
    const verdict = assessQuote({ bid: q.bid, ask: q.ask ?? null });
    if (!verdict.executable) priceReasons.push(`${label}: ${verdict.reason} (LTP and theoretical prices are never used)`);
    const ms = q.asOf === undefined ? null : parseStrictTimestamp(q.asOf);
    if (q.asOf === undefined) timeReasons.push(`${label}: the quote has no time (asOf); its freshness cannot be checked`);
    else if (ms === null) timeReasons.push(`${label}: quote time "${q.asOf}" must be a full timestamp with a zone`);
    else if (ms > nowMs + TIME_RULES.maxFutureSkewMs) timeReasons.push(`${label}: quote time ${q.asOf} is in the future (server time ${new Date(nowMs).toISOString()})`);
    else if (nowMs - ms > TIME_RULES.maxQuoteAgeMs) timeReasons.push(`${label}: quote is older than ${TIME_RULES.maxQuoteAgeMs / 1000} s (quote time ${q.asOf}, age ${Math.round((nowMs - ms) / 1000)} s)`);
    if (verdict.executable && ms !== null) {
      fresh.push({
        ...leg,
        quote: { bid: q.bid, ask: q.ask ?? null, ltp: q.ltp ?? null, bidQty: q.bidQty ?? null, askQty: q.askQty ?? null, volume: q.volume ?? null, oi: q.oi ?? null },
        quoteAsOf: q.asOf as string,
        quoteAgeMs: nowMs - ms,
      });
    }
  }
  if (priceReasons.length > 0) return { ok: false, code: "DATA_INSUFFICIENT", reasons: [...priceReasons, ...timeReasons] };
  if (timeReasons.length > 0) return { ok: false, code: "QUOTE_NOT_FRESH", reasons: timeReasons };
  return { ok: true, legs: fresh };
}

/** Phase 1B.1 (D3): a client event time may not precede the trade's last recorded update (at least the entry). */
function notBefore(trade: PaperTradeRecord): { notBefore: string; notBeforeLabel: string } {
  const atEntry = trade.entry !== null && trade.updatedAt === trade.entry.capturedAt;
  return { notBefore: trade.updatedAt, notBeforeLabel: atEntry ? "the entry snapshot" : "the trade's last recorded update" };
}

export function createPaperTradingService(deps: PaperTradingDeps) {
  const { repository, now, newId } = deps;

  async function guard<T>(fn: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof JournalRepositoryError) {
        const code: PaperErrorCode = e.code === "TRADE_NOT_FOUND" ? "NOT_FOUND" : e.code === "INVALID_TRANSITION" || e.code === "ENTRY_IMMUTABLE" ? "INVALID_TRANSITION" : "STORAGE_ERROR";
        return fail(code, e.message);
      }
      throw e;
    }
  }

  async function load(tradeId: string): Promise<{ ok: true; trade: PaperTradeRecord } | { ok: false; error: ServiceError }> {
    const trade = await repository.getTrade(tradeId);
    return trade === null ? fail("NOT_FOUND", `Trade ${tradeId} does not exist.`) : { ok: true, trade };
  }

  return {
    /** CANDIDATE: evaluate only. Nothing is stored and nothing is opened. */
    assess(raw: unknown): ServiceResult<AssessResponseDTO> {
      const t = now();
      const parsed = parseCandidateInput(raw, { now: t, newId });
      if (!parsed.ok) return invalid(parsed);
      const review = buildReview(parsed.value, t);
      return good({ state: review.entryStatus === "EXECUTABLE" ? "CANDIDATE" : "DATA_INSUFFICIENT", candidate: parsed.value, review });
    },

    /** CANDIDATE -> PAPER_REVIEW (or DATA_INSUFFICIENT). This never opens a trade. */
    beginReview(raw: unknown): Promise<ServiceResult<PaperTradeRecord>> {
      return guard(async () => {
        const t = now();
        const parsed = parseCandidateInput(raw, { now: t, newId });
        if (!parsed.ok) return invalid(parsed);
        const candidate = parsed.value;
        const review = buildReview(candidate, t);
        const executable = review.entryStatus === "EXECUTABLE";
        const state: PaperLifecycleState = executable ? "PAPER_REVIEW" : "DATA_INSUFFICIENT";
        const tradeId = `pt_${newId()}`;
        const record: PaperTradeRecord = {
          schemaVersion: 1,
          tradeId,
          source: candidate.source,
          state,
          createdAt: t,
          updatedAt: t,
          candidate,
          review,
          entry: null,
          exit: null,
          realizedPnl: null,
          currentRisk: null,
          lastMonitor: null,
          lastValidExit: null,
          rejectionReasons: executable ? [] : review.entryReasons,
        };
        const stored = await repository.createTrade(record, {
          timestamp: t,
          type: executable ? "REVIEW_STARTED" : "REJECTED_DATA_INSUFFICIENT",
          tradeId,
          fromState: "CANDIDATE",
          toState: state,
          payload: { candidateId: candidate.candidateId, source: candidate.source, structure: candidate.structure, reasons: review.entryReasons },
        });
        return executable
          ? good(stored)
          : fail("DATA_INSUFFICIENT", "The candidate has no executable entry prices, so it cannot be reviewed or opened.", review.entryReasons, stored);
      });
    },

    /**
     * PAPER_REVIEW -> PAPER_OPEN. Only an explicit `confirmed: true` does this, and (Phase 1B.1, D1) only with FRESH
     * executable quotes for the exact legs. Entry premium, capital and entry risk are recalculated from those quotes;
     * the review-time prices are kept as history and never reused.
     */
    confirm(tradeId: string, raw: unknown): Promise<ServiceResult<PaperTradeRecord>> {
      return guard(async () => {
        const parsed = parseConfirmRequest(raw);
        if (!parsed.ok) return invalid(parsed);
        const loaded = await load(tradeId);
        if (!loaded.ok) return loaded;
        const trade = loaded.trade;
        if (!parsed.value.confirmed) return fail("CONFIRMATION_REQUIRED", "A paper trade opens only after explicit confirmation (confirmed: true).", undefined, trade);
        if (trade.state !== "PAPER_REVIEW") return fail("INVALID_TRANSITION", `Only a trade in PAPER_REVIEW can be confirmed (this one is ${trade.state}).`, undefined, trade);

        const t = now();
        const nowMs = Date.parse(t);
        const candidate = trade.candidate;
        const fresh = resolveFreshEntryQuotes(candidate.legs, parsed.value.quotes, nowMs);
        if (!fresh.ok) {
          await repository.appendEvent({ timestamp: t, type: "CONFIRM_REJECTED_QUOTE", tradeId, fromState: "PAPER_REVIEW", toState: "PAPER_REVIEW", payload: { code: fresh.code, reasons: fresh.reasons } });
          const unchanged = (await repository.getTrade(tradeId)) ?? trade;
          const message =
            fresh.code === "QUOTE_NOT_FRESH"
              ? `Entry quotes must be at most ${TIME_RULES.maxQuoteAgeMs / 1000} s old by server time. The trade stays in PAPER_REVIEW.`
              : fresh.code === "INVALID_REQUEST"
                ? "Quotes were supplied for instruments that are not legs of this trade. The trade stays in PAPER_REVIEW."
                : "Fresh executable bid and ask quotes are required for every leg. The trade stays in PAPER_REVIEW.";
          return fail(fresh.code, message, fresh.reasons, unchanged);
        }

        // Re-price from the fresh quotes (frozen formulas: entry = sum of asks; capital = premium x lotSize + costs).
        const priced: PaperCandidate = { ...candidate, legs: fresh.legs.map((l) => ({ optionType: l.optionType, strike: l.strike, instrument: l.instrument, quote: l.quote })) };
        const entryCheck = assessEntry(priced);
        const capital = computeCapital({
          combinedEntryPremium: entryCheck.combinedEntryPremium,
          lotSize: candidate.lotSize,
          entryCosts: candidate.entryCosts,
          maxCapitalAllocation: candidate.maxCapitalAllocation,
          requestedLots: candidate.requestedLots,
        });
        if (capital.gate === "FAIL") return fail("CAPITAL_GATE_FAILED", "The capital gate failed at the fresh entry price.", capital.reasons, trade);
        if (capital.lots === null || capital.lots < 1 || entryCheck.combinedEntryPremium === null) {
          return fail("LOTS_UNRESOLVED", "The number of lots is unknown. Provide requestedLots, or both maxCapitalAllocation and entryCosts.", capital.reasons, trade);
        }
        const lots = capital.lots;
        const entryRisk = assessRiskRecord(buildRiskInputs(priced, capital), t);
        const missing = missingMarketData(priced);
        const snapshot: PaperEntrySnapshot = deepFreeze({
          snapshotVersion: 2,
          capturedAt: t,
          candidateId: candidate.candidateId,
          source: candidate.source,
          marketId: candidate.marketId,
          structure: candidate.structure,
          expiry: candidate.expiry,
          dataSource: candidate.dataSource,
          legs: fresh.legs.map((l) => ({
            optionType: l.optionType,
            strike: l.strike,
            instrument: { ...l.instrument },
            entryAsk: l.quote.ask as number,
            entryBid: l.quote.bid,
            quoteAsOf: l.quoteAsOf,
            quoteAgeMs: l.quoteAgeMs,
          })),
          combinedEntryPremium: entryCheck.combinedEntryPremium,
          lotSize: candidate.lotSize,
          lots,
          spot: candidate.spot,
          expectedMove: candidate.expectedMove,
          impliedMove: candidate.impliedMove,
          expectedNetEdge: candidate.expectedNetEdge,
          score: candidate.score,
          risk: entryRisk,
          capital,
          capitalRequirement: capital.totalCapitalRequirement === null ? null : fromPaise(toPaise(capital.totalCapitalRequirement) * lots),
          dataCompleteness: { complete: missing.length === 0, missing },
          quoteFreshness: { maxQuoteAgeMs: TIME_RULES.maxQuoteAgeMs, maxFutureSkewMs: TIME_RULES.maxFutureSkewMs, evaluatedAt: t },
          candidateAsOf: candidate.asOf,
        });
        const updated = await repository.updateLifecycle(
          tradeId,
          { updatedAt: t, state: "PAPER_OPEN", entry: snapshot, currentRisk: entryRisk },
          { timestamp: t, type: "TRADE_OPENED", tradeId, fromState: "PAPER_REVIEW", toState: "PAPER_OPEN", payload: { combinedEntryPremium: snapshot.combinedEntryPremium, lots, riskLevel: entryRisk.result.riskLevel, quoteAsOf: fresh.legs.map((l) => l.quoteAsOf) } },
        );
        return good(updated);
      });
    },

    /** Records current prices, current risk and unrealized P&L. Entry risk and the entry snapshot are untouched. */
    monitor(tradeId: string, raw: unknown): Promise<ServiceResult<PaperTradeRecord>> {
      return guard(async () => {
        const parsed = parseMonitorRequest(raw);
        if (!parsed.ok) return invalid(parsed);
        const loaded = await load(tradeId);
        if (!loaded.ok) return loaded;
        const trade = loaded.trade;
        const entry = trade.entry;
        if (trade.state !== "PAPER_OPEN" || entry === null) return fail("INVALID_TRANSITION", `Only a PAPER_OPEN trade can be monitored (this one is ${trade.state}).`, undefined, trade);

        const req = parsed.value;
        const serverNow = now();
        const late = req.asOf === undefined ? [] : checkEventTime(req.asOf, { nowMs: Date.parse(serverNow), ...notBefore(trade) });
        if (late.length > 0) return fail("INVALID_REQUEST", "The monitor time (asOf) is not acceptable.", late, trade);
        const asOf = req.asOf ?? serverNow;
        const bidsResult = resolveLegBids(trade.candidate.legs, req.quotes);
        const exitPremium = exitPremiumOf(bidsResult.bids);
        const valid = exitPremium !== null;
        const unrealized = computePnl({
          entryPremium: entry.combinedEntryPremium,
          exitPremium,
          lotSize: entry.lotSize,
          lots: entry.lots,
          entryCosts: entry.capital.entryCosts,
          exitCosts: req.exitCosts ?? null,
        });

        // Current risk: market data is NOT carried from entry (missing stays missing). Strategy outputs and
        // capital parameters ARE carried, and listed in carriedFromEntry for transparency.
        const currentLegs: PaperLeg[] = trade.candidate.legs.map((leg) => {
          const matches = req.quotes.filter((q) => sameInstrument(q.instrument, leg.instrument));
          const q = matches.length >= 1 && new Set(matches.map((m) => m.bid)).size === 1 ? matches[0] : undefined;
          return { ...leg, quote: { bid: q?.bid ?? null, ask: q?.ask ?? null, ltp: q?.ltp ?? null, bidQty: q?.bidQty ?? null, askQty: q?.askQty ?? null, volume: q?.volume ?? null, oi: q?.oi ?? null } };
        });
        const currentCandidate: PaperCandidate = {
          ...trade.candidate,
          asOf,
          legs: currentLegs,
          spot: req.spot ?? null,
          tradingDaysToExpiry: req.tradingDaysToExpiry ?? null,
          requestedLots: entry.lots,
        };
        const currentRisk = assessRiskRecord(buildRiskInputs(currentCandidate, entry.capital), asOf);
        const carriedFromEntry = [...CARRIED_FIELDS.filter((k) => trade.candidate[k] !== null), "lots", "structure", "capitalUtilization"];

        const snapshot: PaperMonitorSnapshot = {
          asOf,
          legs: currentLegs.map((l, i) => ({ instrument: l.instrument, bid: l.quote.bid, ask: l.quote.ask, bidValid: bidsResult.bids[i] !== null })),
          dataStatus: valid ? "VALID" : "DATA_INSUFFICIENT",
          dataReasons: bidsResult.reasons,
          currentExitPremium: exitPremium,
          unrealized,
          currentRisk,
          carriedFromEntry,
        };
        const lastValidExit: LastValidExit | undefined = valid
          ? { asOf, legBids: trade.candidate.legs.map((l, i) => ({ instrument: l.instrument, bid: bidsResult.bids[i] as number })), exitPremium }
          : undefined;
        const updated = await repository.updateLifecycle(
          tradeId,
          { updatedAt: asOf, lastMonitor: snapshot, currentRisk, ...(lastValidExit ? { lastValidExit } : {}) },
          { timestamp: asOf, type: "MONITOR_SNAPSHOT", tradeId, fromState: "PAPER_OPEN", toState: "PAPER_OPEN", payload: { dataStatus: snapshot.dataStatus, currentExitPremium: exitPremium, grossPnl: unrealized.grossPnl, riskLevel: currentRisk.result.riskLevel } },
        );
        return good(updated);
      });
    },

    /** PAPER_OPEN -> PAPER_EXITED, only with a valid executable bid on EVERY leg. Otherwise nothing changes. */
    exit(tradeId: string, raw: unknown): Promise<ServiceResult<PaperTradeRecord>> {
      return guard(async () => {
        const parsed = parseExitRequest(raw);
        if (!parsed.ok) return invalid(parsed);
        const loaded = await load(tradeId);
        if (!loaded.ok) return loaded;
        const trade = loaded.trade;
        const entry = trade.entry;
        if (trade.state !== "PAPER_OPEN" || entry === null) return fail("INVALID_TRANSITION", `Only a PAPER_OPEN trade can be exited (this one is ${trade.state}).`, undefined, trade);

        const req = parsed.value;
        const serverNow = now();
        const late = req.asOf === undefined ? [] : checkEventTime(req.asOf, { nowMs: Date.parse(serverNow), ...notBefore(trade) });
        if (late.length > 0) return fail("INVALID_REQUEST", "The exit time (asOf) is not acceptable.", late, trade);
        const at = req.asOf ?? serverNow;
        const bidsResult = resolveLegBids(trade.candidate.legs, req.quotes);
        const exitPremium = exitPremiumOf(bidsResult.bids);
        if (exitPremium === null) {
          await repository.appendEvent({ timestamp: at, type: "EXIT_REJECTED_DATA_INSUFFICIENT", tradeId, fromState: "PAPER_OPEN", toState: "PAPER_OPEN", payload: { reasons: bidsResult.reasons } });
          const unchanged = await repository.getTrade(tradeId);
          return fail("DATA_INSUFFICIENT", "No valid executable bid for every leg. The trade stays PAPER_OPEN; no exit price is invented.", bidsResult.reasons, unchanged ?? trade);
        }
        const exit: PaperExitRecord = {
          timestamp: at,
          trigger: "USER_EXIT",
          basis: "CURRENT_QUOTE",
          priceAsOf: at,
          legBids: trade.candidate.legs.map((l, i) => ({ instrument: l.instrument, bid: bidsResult.bids[i] ?? null })),
          exitPremium,
          exitCosts: req.exitCosts ?? null,
          notes: [],
          valuationStatus: "EXECUTABLE_QUOTE",
          staleReference: null,
        };
        const realizedPnl = computePnl({ entryPremium: entry.combinedEntryPremium, exitPremium, lotSize: entry.lotSize, lots: entry.lots, entryCosts: entry.capital.entryCosts, exitCosts: req.exitCosts ?? null });
        const updated = await repository.updateLifecycle(
          tradeId,
          { updatedAt: at, state: "PAPER_EXITED", exit, realizedPnl },
          { timestamp: at, type: "TRADE_EXITED", tradeId, fromState: "PAPER_OPEN", toState: "PAPER_EXITED", payload: { exitPremium, grossPnl: realizedPnl.grossPnl, netPnl: realizedPnl.netPnl } },
        );
        return good(updated);
      });
    },

    /**
     * Expiry and safety closure. Records the lifecycle event in every case and never invents an exit price.
     * Phase 1B.1: the decision uses the trusted SERVER clock (D3, D4); a client asOf is validated and recorded only.
     * Valuation uses valid CURRENT bids for every leg, or nothing: an old monitored bid is kept as a historical
     * reference only and P&L is DATA_INSUFFICIENT (D2).
     */
    runSafetyCheck(tradeId: string, raw: unknown): Promise<ServiceResult<SafetyCheckResponseDTO>> {
      return guard(async () => {
        const parsed = parseSafetyCheckRequest(raw);
        if (!parsed.ok) return invalid(parsed);
        const loaded = await load(tradeId);
        if (!loaded.ok) return loaded;
        const trade = loaded.trade;
        const entry = trade.entry;
        if (trade.state !== "PAPER_OPEN" || entry === null) return fail("INVALID_TRANSITION", `Only a PAPER_OPEN trade can be safety-checked (this one is ${trade.state}).`, undefined, trade);

        const req = parsed.value;
        const serverNow = now();
        const late = req.asOf === undefined ? [] : checkEventTime(req.asOf, { nowMs: Date.parse(serverNow), ...notBefore(trade) });
        if (late.length > 0) return fail("INVALID_REQUEST", "The client time (asOf) is not acceptable. Expiry and safety are decided on server time.", late, trade);

        const decision = evaluateSafety({ expiry: trade.candidate.expiry, asOf: serverNow, completedSessions: req.completedSessions ?? null });
        if (decision.action === "NONE") return good({ decision, trade });

        const current = resolveLegBids(trade.candidate.legs, req.quotes ?? []);
        const currentPremium = exitPremiumOf(current.bids);
        const notes: string[] = [];
        let exit: PaperExitRecord;
        const trigger = decision.action === "EXPIRE" ? "EXPIRY" : "HOLDING_LIMIT";
        if (currentPremium !== null) {
          exit = {
            timestamp: serverNow, trigger, basis: "CURRENT_QUOTE", priceAsOf: serverNow,
            legBids: trade.candidate.legs.map((l, i) => ({ instrument: l.instrument, bid: current.bids[i] ?? null })),
            exitPremium: currentPremium, exitCosts: req.exitCosts ?? null, notes,
            valuationStatus: "EXECUTABLE_QUOTE", staleReference: null,
          };
        } else {
          notes.push("No valid executable bid for every leg at closure, so there is no exit price and P&L is DATA_INSUFFICIENT.", ...current.reasons);
          if (trade.lastValidExit !== null) {
            notes.push(`The last valid monitored bids (as of ${trade.lastValidExit.asOf}, exit premium ${trade.lastValidExit.exitPremium}) are kept as staleReference for historical reference only. They are not an executable exit price and are not used for P&L.`);
          }
          exit = {
            timestamp: serverNow, trigger, basis: "NONE", priceAsOf: null,
            legBids: trade.candidate.legs.map((l) => ({ instrument: l.instrument, bid: null })),
            exitPremium: null, exitCosts: req.exitCosts ?? null, notes,
            valuationStatus: "DATA_INSUFFICIENT", staleReference: trade.lastValidExit,
          };
        }
        const realizedPnl = computePnl({ entryPremium: entry.combinedEntryPremium, exitPremium: exit.exitPremium, lotSize: entry.lotSize, lots: entry.lots, entryCosts: entry.capital.entryCosts, exitCosts: req.exitCosts ?? null });
        const toState: PaperLifecycleState = decision.action === "EXPIRE" ? "PAPER_EXPIRED" : "PAPER_AUTO_CLOSED";
        const updated = await repository.updateLifecycle(
          tradeId,
          { updatedAt: serverNow, state: toState, exit, realizedPnl },
          {
            timestamp: serverNow,
            type: decision.action === "EXPIRE" ? "TRADE_EXPIRED" : "TRADE_AUTO_CLOSED",
            tradeId, fromState: "PAPER_OPEN", toState,
            payload: { reasons: decision.reasons, basis: exit.basis, valuationStatus: exit.valuationStatus, pnlStatus: realizedPnl.status, ...(req.asOf ? { clientAsOf: req.asOf } : {}) },
          },
        );
        return good({ decision, trade: updated });
      });
    },

    getTrade(tradeId: string): Promise<ServiceResult<{ trade: PaperTradeRecord; events: JournalEventRecord[] }>> {
      return guard(async () => {
        const loaded = await load(tradeId);
        if (!loaded.ok) return loaded;
        return good({ trade: loaded.trade, events: await repository.listEvents({ tradeId }) });
      });
    },

    /** Lists trades. The risk filter only selects rows (on current risk, else review risk); it changes nothing else. */
    async listTrades(options: { states?: readonly PaperLifecycleState[]; risk?: RiskFilter } = {}): Promise<PaperTradeRecord[]> {
      const trades = await repository.listTrades(options.states ? { states: options.states } : undefined);
      if (options.risk === undefined) return trades;
      return filterByRisk(
        trades.map((trade) => ({ trade, risk: (trade.currentRisk ?? trade.review.risk).result })),
        options.risk,
      ).map((x) => x.trade);
    },

    listEvents(filter?: { tradeId?: string }): Promise<JournalEventRecord[]> {
      return repository.listEvents(filter);
    },

    exportJournal(): Promise<JournalExport> {
      return repository.exportJournal();
    },
  };
}

export type PaperTradingService = ReturnType<typeof createPaperTradingService>;
