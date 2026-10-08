// Journal contract. Storage technology is an open decision (docs/DECISIONS.md),
// so Phase 1A defines the interface only. V2 never reads legacy browser storage.

export type JournalEventType =
  | "OBSERVATION_RECORDED"
  | "TRADE_SELECTED"
  | "TRADE_OPENED"
  | "MONITOR_SNAPSHOT"
  | "TRADE_CLOSED"
  | "TRADE_EXPIRED"
  | "TRADE_AUTO_CLOSED";

export interface JournalEntry {
  sequence: number;
  timestamp: string;
  type: JournalEventType;
  tradeId: string | null;
  payload: Readonly<Record<string, unknown>>;
}

/** Append-only by design: there is no update or delete. */
export interface JournalStore {
  append(entry: Omit<JournalEntry, "sequence">): Promise<JournalEntry>;
  listAll(): Promise<readonly JournalEntry[]>;
  listForTrade(tradeId: string): Promise<readonly JournalEntry[]>;
}
