import type {
  JournalEventRecord,
  JournalExport,
  LastValidExit,
  PaperEntrySnapshot,
  PaperExitRecord,
  PaperJournalEventType,
  PaperLifecycleState,
  PaperMonitorSnapshot,
  PaperPnl,
  PaperTradeRecord,
  RiskAssessmentRecord,
} from "../contracts/index.js";

// Phase 1B journal abstraction. The paper-trading domain depends ONLY on this interface, so the storage can be
// replaced (database, hosted store, ...) without touching the domain. The frozen Phase 1A JournalStore contract
// is unchanged and is not used by Phase 1B.

export type JournalRepositoryErrorCode =
  | "TRADE_EXISTS"
  | "TRADE_NOT_FOUND"
  | "INVALID_TRANSITION"
  | "ENTRY_IMMUTABLE"
  | "INVALID_RECORD"
  | "STORAGE_CORRUPT"
  | "STORAGE_VERSION_UNSUPPORTED"
  | "STORAGE_IO";

export class JournalRepositoryError extends Error {
  constructor(
    readonly code: JournalRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "JournalRepositoryError";
  }
}

export interface NewJournalEvent {
  timestamp: string;
  type: PaperJournalEventType;
  tradeId: string | null;
  fromState: PaperLifecycleState | null;
  toState: PaperLifecycleState | null;
  payload?: Record<string, unknown>;
}

/**
 * The only fields a lifecycle update may change. The candidate, the review, the trade id, the creation time
 * and (once set) the entry snapshot are deliberately NOT here: they cannot be changed.
 */
export interface LifecyclePatch {
  updatedAt: string;
  state?: PaperLifecycleState;
  /** May be set exactly once, together with the move to PAPER_OPEN. */
  entry?: PaperEntrySnapshot;
  exit?: PaperExitRecord;
  realizedPnl?: PaperPnl;
  currentRisk?: RiskAssessmentRecord;
  lastMonitor?: PaperMonitorSnapshot;
  lastValidExit?: LastValidExit;
}

export interface TradeListFilter {
  states?: readonly PaperLifecycleState[];
}

export interface JournalRepository {
  /** Stores a new trade (state PAPER_REVIEW or DATA_INSUFFICIENT) and its first event atomically. */
  createTrade(trade: PaperTradeRecord, event: NewJournalEvent): Promise<PaperTradeRecord>;
  getTrade(tradeId: string): Promise<PaperTradeRecord | null>;
  /** Applies a lifecycle update and appends its event atomically. Illegal transitions and entry changes are rejected. */
  updateLifecycle(tradeId: string, patch: LifecyclePatch, event: NewJournalEvent): Promise<PaperTradeRecord>;
  /** Appends an event that does not change the trade (for example a rejected exit attempt). */
  appendEvent(event: NewJournalEvent): Promise<JournalEventRecord>;
  listTrades(filter?: TradeListFilter): Promise<PaperTradeRecord[]>;
  listEvents(filter?: { tradeId?: string }): Promise<JournalEventRecord[]>;
  /** Everything, as plain JSON, for backup. */
  exportJournal(): Promise<JournalExport>;
}
