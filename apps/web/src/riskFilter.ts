import type { RiskFilter, RiskLevel } from "@nsest/core/contracts";

/**
 * Which rows to SHOW for a risk filter (the web app cannot import core's logic, only contracts).
 * ALL keeps everything, including unknown risk. LOW/MEDIUM/HIGH keep exactly that level, and an unknown (null)
 * level is never shown under them. It only selects rows: it never reorders or changes anything.
 */
export const matchesRiskFilter = (level: RiskLevel | null, filter: RiskFilter): boolean => filter === "ALL" || level === filter;
