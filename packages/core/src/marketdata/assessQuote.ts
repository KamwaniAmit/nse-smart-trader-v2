export type QuoteRejectionReason = "INVALID_BID" | "INVALID_ASK" | "CROSSED_MARKET";

export type QuoteAssessment =
  | { readonly executable: true }
  | { readonly executable: false; readonly reason: QuoteRejectionReason };

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * A quote is executable only with a finite, positive bid AND ask, and ask >= bid.
 * LTP is deliberately not an input: it is never substituted for a missing bid/ask.
 */
export function assessQuote(quote: { bid: number | null; ask: number | null }): QuoteAssessment {
  if (!isPositiveFinite(quote.bid)) return { executable: false, reason: "INVALID_BID" };
  if (!isPositiveFinite(quote.ask)) return { executable: false, reason: "INVALID_ASK" };
  if (quote.ask < quote.bid) return { executable: false, reason: "CROSSED_MARKET" };
  return { executable: true };
}
