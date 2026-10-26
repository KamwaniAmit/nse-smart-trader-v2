import type { MarketId, RiskResult } from "./index.js";

// Phase 1B shared contracts: TYPES AND CONSTANTS ONLY (the web app may import these).
// They sit BESIDE the frozen Phase 1A paper/journal contracts, which are left unchanged.

// ---- Lifecycle --------------------------------------------------------------
export const PAPER_LIFECYCLE_STATES = [
  "CANDIDATE", // proposed by a scanner or typed in; NOT a position; never auto-advances
  "PAPER_REVIEW", // the user opened it for review; NOT a position
  "PAPER_OPEN", // the user explicitly confirmed; the entry snapshot is recorded
  "PAPER_EXITED", // the user exited with valid executable bids
  "PAPER_EXPIRED", // the contract expired
  "PAPER_AUTO_CLOSED", // closed by a safety rule
  "DATA_INSUFFICIENT", // could not be priced from executable quotes; terminal
] as const;
export type PaperLifecycleState = (typeof PAPER_LIFECYCLE_STATES)[number];

export const PAPER_TERMINAL_STATES = ["PAPER_EXITED", "PAPER_EXPIRED", "PAPER_AUTO_CLOSED", "DATA_INSUFFICIENT"] as const;

export const PAPER_SOURCES = ["LONG_VOL", "BEST_OPPORTUNITY"] as const;
export type PaperSource = (typeof PAPER_SOURCES)[number];

export const PAPER_STRUCTURES = ["STRADDLE", "STRANGLE", "SINGLE_CALL", "SINGLE_PUT"] as const;
export type PaperStructure = (typeof PAPER_STRUCTURES)[number];

/** MANUAL = typed in by the user. It is never presented as live market data. */
export type PaperDataSource = "MANUAL" | "BROKER";

// ---- Inputs (what a client sends) ------------------------------------------
export interface InstrumentRefDTO {
  provider: string;
  id: string;
}

export interface QuoteInputDTO {
  bid: number | null;
  ask: number | null;
  ltp?: number | null;
  bidQty?: number | null;
  askQty?: number | null;
  volume?: number | null;
  oi?: number | null;
}

export interface LegInputDTO {
  optionType: "CE" | "PE";
  strike: number;
  instrument?: InstrumentRefDTO;
  quote: QuoteInputDTO;
}

export interface CandidateInputDTO {
  candidateId?: string;
  source: PaperSource;
  marketId: MarketId;
  structure: PaperStructure;
  expiry: string;
  lotSize: number;
  legs: LegInputDTO[];
  asOf?: string;
  dataSource?: PaperDataSource;
  spot?: number | null;
  score?: number | null;
  expectedMove?: number | null;
  impliedMove?: number | null;
  expectedNetEdge?: number | null;
  iv?: number | null;
  rv20?: number | null;
  rvRegime?: string | null;
  tradingDaysToExpiry?: number | null;
  maxCapitalAllocation?: number | null;
  entryCosts?: number | null;
  requestedLots?: number | null;
}

/** An executable quote for ONE exact instrument. Matched by exact identity, never by strike or expiry. */
export interface LegQuoteDTO {
  instrument: InstrumentRefDTO;
  bid: number | null;
  ask?: number | null;
  ltp?: number | null;
  bidQty?: number | null;
  askQty?: number | null;
  volume?: number | null;
  oi?: number | null;
}

/**
 * Phase 1B.1 (D1): an entry quote also carries the time it was observed. The server checks that time against its own
 * clock; it is never trusted on its own. For MANUAL data it is the time the user entered the prices.
 */
export interface EntryQuoteDTO extends LegQuoteDTO {
  asOf?: string;
}

export interface ConfirmRequestDTO {
  confirmed: boolean;
  /** Fresh executable quotes for EVERY leg (exact instruments). Required when confirmed is true (Phase 1B.1, D1). */
  quotes?: EntryQuoteDTO[];
}
// Phase 1B.2 (A2): monitor, exit and safety prices are typed by the user, so each quote also carries its own
// MANUAL-ENTRY time (asOf, the moment the price was typed). The server checks it against its clock; it is never treated
// as an exchange timestamp.
export interface MonitorRequestDTO {
  asOf?: string;
  quotes: EntryQuoteDTO[];
  tradingDaysToExpiry?: number | null;
  spot?: number | null;
  exitCosts?: number | null;
}
export interface ExitRequestDTO {
  asOf?: string;
  quotes: EntryQuoteDTO[];
  exitCosts?: number | null;
}
export interface SafetyCheckRequestDTO {
  /** Optional and untrusted (Phase 1B.1, D3): validated and recorded, but expiry and safety are decided on SERVER time. */
  asOf?: string;
  completedSessions?: number | null;
  quotes?: EntryQuoteDTO[];
  exitCosts?: number | null;
}

// ---- Stored / returned records ---------------------------------------------
export interface PaperQuote {
  bid: number | null;
  ask: number | null;
  ltp: number | null;
  bidQty: number | null;
  askQty: number | null;
  volume: number | null;
  oi: number | null;
}

export interface PaperLeg {
  optionType: "CE" | "PE";
  strike: number;
  instrument: InstrumentRefDTO;
  quote: PaperQuote;
}

export interface PaperCandidate {
  candidateId: string;
  source: PaperSource;
  marketId: MarketId;
  structure: PaperStructure;
  expiry: string;
  lotSize: number;
  dataSource: PaperDataSource;
  asOf: string;
  legs: PaperLeg[];
  spot: number | null;
  score: number | null;
  expectedMove: number | null;
  impliedMove: number | null;
  expectedNetEdge: number | null;
  iv: number | null;
  rv20: number | null;
  rvRegime: string | null;
  tradingDaysToExpiry: number | null;
  maxCapitalAllocation: number | null;
  entryCosts: number | null;
  requestedLots: number | null;
}

export interface CapitalAssessment {
  premiumRequirement: number | null;
  entryCosts: number | null;
  totalCapitalRequirement: number | null;
  maxCapitalAllocation: number | null;
  numberOfLots: number | null;
  requestedLots: number | null;
  lots: number | null;
  utilizationPct: number | null;
  gate: "PASS" | "FAIL" | "NOT_EVALUATED";
  reasons: string[];
}

export interface PaperPnl {
  status: "VALID" | "DATA_INSUFFICIENT";
  reason: string | null;
  grossPnl: number | null;
  netPnl: number | null;
  netStatus: "VALID" | "COSTS_UNAVAILABLE" | "DATA_INSUFFICIENT";
}

export interface RiskAssessmentRecord {
  result: RiskResult;
  rulesVersion: string;
  inputs: Record<string, number | string | boolean | null>;
  assessedAt: string;
}

export interface PaperReview {
  entryStatus: "EXECUTABLE" | "DATA_INSUFFICIENT";
  entryReasons: string[];
  combinedEntryPremium: number | null;
  spreadPct: number | null;
  capital: CapitalAssessment;
  risk: RiskAssessmentRecord;
  reviewedAt: string;
}

export interface PaperEntryLeg {
  readonly optionType: "CE" | "PE";
  readonly strike: number;
  readonly instrument: InstrumentRefDTO;
  readonly entryAsk: number;
  readonly entryBid: number | null;
  /** Phase 1B.1 (D1): when this leg's entry quote was observed, and how old it was at confirmation. Absent on v1 snapshots. */
  readonly quoteAsOf?: string;
  readonly quoteAgeMs?: number;
}

/** Recorded once, at confirmation. Frozen in memory and never changed afterwards. */
export interface PaperEntrySnapshot {
  /** 1 = Phase 1B (priced from review-time quotes). 2 = Phase 1B.1 (priced from fresh, time-checked quotes). */
  readonly snapshotVersion: 1 | 2;
  readonly capturedAt: string;
  readonly candidateId: string;
  readonly source: PaperSource;
  readonly marketId: MarketId;
  readonly structure: PaperStructure;
  readonly expiry: string;
  readonly dataSource: PaperDataSource;
  readonly legs: readonly PaperEntryLeg[];
  readonly combinedEntryPremium: number;
  readonly lotSize: number;
  readonly lots: number;
  readonly spot: number | null;
  readonly expectedMove: number | null;
  readonly impliedMove: number | null;
  readonly expectedNetEdge: number | null;
  readonly score: number | null;
  readonly risk: RiskAssessmentRecord;
  readonly capital: CapitalAssessment;
  readonly capitalRequirement: number | null;
  readonly dataCompleteness: { readonly complete: boolean; readonly missing: readonly string[] };
  /** Phase 1B.1 (D1): the freshness rule applied at confirmation. Absent on v1 snapshots. */
  readonly quoteFreshness?: { readonly maxQuoteAgeMs: number; readonly maxFutureSkewMs: number; readonly evaluatedAt: string };
  /** Phase 1B.1 (D1): when the candidate (spot, moves, edge, score) was supplied. These are NOT re-priced at confirmation. */
  readonly candidateAsOf?: string;
}

/**
 * "LAST_VALID_MONITOR_BID" exists only in records written by Phase 1B (1d21f06). Since Phase 1B.1 (D2) it is never
 * produced: an old bid is not an executable exit price. It stays in the type so older journals still load.
 *
 * "CURRENT_QUOTE" is a LEGACY basis label, kept unchanged so the journal and export schema do not change. It only says
 * the exit was valued from prices supplied in the same request. For Phase 1B.2 records the actual valuation method is
 * identified by `valuationStatus: "MANUAL_ENTRY_CHECKED"` together with `priceProvenance: "MANUAL_USER_ENTRY"`:
 * prices typed by the user that passed the manual-input checks - never exchange-sourced or exchange-verified.
 */
export type ExitBasis = "CURRENT_QUOTE" | "LAST_VALID_MONITOR_BID" | "NONE";
/**
 * How the exit was valued.
 *  - MANUAL_ENTRY_CHECKED (Phase 1B.2, A9): valued from prices the user typed, and the application's manual-input
 *    validation rules passed (bid and ask valid, not crossed, entered within the approved time limit, exact legs, no
 *    conflicting duplicates). It does NOT mean exchange-sourced, exchange-timestamped or independently verified.
 *  - EXECUTABLE_QUOTE: written by Phase 1B.1 only (bid checked, ask and price age not checked). Never written since 1B.2.
 *  - DATA_INSUFFICIENT: no valuation; P&L is DATA_INSUFFICIENT.
 */
export type ExitValuationStatus = "MANUAL_ENTRY_CHECKED" | "EXECUTABLE_QUOTE" | "DATA_INSUFFICIENT";
/** Where the prices behind a valuation came from (Phase 1B.2). There is no exchange source in this application. */
export type PriceProvenance = "MANUAL_USER_ENTRY" | "NONE";
/** The rule values applied when a manual valuation was checked (Phase 1B.2), recorded with the valuation. */
export interface ValuationRuleRecord {
  maxManualPriceAgeMs: number;
  maxFutureSkewMs: number;
  /** The contract's provisional paper-safety cutoff (15:30 Asia/Kolkata on the expiry date). */
  expiryCutoff: string;
  /** Server time at which the check was made. */
  evaluatedAt: string;
}
/** One leg's exit price. ask / enteredAt / entryAgeMs exist only on records written since Phase 1B.2. */
export interface ExitLegPrice {
  instrument: InstrumentRefDTO;
  bid: number | null;
  ask?: number | null;
  /** When the user TYPED this leg's prices (user-entry time, not an exchange time). */
  enteredAt?: string;
  /** Server time minus enteredAt, in ms, when the price was checked. */
  entryAgeMs?: number;
}
export type ExitTrigger = "USER_EXIT" | "EXPIRY" | "HOLDING_LIMIT";

export interface PaperExitRecord {
  /** Server processing time of the exit / closure event (authoritative). Not a quote-observation time. */
  timestamp: string;
  trigger: ExitTrigger;
  basis: ExitBasis;
  /**
   * When the exit quote was OBSERVED, if a trustworthy observation time exists. Review correction R4: monitor, exit and
   * safety quotes carry no observation time, so new records store null ("unavailable"); the server processing time is in
   * `timestamp`. Records written before R4 may hold a server or client time here; it is not a verified observation time.
   */
  priceAsOf: string | null;
  legBids: ExitLegPrice[];
  exitPremium: number | null;
  exitCosts: number | null;
  notes: string[];
  /** Phase 1B.1 (D2). Absent on records written by Phase 1B. */
  valuationStatus?: ExitValuationStatus;
  /** Phase 1B.1 (D2): the last valid monitored bids, kept for HISTORICAL REFERENCE ONLY. Never used for P&L. */
  staleReference?: LastValidExit | null;
  /** Review correction R2: the validated client-supplied asOf, as metadata only. `timestamp` is always server time. */
  clientAsOf?: string;
  /** Phase 1B.2: where the valuation prices came from. Absent on older records. */
  priceProvenance?: PriceProvenance;
  /** Phase 1B.2: the rule values applied to the manual prices. Absent on older records. */
  valuationRule?: ValuationRuleRecord;
  /** Phase 1B.2 (A5): a holding-limit closure's completed-session count was typed by the user (no trading calendar). */
  sessionsSource?: "USER_PROVIDED";
}

export interface PaperMonitorSnapshot {
  /** Server time this monitor update was recorded (processing time). Not a quote-observation time (R4). */
  asOf: string;
  legs: Array<{ instrument: InstrumentRefDTO; bid: number | null; ask: number | null; bidValid: boolean; enteredAt?: string; entryAgeMs?: number }>;
  dataStatus: "VALID" | "DATA_INSUFFICIENT";
  dataReasons: string[];
  currentExitPremium: number | null;
  unrealized: PaperPnl;
  currentRisk: RiskAssessmentRecord;
  carriedFromEntry: string[];
  /** Review correction R2: the validated client-supplied asOf, as metadata only. `asOf` is always server time. */
  clientAsOf?: string;
  /** Phase 1B.2: the prices were typed by the user. Absent on older records. */
  priceProvenance?: PriceProvenance;
  /** Phase 1B.2: the rule values applied to the manual prices. Absent on older records. */
  valuationRule?: ValuationRuleRecord;
}

export interface LastValidExit {
  /** Server time the monitor update holding these bids was recorded (processing time). Not a quote-observation time (R4). */
  asOf: string;
  legBids: Array<{ instrument: InstrumentRefDTO; bid: number; enteredAt?: string }>;
  exitPremium: number;
  /** Phase 1B.2: the prices were typed by the user. Absent on older records. */
  priceProvenance?: PriceProvenance;
}

export interface PaperTradeRecord {
  schemaVersion: 1;
  tradeId: string;
  source: PaperSource;
  state: PaperLifecycleState;
  createdAt: string;
  updatedAt: string;
  candidate: PaperCandidate;
  review: PaperReview;
  entry: PaperEntrySnapshot | null;
  exit: PaperExitRecord | null;
  realizedPnl: PaperPnl | null;
  currentRisk: RiskAssessmentRecord | null;
  lastMonitor: PaperMonitorSnapshot | null;
  lastValidExit: LastValidExit | null;
  rejectionReasons: string[];
}

// ---- Journal ----------------------------------------------------------------
export const PAPER_JOURNAL_EVENT_TYPES = [
  "REVIEW_STARTED",
  "REJECTED_DATA_INSUFFICIENT",
  "TRADE_OPENED",
  "MONITOR_SNAPSHOT",
  "EXIT_REJECTED_DATA_INSUFFICIENT",
  "CONFIRM_REJECTED_QUOTE",
  "CONFIRM_REJECTED_EXPIRED", // Phase 1B.2: confirmation refused at or after the contract's cutoff
  "EXIT_REJECTED_EXPIRED", // Phase 1B.2: exit refused at or after the contract's cutoff
  "EXIT_REJECTED_QUOTE", // Phase 1B.2: exit refused because a manual price's entry time failed the time rules
  "TRADE_EXITED",
  "TRADE_EXPIRED",
  "TRADE_AUTO_CLOSED",
] as const;
export type PaperJournalEventType = (typeof PAPER_JOURNAL_EVENT_TYPES)[number];

export interface JournalEventRecord {
  sequence: number;
  timestamp: string;
  type: PaperJournalEventType;
  tradeId: string | null;
  fromState: PaperLifecycleState | null;
  toState: PaperLifecycleState | null;
  payload: Record<string, unknown>;
}

export const JOURNAL_DURABILITY_NOTICE =
  "File-based journal: suitable for controlled development and paper-trading use. It is NOT guaranteed durable storage, and must not be relied on on serverless or ephemeral hosting. Keep exported copies.";

export interface JournalExport {
  exportVersion: 1;
  app: "nse-smart-trader-v2";
  exportedAt: string;
  durabilityNotice: string;
  counts: { trades: number; events: number };
  trades: PaperTradeRecord[];
  events: JournalEventRecord[];
}

// ---- API responses ----------------------------------------------------------
export interface AssessResponseDTO {
  state: "CANDIDATE" | "DATA_INSUFFICIENT";
  candidate: PaperCandidate;
  review: PaperReview;
}

export interface SafetyDecisionDTO {
  action: "NONE" | "EXPIRE" | "AUTO_CLOSE";
  reasons: string[];
  notEvaluated: string[];
}

export interface SafetyCheckResponseDTO {
  decision: SafetyDecisionDTO;
  trade: PaperTradeView;
}

// ---- Phase 1B.2: derived response data (computed when read; NEVER stored in the journal or the raw export) ----
/**
 * HISTORICAL_SNAPSHOT (final review): an open trade read at or after its contract's cutoff. Its unrealized P&L is a
 * snapshot recorded earlier; it is NOT a current, executable or exchange-verified valuation, and it is not realized P&L.
 */
export const PRICE_QUALITY_LEVELS = ["MANUAL_ENTRY_CHECKED", "UNVERIFIED_LEGACY", "SUPERSEDED_RULE", "NO_PRICE", "HISTORICAL_SNAPSHOT"] as const;
export type PriceQualityLevel = (typeof PRICE_QUALITY_LEVELS)[number];
export const PRICE_QUALITY_FLAGS = [
  "LEGACY_ENTRY_SNAPSHOT_V1",
  "UNREALIZED_FROM_UNCHECKED_MONITOR",
  "ASK_AND_PRICE_AGE_NOT_CHECKED",
  "UNVERIFIED_PRICE_TIME",
  "PRICED_FROM_EARLIER_MONITOR_BID",
  "EXPIRY_PRICED_FROM_TYPED_BIDS",
  "SESSION_COUNT_USER_PROVIDED",
  "ACTION_AFTER_EXPIRY_CUTOFF",
  "PROVENANCE_INCOMPLETE",
  "PROVENANCE_INCONSISTENT",
  // M1 (derived when read): an open trade's unrealized P&L is a snapshot from before the cutoff; read at or after it.
  "UNREALIZED_SNAPSHOT_AFTER_CUTOFF",
  // Final review (derived when read): an older record whose instruments do not verifiably identify its contract.
  "INSTRUMENT_IDENTITY_UNVERIFIED",
] as const;
export type PriceQualityFlag = (typeof PRICE_QUALITY_FLAGS)[number];
/**
 * The quality of the evidence behind a trade's shown P&L. MANUAL_ENTRY_CHECKED means the application's manual-input
 * validation rules passed; it never means exchange-sourced, exchange-timestamped or independently verified.
 */
export interface PriceQualityDTO {
  level: PriceQualityLevel;
  flags: PriceQualityFlag[];
  /** One plain-language warning per flag, in the same order. */
  warnings: string[];
  note: string;
}
export const EXPIRY_STATUSES = ["BEFORE_CUTOFF", "EXPIRED_REVIEW", "EXPIRED_PENDING_CLOSURE", "CLOSED"] as const;
export type ExpiryStatus = (typeof EXPIRY_STATUSES)[number];
/** Where a trade stands relative to its contract's provisional paper-safety cutoff, at the time of the response. */
/**
 * Final review: whether every leg's instrument identifies the contract in the structured fields (derived, never stored).
 *  - CONSISTENT: every leg's manual instrument matches market, expiry, option type and strike (always true for
 *    candidates accepted now).
 *  - MISMATCH: an older record whose readable instrument differs in market, expiry, option type or strike.
 *  - UNVERIFIABLE: an older record whose instrument cannot be read (opaque provider or malformed id).
 * A record that is not CONSISTENT is never confirmed, monitored, exited or priced; it can only be closed unpriced.
 */
export const INSTRUMENT_CHECKS = ["CONSISTENT", "MISMATCH", "UNVERIFIABLE"] as const;
export type InstrumentCheck = (typeof INSTRUMENT_CHECKS)[number];
export interface ExpiryStatusDTO {
  status: ExpiryStatus;
  /** 15:30 Asia/Kolkata on the expiry date used (expiryUsed), e.g. 2026-10-06T15:30:00+05:30. */
  cutoff: string;
  /** The expiry date the safety rules use: the candidate expiry, or an earlier instrument expiry on an older record. */
  expiryUsed: string;
  instrumentCheck: InstrumentCheck;
  /** Why the record is not CONSISTENT (empty when it is). */
  instrumentReasons: string[];
}
/** A trade as the API returns it: the stored record plus derived fields. The journal only ever stores the record. */
export type PaperTradeView = PaperTradeRecord & { priceQuality: PriceQualityDTO; expiryStatus: ExpiryStatusDTO };

export type PaperErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "INVALID_TRANSITION"
  | "CONFIRMATION_REQUIRED"
  | "DATA_INSUFFICIENT"
  | "CAPITAL_GATE_FAILED"
  | "LOTS_UNRESOLVED"
  | "QUOTE_NOT_FRESH"
  | "CONTRACT_EXPIRED" // Phase 1B.2: the action is not allowed at or after the contract's provisional cutoff
  | "STORAGE_ERROR";

export interface ApiErrorBody {
  error: PaperErrorCode | "NOT_FOUND" | "INTERNAL_ERROR";
  message: string;
  details?: string[];
  trade?: PaperTradeRecord;
}
