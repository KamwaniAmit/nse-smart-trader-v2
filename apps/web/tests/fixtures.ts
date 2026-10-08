import { vi } from "vitest";
import type { AssessResponseDTO, PaperLifecycleState, PaperTradeRecord, RiskAssessmentRecord, RiskLevel } from "@nsest/core/contracts";

export const CE = { provider: "manual", id: "NIFTY|2026-10-06|CE|22900" };
export const PE = { provider: "manual", id: "NIFTY|2026-10-06|PE|22800" };

export const risk = (level: RiskLevel | null): RiskAssessmentRecord => ({
  result: {
    riskLevel: level,
    riskScore: level === null ? null : 4,
    riskReasons: level === null ? [] : [`bidAskSpreadQuality = 1.2836 -> ${level}`],
    riskWarnings: level === null ? ["Required risk input(s) unavailable: capitalUtilization. Risk is not guessed."] : [],
    riskDataStatus: level === null ? "INSUFFICIENT" : "COMPLETE",
  },
  rulesVersion: "1.0.0",
  inputs: {},
  assessedAt: "2026-09-28T10:00:00Z",
});

const quote = (bid: number, ask: number) => ({ bid, ask, ltp: null, bidQty: 6500, askQty: 6500, volume: 6000, oi: 12000 });

export function makeTrade(state: PaperLifecycleState, over: Partial<PaperTradeRecord> = {}): PaperTradeRecord {
  const open = state !== "PAPER_REVIEW" && state !== "DATA_INSUFFICIENT";
  const review = {
    entryStatus: state === "DATA_INSUFFICIENT" ? ("DATA_INSUFFICIENT" as const) : ("EXECUTABLE" as const),
    entryReasons: state === "DATA_INSUFFICIENT" ? ["CE 22900: INVALID_ASK"] : [],
    combinedEntryPremium: state === "DATA_INSUFFICIENT" ? null : 120.75,
    spreadPct: 1.2836,
    capital: { premiumRequirement: 7848.75, entryCosts: 250, totalCapitalRequirement: 8098.75, maxCapitalAllocation: 100000, numberOfLots: 12, requestedLots: 1, lots: 1, utilizationPct: 8.0988, gate: "PASS" as const, reasons: [] },
    risk: risk(state === "DATA_INSUFFICIENT" ? null : "LOW"),
    reviewedAt: "2026-09-28T10:00:00Z",
  };
  return {
    schemaVersion: 1,
    tradeId: `pt_${state.toLowerCase()}`,
    source: "LONG_VOL",
    state,
    createdAt: "2026-09-28T10:00:00Z",
    updatedAt: "2026-09-28T10:00:00Z",
    candidate: {
      candidateId: "cand_1", source: "LONG_VOL", marketId: "NIFTY", structure: "STRANGLE", expiry: "2026-10-06", lotSize: 65, dataSource: "MANUAL", asOf: "2026-09-28T10:00:00Z",
      legs: [
        { optionType: "CE", strike: 22900, instrument: CE, quote: quote(69, 69.8) },
        { optionType: "PE", strike: 22800, instrument: PE, quote: quote(50.2, 50.95) },
      ],
      spot: 22831.15, score: 62, expectedMove: 230, impliedMove: 180, expectedNetEdge: 700, iv: 0.15, rv20: 0.12, rvRegime: "RV_ACCELERATING",
      tradingDaysToExpiry: 8, maxCapitalAllocation: 100000, entryCosts: 250, requestedLots: 1,
    },
    review,
    entry: open
      ? {
          snapshotVersion: 1, capturedAt: "2026-09-28T10:01:00Z", candidateId: "cand_1", source: "LONG_VOL", marketId: "NIFTY", structure: "STRANGLE", expiry: "2026-10-06", dataSource: "MANUAL",
          legs: [
            { optionType: "CE", strike: 22900, instrument: CE, entryAsk: 69.8, entryBid: 69 },
            { optionType: "PE", strike: 22800, instrument: PE, entryAsk: 50.95, entryBid: 50.2 },
          ],
          combinedEntryPremium: 120.75, lotSize: 65, lots: 1, spot: 22831.15, expectedMove: 230, impliedMove: 180, expectedNetEdge: 700, score: 62,
          risk: risk("LOW"), capital: review.capital, capitalRequirement: 8098.75, dataCompleteness: { complete: true, missing: [] },
        }
      : null,
    exit: null,
    realizedPnl: null,
    currentRisk: state === "PAPER_OPEN" ? risk("HIGH") : null,
    lastMonitor: null,
    lastValidExit: null,
    rejectionReasons: state === "DATA_INSUFFICIENT" ? ["CE 22900: INVALID_ASK"] : [],
    ...over,
  };
}

export const assessed = (level: RiskLevel | null, state: "CANDIDATE" | "DATA_INSUFFICIENT" = "CANDIDATE"): AssessResponseDTO => {
  const t = makeTrade(state === "CANDIDATE" ? "PAPER_REVIEW" : "DATA_INSUFFICIENT");
  return { state, candidate: t.candidate, review: { ...t.review, risk: risk(level) } };
};

export interface Call { method: string; path: string; body: unknown }
type Reply = { status?: number; body: unknown };
type Handler = (body: unknown, path: string) => Reply;

/** Stubs this project's own /api only. Returns the list of calls made, so tests can prove what was (not) sent. */
export function stubApi(handlers: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path, body });
      const handler = handlers[`${method} ${path}`] ?? handlers[`${method} ${path.split("?")[0] ?? path}`];
      if (!handler) return new Response(JSON.stringify({ error: "NOT_FOUND", message: "no stub" }), { status: 404 });
      const reply = handler(body, path);
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
    }),
  );
  return calls;
}
