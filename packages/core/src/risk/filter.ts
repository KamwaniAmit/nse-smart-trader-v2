import type { RiskFilter, RiskResult } from "../contracts/index.js";

/**
 * Selects which items to show. It never reorders, rescales or modifies anything, so Score and
 * Expected Net Edge are untouched. ALL keeps everything (including unknown risk); LOW/MEDIUM/HIGH
 * keep only that exact level. An item with unknown (null) risk is never shown under LOW/MEDIUM/HIGH.
 */
export function filterByRisk<T extends { readonly risk: RiskResult }>(items: readonly T[], filter: RiskFilter): T[] {
  if (filter === "ALL") return [...items];
  return items.filter((item) => item.risk.riskLevel === filter);
}
