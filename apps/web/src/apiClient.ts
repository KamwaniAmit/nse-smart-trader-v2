import type { HealthResponse, MarketsResponse } from "@nsest/core/contracts";

// The ONLY network access in the web app: this project's own /api endpoints.
const BASE: string = import.meta.env.VITE_API_BASE_URL ?? "";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw new Error(`Request failed (HTTP ${response.status})`);
  return (await response.json()) as T;
}

export const getHealth = (): Promise<HealthResponse> => getJson<HealthResponse>("/api/health");
export const getMarkets = (): Promise<MarketsResponse> => getJson<MarketsResponse>("/api/markets");
