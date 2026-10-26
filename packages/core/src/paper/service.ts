import type {
  AssessResponseDTO,
  EntryQuoteDTO,
  ExpiryStatusDTO,
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
  PaperTradeView,
  RiskFilter,
  SafetyCheckRequestDTO,
  SafetyCheckResponseDTO,
  ValuationRuleRecord,
} from "../contracts/index.js";
import { JournalRepositoryError } from "../journal/repository.js";
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
import { assessEntry, computeCapital, computePnl, exitPremiumOf, legLabel } from "./pricing.js";
import { checkInstruments } from "./instrumentIdentity.js";
import { assessPriceQuality } from "./priceQuality.js";
import { foreignQuoteReasons, resolveTimedQuotes } from "./quoteValidation.js";
import type { TimedLegQuote, TimedQuotesResult } from "./quoteValidation.js";
import { assessRiskRecord, buildRiskInputs } from "./riskInputs.js";
import { EXPIRY_CUTOFF, evaluateSafety, expiryCutoffInstant, isAtOrPastExpiryCutoff } from "./safety.js";
import { TIME_RULES, checkEventTime } from "./time.js";

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

/** Every field of a quote that affects the accepted quote or a snapshot. Absent and null are the same. Equal = identical copy. */
const entryQuoteKey = (q: EntryQuoteDTO): string =>
  JSON.stringify([q.bid ?? null, q.ask ?? null, q.ltp ?? null, q.bidQty ?? null, q.askQty ?? null, q.volume ?? null, q.oi ?? null, q.asOf ?? null]);

/** The quote as stored on a leg (missing fields are null, never guessed). */
const toPaperQuote = (q: EntryQuoteDTO): PaperLeg["quote"] => ({
  bid: q.bid, ask: q.ask ?? null, ltp: q.ltp ?? null, bidQty: q.bidQty ?? null, askQty: q.askQty ?? null, volume: q.volume ?? null, oi: q.oi ?? null,
});

interface FreshLeg extends PaperLeg {
  quoteAsOf: string;
  quoteAgeMs: number;
}
type FreshQuotesResult = { ok: true; legs: FreshLeg[] } | { ok: false; code: "INVALID_REQUEST" | "DATA_INSUFFICIENT" | "QUOTE_NOT_FRESH"; reasons: string[] };

/**
 * Phase 1B.1 (D1). Validates the fresh entry quotes sent with a confirmation, against the TRUSTED server clock:
 *  - one quote per leg, for the EXACT stored instrument (another strike, expiry or instrument is refused, never used);
 *  - an executable bid AND ask (LTP, theoretical or review-time prices are never substituted);
 *  - a quote time that is a full timestamp with a zone, not later than server time + the client-clock tolerance, and not
 *    older than TIME_RULES.maxQuoteAgeMs (60 s).
 * Since Phase 1B.2 this is the shared resolveTimedQuotes (also used for monitor, exit and holding-limit prices).
 */
export function resolveFreshEntryQuotes(legs: readonly PaperLeg[], quotes: readonly EntryQuoteDTO[] | undefined, nowMs: number): FreshQuotesResult {
  if (quotes === undefined || quotes.length === 0) {
    return { ok: false, code: "DATA_INSUFFICIENT", reasons: ["Fresh executable quotes (bid, ask and quote time) are required for every leg. Review-time prices are never reused."] };
  }
  const r = resolveTimedQuotes(legs, quotes, nowMs, { maxAgeMs: TIME_RULES.maxQuoteAgeMs, noun: "quote", key: entryQuoteKey });
  if (!r.ok) return { ok: false, code: r.code, reasons: r.reasons };
  return { ok: true, legs: r.legs.map((t) => ({ ...t.leg, quote: toPaperQuote(t.quote), quoteAsOf: t.enteredAt, quoteAgeMs: t.entryAgeMs })) };
}

/** Phase 1B.2: validates MANUAL monitor / exit / holding-limit prices (same rule as entry; 60 s since manual entry). */
const resolveManualPrices = (legs: readonly PaperLeg[], quotes: readonly EntryQuoteDTO[], nowMs: number): TimedQuotesResult =>
  resolveTimedQuotes(legs, quotes, nowMs, { maxAgeMs: TIME_RULES.maxManualPriceAgeMs, noun: "manual price", key: entryQuoteKey });

/** The rule values recorded with a manual valuation (Phase 1B.2). */
const valuationRuleAt = (expiry: string, evaluatedAt: string): ValuationRuleRecord => ({
  maxManualPriceAgeMs: TIME_RULES.maxManualPriceAgeMs,
  maxFutureSkewMs: TIME_RULES.maxFutureSkewMs,
  expiryCutoff: expiryCutoffInstant(expiry),
  evaluatedAt,
});

/** Exit-leg prices from validated manual quotes: bid, ask, when typed and how old (Phase 1B.2). */
const checkedLegPrices = (timed: readonly TimedLegQuote[]) =>
  timed.map((t) => ({ instrument: t.leg.instrument, bid: t.quote.bid, ask: t.quote.ask ?? null, enteredAt: t.enteredAt, entryAgeMs: t.entryAgeMs }));

/** Phase 1B.2 (A7, D3): derived, never stored. Where the trade stands relative to its contract's provisional cutoff. */
function expiryStatusOf(trade: PaperTradeRecord, nowMs: number): ExpiryStatusDTO {
  const ids = checkInstruments(trade.candidate); // final review: never later than any readable instrument expiry
  const cutoff = expiryCutoffInstant(ids.expiryUsed);
  const past = isAtOrPastExpiryCutoff(ids.expiryUsed, nowMs);
  const base = { cutoff, expiryUsed: ids.expiryUsed, instrumentCheck: ids.check, instrumentReasons: ids.reasons };
  if (trade.state === "PAPER_REVIEW") return { status: past ? "EXPIRED_REVIEW" : "BEFORE_CUTOFF", ...base };
  if (trade.state === "PAPER_OPEN") return { status: past ? "EXPIRED_PENDING_CLOSURE" : "BEFORE_CUTOFF", ...base };
  return { status: "CLOSED", ...base };
}

/** A trade as returned by the service: the stored record plus derived fields. The record itself is never changed. */
const toView = (trade: PaperTradeRecord, nowMs: number): PaperTradeView => ({ ...trade, priceQuality: assessPriceQuality(trade, nowMs), expiryStatus: expiryStatusOf(trade, nowMs) });

/**
 * Final review: an older record whose instruments do not verifiably identify its contract (MISMATCH / UNVERIFIABLE) is
 * never confirmed, monitored, exited or priced. It can only be closed unpriced by the safety check. Nothing is written.
 */
const unverifiedInstrument = (action: string, ids: { check: string; reasons: string[] }, trade: PaperTradeRecord) =>
  fail(
    "DATA_INSUFFICIENT",
    `${action} is not allowed: this record was written by an older version and its instruments do not verifiably identify its contract (${ids.check}). ` +
      "No price can be attributed to it. An open trade can still be closed, unpriced, by the safety check (expiry or holding limit). Nothing was changed.",
    ids.reasons,
    trade,
  );

/** Phase 1B.2 (A3, A6, A12): the message for an action refused at or after the cutoff. */
const expiredMessage = (expiry: string, action: string): string =>
  `${action} is not allowed: contract ${expiry} reached its provisional paper-safety cutoff (${EXPIRY_CUTOFF.localTime} IST on ${expiry}). ` +
  "Normal actions have stopped; an open trade is closed by running the safety check (expiry closure).";

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
    /**
     * CANDIDATE: evaluate only. Nothing is stored and nothing is opened. Phase 1B.2 (A12): refused at or after the
     * contract's provisional cutoff.
     */
    assess(raw: unknown): ServiceResult<AssessResponseDTO> {
      const t = now();
      const parsed = parseCandidateInput(raw, { now: t, newId });
      if (!parsed.ok) return invalid(parsed);
      if (isAtOrPastExpiryCutoff(parsed.value.expiry, Date.parse(t))) return fail("CONTRACT_EXPIRED", expiredMessage(parsed.value.expiry, "Assessing a candidate"));
      const review = buildReview(parsed.value, t);
      return good({ state: review.entryStatus === "EXECUTABLE" ? "CANDIDATE" : "DATA_INSUFFICIENT", candidate: parsed.value, review });
    },

    /**
     * CANDIDATE -> PAPER_REVIEW (or DATA_INSUFFICIENT). This never opens a trade. Phase 1B.2 (A12): refused at or after
     * the contract's provisional cutoff, and then nothing is stored or journaled.
     */
    beginReview(raw: unknown): Promise<ServiceResult<PaperTradeView>> {
      return guard(async () => {
        const t = now();
        const nowMs = Date.parse(t);
        const parsed = parseCandidateInput(raw, { now: t, newId });
        if (!parsed.ok) return invalid(parsed);
        if (isAtOrPastExpiryCutoff(parsed.value.expiry, nowMs)) return fail("CONTRACT_EXPIRED", expiredMessage(parsed.value.expiry, "Starting a review"));
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
          ? good(toView(stored, nowMs))
          : fail("DATA_INSUFFICIENT", "The candidate has no executable entry prices, so it cannot be reviewed or opened.", review.entryReasons, stored);
      });
    },

    /**
     * PAPER_REVIEW -> PAPER_OPEN. Only an explicit `confirmed: true` does this, and (Phase 1B.1, D1) only with FRESH
     * executable quotes for the exact legs. Entry premium, capital and entry risk are recalculated from those quotes;
     * the review-time prices are kept as history and never reused.
     */
    confirm(tradeId: string, raw: unknown): Promise<ServiceResult<PaperTradeView>> {
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
        const ids = checkInstruments(candidate); // final review: an older record's instrument expiry can only bring the cutoff earlier
        // Phase 1B.2 (A7): an expired review stays PAPER_REVIEW (no new lifecycle state) and can no longer be confirmed.
        if (isAtOrPastExpiryCutoff(ids.expiryUsed, nowMs)) {
          const cutoff = expiryCutoffInstant(ids.expiryUsed);
          await repository.appendEvent({ timestamp: t, type: "CONFIRM_REJECTED_EXPIRED", tradeId, fromState: "PAPER_REVIEW", toState: "PAPER_REVIEW", payload: { code: "CONTRACT_EXPIRED", expiryCutoff: cutoff } });
          const unchanged = (await repository.getTrade(tradeId)) ?? trade;
          return fail("CONTRACT_EXPIRED", expiredMessage(ids.expiryUsed, "Confirming this paper trade"), [`Cutoff ${cutoff}; server time ${t}. The trade stays in PAPER_REVIEW.`], unchanged);
        }
        // Final review: an older review whose instruments do not verifiably identify its contract is never opened.
        if (ids.check !== "CONSISTENT") return unverifiedInstrument("Confirming this paper trade", ids, trade);
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
        return good(toView(updated, nowMs));
      });
    },

    /**
     * Records current prices, current risk and unrealized P&L. Entry risk and the entry snapshot are untouched.
     * Phase 1B.2: refused at or after the contract's cutoff (A12). Prices are manual entries checked by the shared rule
     * (A2, HIGH-2); a bad price gives a DATA_INSUFFICIENT snapshot and never replaces the last valid bids (A8).
     * A quote for another instrument is an INVALID_REQUEST (D1).
     */
    monitor(tradeId: string, raw: unknown): Promise<ServiceResult<PaperTradeView>> {
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
        const nowMs = Date.parse(serverNow);
        const ids = checkInstruments(trade.candidate); // final review
        const expiryUsed = ids.expiryUsed;
        if (isAtOrPastExpiryCutoff(expiryUsed, nowMs)) {
          return fail("CONTRACT_EXPIRED", expiredMessage(expiryUsed, "Monitoring"), [`Cutoff ${expiryCutoffInstant(expiryUsed)}; server time ${serverNow}.`], trade);
        }
        if (ids.check !== "CONSISTENT") return unverifiedInstrument("Monitoring", ids, trade);
        const late = req.asOf === undefined ? [] : checkEventTime(req.asOf, { nowMs, ...notBefore(trade) });
        if (late.length > 0) return fail("INVALID_REQUEST", "The monitor time (asOf) is not acceptable.", late, trade);
        const foreign = foreignQuoteReasons(trade.candidate.legs, req.quotes);
        if (foreign.length > 0) return fail("INVALID_REQUEST", "Quotes were supplied for instruments that are not legs of this trade. Nothing was recorded.", foreign, trade);
        // Review correction R2: the authoritative time is the SERVER clock. A validated client asOf is kept only as
        // observational metadata (clientAsOf); it never becomes updatedAt or a journal event time.
        const asOf = serverNow;
        const clientAsOf = req.asOf;
        const checked = resolveManualPrices(trade.candidate.legs, req.quotes, nowMs);
        const timedByLeg = checked.ok ? checked.legs : null;
        const exitPremium = timedByLeg === null ? null : exitPremiumOf(timedByLeg.map((t) => t.quote.bid));
        const valid = exitPremium !== null;
        const unrealized = computePnl({
          entryPremium: entry.combinedEntryPremium,
          exitPremium,
          lotSize: entry.lotSize,
          lots: entry.lots,
          entryCosts: entry.capital.entryCosts,
          exitCosts: req.exitCosts ?? null,
        });

        // Current risk: market data is NOT carried from entry (missing stays missing). Strategy outputs and capital
        // parameters ARE carried, and listed in carriedFromEntry. A leg's quote is used only when it is unambiguous.
        const legQuote = (i: number): EntryQuoteDTO | null => (timedByLeg !== null ? (timedByLeg[i]?.quote ?? null) : checked.ok ? null : (checked.unambiguous[i] ?? null));
        const currentLegs: PaperLeg[] = trade.candidate.legs.map((leg, i) => {
          const q = legQuote(i);
          return { ...leg, quote: q === null ? { bid: null, ask: null, ltp: null, bidQty: null, askQty: null, volume: null, oi: null } : toPaperQuote(q) };
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
          legs: currentLegs.map((l, i) => {
            const t = timedByLeg?.[i];
            return { instrument: l.instrument, bid: l.quote.bid, ask: l.quote.ask, bidValid: valid, ...(t ? { enteredAt: t.enteredAt, entryAgeMs: t.entryAgeMs } : {}) };
          }),
          dataStatus: valid ? "VALID" : "DATA_INSUFFICIENT",
          dataReasons: checked.ok ? [] : checked.reasons,
          currentExitPremium: exitPremium,
          unrealized,
          currentRisk,
          carriedFromEntry,
          ...(clientAsOf !== undefined ? { clientAsOf } : {}),
          priceProvenance: "MANUAL_USER_ENTRY",
          valuationRule: valuationRuleAt(expiryUsed, asOf),
        };
        const lastValidExit: LastValidExit | undefined =
          valid && timedByLeg !== null
            ? { asOf, legBids: timedByLeg.map((t) => ({ instrument: t.leg.instrument, bid: t.quote.bid as number, enteredAt: t.enteredAt })), exitPremium, priceProvenance: "MANUAL_USER_ENTRY" }
            : undefined;
        const updated = await repository.updateLifecycle(
          tradeId,
          { updatedAt: asOf, lastMonitor: snapshot, currentRisk, ...(lastValidExit ? { lastValidExit } : {}) },
          { timestamp: asOf, type: "MONITOR_SNAPSHOT", tradeId, fromState: "PAPER_OPEN", toState: "PAPER_OPEN", payload: { dataStatus: snapshot.dataStatus, currentExitPremium: exitPremium, grossPnl: unrealized.grossPnl, riskLevel: currentRisk.result.riskLevel, ...(clientAsOf !== undefined ? { clientAsOf } : {}) } },
        );
        return good(toView(updated, nowMs));
      });
    },

    /**
     * PAPER_OPEN -> PAPER_EXITED, only with checked manual prices for EVERY leg. Otherwise nothing changes.
     * Phase 1B.2: refused at or after the cutoff (A12); bid AND ask must pass the entry rule (HIGH-2); each price must
     * carry a user-entry time within the approved time limits (A1, A2). The valuation is MANUAL_ENTRY_CHECKED (A9).
     */
    exit(tradeId: string, raw: unknown): Promise<ServiceResult<PaperTradeView>> {
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
        const nowMs = Date.parse(serverNow);
        // Review correction R2: server time is authoritative for the exit, its journal event and a rejected attempt.
        const at = serverNow;
        const clientAsOf = req.asOf;
        const ids = checkInstruments(trade.candidate); // final review
        const expiryUsed = ids.expiryUsed;
        if (isAtOrPastExpiryCutoff(expiryUsed, nowMs)) {
          const cutoff = expiryCutoffInstant(expiryUsed);
          await repository.appendEvent({ timestamp: at, type: "EXIT_REJECTED_EXPIRED", tradeId, fromState: "PAPER_OPEN", toState: "PAPER_OPEN", payload: { code: "CONTRACT_EXPIRED", expiryCutoff: cutoff, ...(clientAsOf !== undefined ? { clientAsOf } : {}) } });
          const unchanged = await repository.getTrade(tradeId);
          return fail("CONTRACT_EXPIRED", expiredMessage(expiryUsed, "Exiting"), [`Cutoff ${cutoff}; server time ${serverNow}. The trade stays PAPER_OPEN until the expiry closure runs.`], unchanged ?? trade);
        }
        if (ids.check !== "CONSISTENT") return unverifiedInstrument("Exiting", ids, trade);
        const late = req.asOf === undefined ? [] : checkEventTime(req.asOf, { nowMs, ...notBefore(trade) });
        if (late.length > 0) return fail("INVALID_REQUEST", "The exit time (asOf) is not acceptable.", late, trade);
        const checked = resolveManualPrices(trade.candidate.legs, req.quotes, nowMs);
        if (!checked.ok) {
          if (checked.code === "INVALID_REQUEST") return fail("INVALID_REQUEST", "Quotes were supplied for instruments that are not legs of this trade. The trade stays PAPER_OPEN.", checked.reasons, trade);
          const type = checked.code === "QUOTE_NOT_FRESH" ? "EXIT_REJECTED_QUOTE" : "EXIT_REJECTED_DATA_INSUFFICIENT";
          await repository.appendEvent({ timestamp: at, type, tradeId, fromState: "PAPER_OPEN", toState: "PAPER_OPEN", payload: { code: checked.code, reasons: checked.reasons, ...(clientAsOf !== undefined ? { clientAsOf } : {}) } });
          const unchanged = await repository.getTrade(tradeId);
          const message =
            checked.code === "QUOTE_NOT_FRESH"
              ? `Every exit price needs its own entry time, at most ${TIME_RULES.maxManualPriceAgeMs / 1000} s before the server processes it. The trade stays PAPER_OPEN.`
              : "No valid bid and ask for every leg. The trade stays PAPER_OPEN; no exit price is invented.";
          return fail(checked.code, message, checked.reasons, unchanged ?? trade);
        }
        const exitPremium = exitPremiumOf(checked.legs.map((t) => t.quote.bid)) as number;
        const exit: PaperExitRecord = {
          timestamp: at,
          trigger: "USER_EXIT",
          basis: "CURRENT_QUOTE",
          // R4: these quotes carry no observation time, so none is recorded. `timestamp` is the server processing time.
          priceAsOf: null,
          legBids: checkedLegPrices(checked.legs),
          exitPremium,
          exitCosts: req.exitCosts ?? null,
          notes: [],
          valuationStatus: "MANUAL_ENTRY_CHECKED",
          staleReference: null,
          ...(clientAsOf !== undefined ? { clientAsOf } : {}),
          priceProvenance: "MANUAL_USER_ENTRY",
          valuationRule: valuationRuleAt(expiryUsed, at),
        };
        const realizedPnl = computePnl({ entryPremium: entry.combinedEntryPremium, exitPremium, lotSize: entry.lotSize, lots: entry.lots, entryCosts: entry.capital.entryCosts, exitCosts: req.exitCosts ?? null });
        const updated = await repository.updateLifecycle(
          tradeId,
          { updatedAt: at, state: "PAPER_EXITED", exit, realizedPnl },
          { timestamp: at, type: "TRADE_EXITED", tradeId, fromState: "PAPER_OPEN", toState: "PAPER_EXITED", payload: { exitPremium, grossPnl: realizedPnl.grossPnl, netPnl: realizedPnl.netPnl, ...(clientAsOf !== undefined ? { clientAsOf } : {}) } },
        );
        return good(toView(updated, nowMs));
      });
    },

    /**
     * Expiry and safety closure. Records the lifecycle event in every case and never invents an exit price.
     * The decision uses the trusted SERVER clock (D3, D4); a client asOf is validated and recorded only.
     * Phase 1B.2:
     *  - EXPIRY (at or after the provisional 15:30 IST cutoff, A3) is NEVER valued: there is no approved settlement-price
     *    source, so basis NONE and P&L DATA_INSUFFICIENT, whatever prices are supplied (A4). An earlier monitored bid stays
     *    a historical reference only (D2).
     *  - HOLDING_LIMIT uses a session count typed by the user (no trading calendar). It is valued only from manual prices
     *    that pass the shared rule before the cutoff (MANUAL_ENTRY_CHECKED); otherwise it closes unpriced (A5).
     *  - A quote for another instrument is an INVALID_REQUEST and nothing changes (D1) - before the cutoff.
     *  - Safety-review correction: at or after the cutoff the SERVER clock alone decides. Untrusted request metadata
     *    (an unacceptable or malformed client asOf, a quote for another instrument) cannot block the required unpriced
     *    expiry closure; it is ignored, never recorded as clientAsOf and never used for any price, and a note says so.
     *    Before the cutoff every check above is unchanged, and any other invalid field is still refused.
     */
    runSafetyCheck(tradeId: string, raw: unknown): Promise<ServiceResult<SafetyCheckResponseDTO>> {
      return guard(async () => {
        const parsed = parseSafetyCheckRequest(raw);
        // If the client asOf is the ONLY invalid field, the decision is deferred until the server clock is known.
        // Every other parse error is refused at once, exactly as before.
        let deferredAsOf: Extract<ParseResult<unknown>, { ok: false }> | null = null;
        let req: SafetyCheckRequestDTO;
        if (parsed.ok) {
          req = parsed.value;
        } else {
          const hasAsOf = typeof raw === "object" && raw !== null && !Array.isArray(raw) && (raw as Record<string, unknown>)["asOf"] !== undefined;
          const withoutAsOf = hasAsOf ? parseSafetyCheckRequest({ ...(raw as Record<string, unknown>), asOf: undefined }) : null;
          if (withoutAsOf === null || !withoutAsOf.ok) return invalid(parsed);
          deferredAsOf = parsed;
          req = withoutAsOf.value;
        }
        const loaded = await load(tradeId);
        if (!loaded.ok) return deferredAsOf !== null ? invalid(deferredAsOf) : loaded;
        const trade = loaded.trade;
        const entry = trade.entry;
        if (trade.state !== "PAPER_OPEN" || entry === null) {
          if (deferredAsOf !== null) return invalid(deferredAsOf);
          return fail("INVALID_TRANSITION", `Only a PAPER_OPEN trade can be safety-checked (this one is ${trade.state}).`, undefined, trade);
        }

        const serverNow = now();
        const nowMs = Date.parse(serverNow);
        // The server clock decides (D3, A3). completedSessions was parsed strictly above.
        const ids = checkInstruments(trade.candidate); // final review: never later than a readable instrument expiry
        const expiryUsed = ids.expiryUsed;
        const decision = evaluateSafety({ expiry: expiryUsed, asOf: serverNow, completedSessions: req.completedSessions ?? null });
        const expired = decision.action === "EXPIRE";
        const quotes = req.quotes ?? [];
        const late = deferredAsOf !== null ? deferredAsOf.errors : req.asOf === undefined ? [] : checkEventTime(req.asOf, { nowMs, ...notBefore(trade) });
        const foreign = foreignQuoteReasons(trade.candidate.legs, quotes);
        const ignored: string[] = [];
        if (!expired) {
          // Before the cutoff: unchanged strict behaviour.
          if (deferredAsOf !== null) return invalid(deferredAsOf);
          if (late.length > 0) return fail("INVALID_REQUEST", "The client time (asOf) is not acceptable. Expiry and safety are decided on server time.", late, trade);
          if (foreign.length > 0) return fail("INVALID_REQUEST", "Quotes were supplied for instruments that are not legs of this trade. Nothing was changed.", foreign, trade);
        } else {
          if (late.length > 0) ignored.push(`The client time (asOf) was not acceptable and was ignored; expiry is decided on server time: ${late.join("; ")}`);
          if (foreign.length > 0) ignored.push(`Quotes for instruments that are not legs of this trade were ignored: ${foreign.join("; ")}`);
        }
        const clientAsOf = req.asOf !== undefined && late.length === 0 ? req.asOf : undefined;

        if (decision.action === "NONE") return good({ decision, trade: toView(trade, nowMs) });

        const trigger = expired ? "EXPIRY" : "HOLDING_LIMIT";
        const notes: string[] = [];
        // Final review: a record whose instruments are not CONSISTENT is never priced; its holding-limit closure is unpriced.
        const priceable = ids.check === "CONSISTENT";
        const checked = trigger === "HOLDING_LIMIT" && priceable && quotes.length > 0 ? resolveManualPrices(trade.candidate.legs, quotes, nowMs) : null;
        const rule = valuationRuleAt(expiryUsed, serverNow);
        const sessions = trigger === "HOLDING_LIMIT" ? { sessionsSource: "USER_PROVIDED" as const } : {};
        let exit: PaperExitRecord;
        if (checked !== null && checked.ok) {
          exit = {
            timestamp: serverNow, trigger, basis: "CURRENT_QUOTE", priceAsOf: null, // R4: no quote-observation time exists
            legBids: checkedLegPrices(checked.legs),
            exitPremium: exitPremiumOf(checked.legs.map((t) => t.quote.bid)), exitCosts: req.exitCosts ?? null,
            notes: ["Holding limit: the completed-session count was entered by the user; there is no trading calendar."],
            valuationStatus: "MANUAL_ENTRY_CHECKED", staleReference: null,
            priceProvenance: "MANUAL_USER_ENTRY", valuationRule: rule, ...sessions,
          };
        } else {
          if (trigger === "EXPIRY") {
            notes.push("Expiry closure: there is no approved settlement-price source, so there is no exit price and P&L is DATA_INSUFFICIENT.");
            if (quotes.length > 0) notes.push("Supplied prices were not used: after the cutoff there is no live market to value the contract from.");
            notes.push(...ignored);
          } else {
            notes.push("Holding limit: the completed-session count was entered by the user; there is no trading calendar.");
            if (!priceable) {
              notes.push(`Not priced: the instruments do not verifiably identify this contract (${ids.check}), so no price can be attributed to it; there is no exit price and P&L is DATA_INSUFFICIENT.`, ...ids.reasons);
              if (quotes.length > 0) notes.push("Supplied prices were not used.");
            } else {
              notes.push("No checked manual price for every leg at closure, so there is no exit price and P&L is DATA_INSUFFICIENT.", ...(checked !== null && !checked.ok ? checked.reasons : []));
            }
          }
          if (trade.lastValidExit !== null) {
            notes.push(`The last valid monitored bids (recorded by the server at ${trade.lastValidExit.asOf}, exit premium ${trade.lastValidExit.exitPremium}) are kept as staleReference for historical reference only. They are not an executable exit price and are not used for P&L.`);
          }
          exit = {
            timestamp: serverNow, trigger, basis: "NONE", priceAsOf: null,
            legBids: trade.candidate.legs.map((l) => ({ instrument: l.instrument, bid: null })),
            exitPremium: null, exitCosts: req.exitCosts ?? null, notes,
            valuationStatus: "DATA_INSUFFICIENT", staleReference: trade.lastValidExit,
            priceProvenance: "NONE", valuationRule: rule, ...sessions,
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
            payload: { reasons: decision.reasons, basis: exit.basis, valuationStatus: exit.valuationStatus, pnlStatus: realizedPnl.status, ...(clientAsOf ? { clientAsOf } : {}) },
          },
        );
        return good({ decision, trade: toView(updated, nowMs) });
      });
    },

    /** The trade (with derived priceQuality and expiryStatus) and its journal events. Reading never changes anything. */
    getTrade(tradeId: string): Promise<ServiceResult<{ trade: PaperTradeView; events: JournalEventRecord[] }>> {
      return guard(async () => {
        const nowMs = Date.parse(now());
        const loaded = await load(tradeId);
        if (!loaded.ok) return loaded;
        return good({ trade: toView(loaded.trade, nowMs), events: await repository.listEvents({ tradeId }) });
      });
    },

    /** Lists trades. The risk filter only selects rows (on current risk, else review risk); it changes nothing else. */
    async listTrades(options: { states?: readonly PaperLifecycleState[]; risk?: RiskFilter } = {}): Promise<PaperTradeView[]> {
      const nowMs = Date.parse(now());
      const trades = await repository.listTrades(options.states ? { states: options.states } : undefined);
      const selected =
        options.risk === undefined
          ? trades
          : filterByRisk(
              trades.map((trade) => ({ trade, risk: (trade.currentRisk ?? trade.review.risk).result })),
              options.risk,
            ).map((x) => x.trade);
      return selected.map((t) => toView(t, nowMs));
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
