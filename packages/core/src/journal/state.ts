import type { JournalEventRecord, JournalExport, PaperLifecycleState, PaperTradeRecord } from "../contracts/index.js";
import { JOURNAL_DURABILITY_NOTICE, PAPER_LIFECYCLE_STATES } from "../contracts/index.js";
import { cloneJson, deepFreeze } from "../paper/freeze.js";
import { isAllowedTransition, isTerminalState } from "../paper/lifecycle.js";
import { JournalRepositoryError } from "./repository.js";
import type { LifecyclePatch, NewJournalEvent, TradeListFilter } from "./repository.js";

/** Plain JSON data of the whole journal. This is exactly what a file repository writes to disk. */
export interface JournalStateData {
  schemaVersion: 1;
  nextSequence: number;
  trades: Record<string, PaperTradeRecord>;
  events: JournalEventRecord[];
}

export const emptyJournalState = (): JournalStateData => ({ schemaVersion: 1, nextSequence: 1, trades: {}, events: [] });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates data loaded from storage. Corrupt data is an error: it is never silently replaced or "repaired". */
export function validateJournalState(raw: unknown): JournalStateData {
  const corrupt = (why: string) => new JournalRepositoryError("STORAGE_CORRUPT", `Journal data is corrupt: ${why}`);
  if (!isObj(raw)) throw corrupt("not an object");
  if (raw["schemaVersion"] !== 1) {
    throw typeof raw["schemaVersion"] === "number"
      ? new JournalRepositoryError("STORAGE_VERSION_UNSUPPORTED", `Journal schemaVersion ${raw["schemaVersion"]} is not supported (expected 1).`)
      : corrupt("missing schemaVersion");
  }
  const nextSequence = raw["nextSequence"];
  if (typeof nextSequence !== "number" || !Number.isInteger(nextSequence) || nextSequence < 1) throw corrupt("nextSequence invalid");
  const trades = raw["trades"];
  if (!isObj(trades)) throw corrupt("trades is not an object");
  const events = raw["events"];
  if (!Array.isArray(events)) throw corrupt("events is not an array");

  for (const [id, t] of Object.entries(trades)) {
    if (!isObj(t) || t["tradeId"] !== id || t["schemaVersion"] !== 1) throw corrupt(`trade ${id} is malformed`);
    if (!(PAPER_LIFECYCLE_STATES as readonly unknown[]).includes(t["state"])) throw corrupt(`trade ${id} has an unknown state`);
  }
  let last = 0;
  for (const e of events) {
    if (!isObj(e) || typeof e["sequence"] !== "number" || !Number.isInteger(e["sequence"]) || e["sequence"] <= last) throw corrupt("event sequence is not strictly increasing");
    last = e["sequence"];
    if (e["tradeId"] !== null && (typeof e["tradeId"] !== "string" || !Object.hasOwn(trades, e["tradeId"]))) throw corrupt(`event ${e["sequence"]} refers to an unknown trade`);
  }
  if (last >= nextSequence) throw corrupt("nextSequence is not ahead of the last event");
  return raw as unknown as JournalStateData;
}

const frozenCopy = <T>(v: T): T => deepFreeze(cloneJson(v));

/**
 * The journal rules, with no I/O. Both the in-memory repository and the file repository run on this class, so
 * they behave identically. Everything returned is a deep-frozen copy, so callers cannot change stored records.
 */
export class JournalState {
  private data: JournalStateData;

  constructor(data: JournalStateData = emptyJournalState()) {
    this.data = data;
  }

  /** Own-property lookup only: ids come from URLs, so "constructor" or "__proto__" must never match inherited members. */
  private find(tradeId: string): PaperTradeRecord | undefined {
    return Object.hasOwn(this.data.trades, tradeId) ? this.data.trades[tradeId] : undefined;
  }

  /** A deep copy of the plain data (for persistence or for a trial mutation). */
  toData(): JournalStateData {
    return cloneJson(this.data);
  }

  private append(event: NewJournalEvent): JournalEventRecord {
    const record: JournalEventRecord = {
      sequence: this.data.nextSequence,
      timestamp: event.timestamp,
      type: event.type,
      tradeId: event.tradeId,
      fromState: event.fromState,
      toState: event.toState,
      payload: cloneJson(event.payload ?? {}),
    };
    this.data.nextSequence += 1;
    this.data.events.push(record);
    return record;
  }

  createTrade(trade: PaperTradeRecord, event: NewJournalEvent): PaperTradeRecord {
    if (this.find(trade.tradeId) !== undefined) throw new JournalRepositoryError("TRADE_EXISTS", `Trade ${trade.tradeId} already exists.`);
    if (!isAllowedTransition("CANDIDATE", trade.state)) {
      throw new JournalRepositoryError("INVALID_TRANSITION", `A new trade cannot start in state ${trade.state}.`);
    }
    if (trade.entry !== null) throw new JournalRepositoryError("INVALID_RECORD", "A new trade cannot already have an entry snapshot.");
    if (event.tradeId !== trade.tradeId) throw new JournalRepositoryError("INVALID_RECORD", "The creation event must refer to the new trade.");
    this.data.trades[trade.tradeId] = cloneJson(trade);
    this.append(event);
    return frozenCopy(trade);
  }

  getTrade(tradeId: string): PaperTradeRecord | null {
    const t = this.find(tradeId);
    return t === undefined ? null : frozenCopy(t);
  }

  updateLifecycle(tradeId: string, patch: LifecyclePatch, event: NewJournalEvent): PaperTradeRecord {
    const current = this.find(tradeId);
    if (current === undefined) throw new JournalRepositoryError("TRADE_NOT_FOUND", `Trade ${tradeId} does not exist.`);
    if (isTerminalState(current.state)) {
      throw new JournalRepositoryError("INVALID_TRANSITION", `Trade ${tradeId} is ${current.state}, which is final and cannot change.`);
    }
    if (patch.state !== undefined && patch.state !== current.state && !isAllowedTransition(current.state, patch.state)) {
      throw new JournalRepositoryError("INVALID_TRANSITION", `Transition ${current.state} -> ${patch.state} is not allowed.`);
    }
    if (patch.entry !== undefined) {
      if (current.entry !== null) throw new JournalRepositoryError("ENTRY_IMMUTABLE", "The entry snapshot is immutable once recorded.");
      if (patch.state !== "PAPER_OPEN") throw new JournalRepositoryError("INVALID_RECORD", "An entry snapshot may only be recorded together with the move to PAPER_OPEN.");
    }
    if (event.tradeId !== tradeId) throw new JournalRepositoryError("INVALID_RECORD", "The event must refer to the updated trade.");

    const next: PaperTradeRecord = { ...cloneJson(current), updatedAt: patch.updatedAt };
    if (patch.state !== undefined) next.state = patch.state;
    if (patch.entry !== undefined) next.entry = cloneJson(patch.entry);
    if (patch.exit !== undefined) next.exit = cloneJson(patch.exit);
    if (patch.realizedPnl !== undefined) next.realizedPnl = cloneJson(patch.realizedPnl);
    if (patch.currentRisk !== undefined) next.currentRisk = cloneJson(patch.currentRisk);
    if (patch.lastMonitor !== undefined) next.lastMonitor = cloneJson(patch.lastMonitor);
    if (patch.lastValidExit !== undefined) next.lastValidExit = cloneJson(patch.lastValidExit);
    this.data.trades[tradeId] = next;
    this.append(event);
    return frozenCopy(next);
  }

  appendEvent(event: NewJournalEvent): JournalEventRecord {
    if (event.tradeId !== null && this.find(event.tradeId) === undefined) {
      throw new JournalRepositoryError("TRADE_NOT_FOUND", `Trade ${event.tradeId} does not exist.`);
    }
    return frozenCopy(this.append(event));
  }

  listTrades(filter?: TradeListFilter): PaperTradeRecord[] {
    const states: readonly PaperLifecycleState[] | undefined = filter?.states;
    return Object.values(this.data.trades)
      .filter((t) => states === undefined || states.includes(t.state))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.tradeId < b.tradeId ? -1 : 1))
      .map((t) => frozenCopy(t));
  }

  listEvents(filter?: { tradeId?: string }): JournalEventRecord[] {
    const id = filter?.tradeId;
    return this.data.events.filter((e) => id === undefined || e.tradeId === id).map((e) => frozenCopy(e));
  }

  exportJournal(exportedAt: string): JournalExport {
    const trades = this.listTrades();
    const events = this.listEvents();
    return {
      exportVersion: 1,
      app: "nse-smart-trader-v2",
      exportedAt,
      durabilityNotice: JOURNAL_DURABILITY_NOTICE,
      counts: { trades: trades.length, events: events.length },
      trades: cloneJson(trades),
      events: cloneJson(events),
    };
  }
}
