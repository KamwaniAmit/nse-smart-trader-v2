import type {
  ApiErrorBody,
  AssessResponseDTO,
  CandidateInputDTO,
  ConfirmRequestDTO,
  ExitRequestDTO,
  HealthResponse,
  JournalEventRecord,
  MarketsResponse,
  MonitorRequestDTO,
  PaperLifecycleState,
  PaperTradeRecord,
  RiskFilter,
  SafetyCheckRequestDTO,
  SafetyCheckResponseDTO,
} from "@nsest/core/contracts";

// The ONLY network access in the web app: this project's own /api endpoints.
const BASE: string = import.meta.env.VITE_API_BASE_URL ?? "";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw new Error(`Request failed (HTTP ${response.status})`);
  return (await response.json()) as T;
}

/** A failed paper-trading request, carrying the server's explanation (and the trade, when it returned one). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = "ApiError";
  }
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // no JSON body
  }
  if (!response.ok) {
    const known = body as Partial<ApiErrorBody> | null;
    throw new ApiError(response.status, { error: known?.error ?? "INTERNAL_ERROR", message: known?.message ?? `Request failed (HTTP ${response.status})`, ...(known?.details ? { details: known.details } : {}), ...(known?.trade ? { trade: known.trade } : {}) });
  }
  return body as T;
}

export const getHealth = (): Promise<HealthResponse> => getJson<HealthResponse>("/api/health");
export const getMarkets = (): Promise<MarketsResponse> => getJson<MarketsResponse>("/api/markets");

// ---- Phase 1B: paper trading ------------------------------------------------
export const assessCandidate = (input: CandidateInputDTO): Promise<AssessResponseDTO> => postJson("/api/paper/assess", input);
export const reviewCandidate = (input: CandidateInputDTO): Promise<PaperTradeRecord> => postJson("/api/paper/review", input);
export const confirmTrade = (id: string, req: ConfirmRequestDTO): Promise<PaperTradeRecord> => postJson(`/api/paper/trades/${encodeURIComponent(id)}/confirm`, req);
export const monitorTrade = (id: string, req: MonitorRequestDTO): Promise<PaperTradeRecord> => postJson(`/api/paper/trades/${encodeURIComponent(id)}/monitor`, req);
export const exitTrade = (id: string, req: ExitRequestDTO): Promise<PaperTradeRecord> => postJson(`/api/paper/trades/${encodeURIComponent(id)}/exit`, req);
export const safetyCheck = (id: string, req: SafetyCheckRequestDTO): Promise<SafetyCheckResponseDTO> => postJson(`/api/paper/trades/${encodeURIComponent(id)}/safety-check`, req);

export async function listTrades(options: { states?: readonly PaperLifecycleState[]; risk?: RiskFilter } = {}): Promise<PaperTradeRecord[]> {
  const q = new URLSearchParams();
  if (options.states && options.states.length > 0) q.set("state", options.states.join(","));
  if (options.risk) q.set("risk", options.risk);
  const suffix = q.toString() === "" ? "" : `?${q.toString()}`;
  return (await getJson<{ trades: PaperTradeRecord[] }>(`/api/paper/trades${suffix}`)).trades;
}
export const getTrade = (id: string): Promise<{ trade: PaperTradeRecord; events: JournalEventRecord[] }> => getJson(`/api/paper/trades/${encodeURIComponent(id)}`);
export async function listJournal(): Promise<JournalEventRecord[]> {
  return (await getJson<{ events: JournalEventRecord[] }>("/api/paper/journal")).events;
}
/** Plain link target for the JSON backup download. */
export const exportUrl = (): string => `${BASE}/api/paper/export`;
