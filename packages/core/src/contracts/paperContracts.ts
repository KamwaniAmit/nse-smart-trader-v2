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

export interface ConfirmRequestDTO {
  confirmed: boolean;
}
export interface MonitorRequestDTO {
  asOf?: string;
  quotes: LegQuoteDTO[];
  tradingDaysToExpiry?: number | null;
  spot?: number | null;
  exitCosts?: number | null;
}
export interface ExitRequestDTO {
  asOf?: string;
  quotes: LegQuoteDTO[];
  exitCosts?: number | null;
}
export interface SafetyCheckRequestDTO {
  asOf: string;
  completedSessions?: number | null;
  quotes?: LegQuoteDTO[];
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
}

/** Recorded once, at confirmation. Frozen in memory and never changed afterwards. */
export interface PaperEntrySnapshot {
  readonly snapshotVersion: 1;
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
}

export type ExitBasis = "CURRENT_QUOTE" | "LAST_VALID_MONITOR_BID" | "NONE";
export type ExitTrigger = "USER_EXIT" | "EXPIRY" | "HOLDING_LIMIT";

export interface PaperExitRecord {
  timestamp: string;
  trigger: ExitTrigger;
  basis: ExitBasis;
  priceAsOf: string | null;
  legBids: Array<{ instrument: InstrumentRefDTO; bid: number | null }>;
  exitPremium: number | null;
  exitCosts: number | null;
  notes: string[];
}

export interface PaperMonitorSnapshot {
  asOf: string;
  legs: Array<{ instrument: InstrumentRefDTO; bid: number | null; ask: number | null; bidValid: boolean }>;
  dataStatus: "VALID" | "DATA_INSUFFICIENT";
  dataReasons: string[];
  currentExitPremium: number | null;
  unrealized: PaperPnl;
  currentRisk: RiskAssessmentRecord;
  carriedFromEntry: string[];
}

export interface LastValidExit {
  asOf: string;
  legBids: Array<{ instrument: InstrumentRefDTO; bid: number }>;
  exitPremium: number;
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
  trade: PaperTradeRecord;
}

export type PaperErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "INVALID_TRANSITION"
  | "CONFIRMATION_REQUIRED"
  | "DATA_INSUFFICIENT"
  | "CAPITAL_GATE_FAILED"
  | "LOTS_UNRESOLVED"
  | "STORAGE_ERROR";

export interface ApiErrorBody {
  error: PaperErrorCode | "NOT_FOUND" | "INTERNAL_ERROR";
  message: string;
  details?: string[];
  trade?: PaperTradeRecord;
}
