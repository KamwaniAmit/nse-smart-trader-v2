import type { PaperPnl } from "@nsest/core/contracts";

export const inr = (n: number | null | undefined): string => (n === null || n === undefined ? "n/a" : `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const num = (n: number | null | undefined): string => (n === null || n === undefined ? "n/a" : String(n));

/** P&L as text. An unavailable P&L is stated as DATA_INSUFFICIENT with its reason, never shown as zero. */
export function pnlText(p: PaperPnl | null | undefined): string {
  if (!p) return "n/a";
  if (p.status === "DATA_INSUFFICIENT") return `Unavailable (DATA_INSUFFICIENT): ${p.reason ?? "no valid executable price"}`;
  const net = p.netStatus === "VALID" ? `net ${inr(p.netPnl)}` : "net unavailable (costs not provided)";
  return `gross ${inr(p.grossPnl)}, ${net}`;
}
