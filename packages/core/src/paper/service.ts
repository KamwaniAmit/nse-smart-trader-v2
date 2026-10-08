import type {
  AssessResponseDTO,
  ExitBasis,
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

    /** PAPER_REVIEW -> PAPER_OPEN. Only an explicit `confirmed: true` does this. */
    confirm(tradeId: string, raw: unknown): Promise<ServiceResult<PaperTradeRecord>> {
      return guard(async () => {
        const parsed = parseConfirmRequest(raw);
        if (!parsed.ok) return invalid(parsed);
        const loaded = await load(tradeId);
        if (!loaded.ok) return loaded;
        const trade = loaded.trade;
        if (!parsed.value.confirmed) return fail("CONFIRMATION_REQUIRED", "A paper trade opens only after explicit confirmation (confirmed: true).", undefined, trade);
        if (trade.state !== "PAPER_REVIEW") return fail("INVALID_TRANSITION", `Only a trade in PAPER_REVIEW can be confirmed (this one is ${trade.state}).`, undefined, trade);

        const capital = trade.review.capital;
        if (capital.gate === "FAIL") return fail("CAPITAL_GATE_FAILED", "The capital gate failed.", capital.reasons, trade);
        if (capital.lots === null || capital.lots < 1 || trade.review.combinedEntryPremium === null) {
          return fail("LOTS_UNRESOLVED", "The number of lots is unknown. Provide requestedLots, or both maxCapitalAllocation and entryCosts.", capital.reasons, trade);
        }
        const lots = capital.lots;
        const t = now();
        const candidate = trade.candidate;
        const entryRisk = assessRiskRecord(buildRiskInputs(candidate, capital), t);
        const missing = missingMarketData(candidate);
        const snapshot: PaperEntrySnapshot = deepFreeze({
          snapshotVersion: 1,
          capturedAt: t,
          candidateId: candidate.candidateId,
          source: candidate.source,
          marketId: candidate.marketId,
          structure: candidate.structure,
          expiry: candidate.expiry,
          dataSource: candidate.dataSource,
          legs: candidate.legs.map((l) => ({
            optionType: l.optionType,
            strike: l.strike,
            instrument: { ...l.instrument },
            entryAsk: l.quote.ask as number,
            entryBid: l.quote.bid,
          })),
          combinedEntryPremium: trade.review.combinedEntryPremium,
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
        });
        const updated = await repository.updateLifecycle(
          tradeId,
          { updatedAt: t, state: "PAPER_OPEN", entry: snapshot, currentRisk: entryRisk },
          { timestamp: t, type: "TRADE_OPENED", tradeId, fromState: "PAPER_REVIEW", toState: "PAPER_OPEN", payload: { combinedEntryPremium: snapshot.combinedEntryPremium, lots, riskLevel: entryRisk.result.riskLevel } },
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
        const asOf = req.asOf ?? now();
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
        const at = req.asOf ?? now();
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
     * Expiry and safety closure. Records the lifecycle event in every case. It never invents an exit price:
     * current valid bids, else the last valid monitored bids (clearly labelled), else no price and DATA_INSUFFICIENT P&L.
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
        const decision = evaluateSafety({ expiry: trade.candidate.expiry, asOf: req.asOf, completedSessions: req.completedSessions ?? null });
        if (decision.action === "NONE") return good({ decision, trade });

        const current = resolveLegBids(trade.candidate.legs, req.quotes ?? []);
        const currentPremium = exitPremiumOf(current.bids);
        let basis: ExitBasis = "NONE";
        let exitPremium: number | null = null;
        let priceAsOf: string | null = null;
        let legBids: PaperExitRecord["legBids"] = trade.candidate.legs.map((l) => ({ instrument: l.instrument, bid: null }));
        const notes: string[] = [];
        if (currentPremium !== null) {
          basis = "CURRENT_QUOTE";
          exitPremium = currentPremium;
          priceAsOf = req.asOf;
          legBids = trade.candidate.legs.map((l, i) => ({ instrument: l.instrument, bid: current.bids[i] ?? null }));
        } else if (trade.lastValidExit !== null) {
          basis = "LAST_VALID_MONITOR_BID";
          exitPremium = trade.lastValidExit.exitPremium;
          priceAsOf = trade.lastValidExit.asOf;
          legBids = trade.lastValidExit.legBids.map((b) => ({ instrument: b.instrument, bid: b.bid }));
          notes.push(`Not a current quote: these are the last valid bids recorded by monitoring at ${trade.lastValidExit.asOf}.`);
        } else {
          notes.push("No valid executable bid was supplied and none was ever recorded. No exit price exists, so P&L is DATA_INSUFFICIENT.", ...current.reasons);
        }
        const trigger = decision.action === "EXPIRE" ? "EXPIRY" : "HOLDING_LIMIT";
        const exit: PaperExitRecord = { timestamp: req.asOf, trigger, basis, priceAsOf, legBids, exitPremium, exitCosts: req.exitCosts ?? null, notes };
        const realizedPnl = computePnl({ entryPremium: entry.combinedEntryPremium, exitPremium, lotSize: entry.lotSize, lots: entry.lots, entryCosts: entry.capital.entryCosts, exitCosts: req.exitCosts ?? null });
        const toState: PaperLifecycleState = decision.action === "EXPIRE" ? "PAPER_EXPIRED" : "PAPER_AUTO_CLOSED";
        const updated = await repository.updateLifecycle(
          tradeId,
          { updatedAt: req.asOf, state: toState, exit, realizedPnl },
          { timestamp: req.asOf, type: decision.action === "EXPIRE" ? "TRADE_EXPIRED" : "TRADE_AUTO_CLOSED", tradeId, fromState: "PAPER_OPEN", toState, payload: { reasons: decision.reasons, basis, pnlStatus: realizedPnl.status } },
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
