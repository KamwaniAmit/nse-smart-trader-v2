// Phase 1B.1 (D1, D3): time rules. Client timestamps are UNTRUSTED input; the server clock (injected as `now`) is the
// only trusted time. See docs/PAPER_TRADING.md "Time and freshness".

export const TIME_RULES = {
  /** D1 (approved): a quote older than this at confirmation is stale. Owner decision, 60 seconds. */
  maxQuoteAgeMs: 60_000,
  /**
   * Phase 1B.2 (A1, approved): how far a client time may be AHEAD of the server clock. This is a CLIENT-CLOCK tolerance,
   * not exchange-time verification. A time up to this far ahead is accepted; anything later is rejected as future-dated.
   * (Phase 1B.1 used a 5 000 ms default.)
   */
  maxFutureSkewMs: 30_000,
  /**
   * Phase 1B.2 (A2, approved): the maximum time since MANUAL ENTRY for monitor, exit and holding-limit prices. A price
   * entered up to this long before the server processes it is accepted; older is refused. It measures when the user typed
   * the price, never how fresh the market was.
   */
  maxManualPriceAgeMs: 60_000,
} as const;

/**
 * Phase 1B.2: checks one price's user-entry time against the server clock. Returns null when acceptable, otherwise the
 * problem. Boundaries are inclusive: exactly maxAgeMs old, or exactly maxFutureSkewMs ahead, is accepted.
 */
export function checkEntryTime(asOf: string | undefined, nowMs: number, maxAgeMs: number, what: string): { ms: number; problem: null } | { ms: null; problem: string } {
  if (asOf === undefined) return { ms: null, problem: `${what} has no time (asOf); its freshness cannot be checked` };
  const ms = parseStrictTimestamp(asOf);
  if (ms === null) return { ms: null, problem: `${what} time "${asOf}" must be a full timestamp with a zone` };
  if (ms > nowMs + TIME_RULES.maxFutureSkewMs) return { ms: null, problem: `${what} time ${asOf} is in the future (server time ${new Date(nowMs).toISOString()}, allowed client-clock tolerance ${TIME_RULES.maxFutureSkewMs / 1000} s)` };
  if (nowMs - ms > maxAgeMs) return { ms: null, problem: `${what} is older than ${maxAgeMs / 1000} s (time ${asOf}, age ${Math.round((nowMs - ms) / 1000)} s)` };
  return { ms, problem: null };
}

/**
 * A full timestamp with an explicit zone: YYYY-MM-DDTHH:MM[:SS[.fff]] followed by Z or +HH:MM / -HH:MM.
 * A bare date, or a time with no zone, is ambiguous and is rejected (it is never assumed to be UTC or IST).
 */
const STRICT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Epoch milliseconds of a strict timestamp, or null if it is missing, malformed, ambiguous or impossible. */
export function parseStrictTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = STRICT.exec(value);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s] = m;
  const year = Number(y), month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi), second = Number(s ?? "0");
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  // Reject impossible calendar dates (Feb 30, Sep 31) rather than letting Date roll them over.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export const isStrictTimestamp = (value: unknown): value is string => parseStrictTimestamp(value) !== null;

/**
 * Checks a client-supplied EVENT time (monitor, exit, safety check) against the trusted server clock.
 * Returns the problems found; an empty list means the time is acceptable.
 *   - it must be a strict timestamp;
 *   - it must not be later than server time + maxFutureSkewMs;
 *   - it must not be earlier than `notBefore` (the entry snapshot / the trade's last recorded update).
 */
export function checkEventTime(asOf: string, ctx: { nowMs: number; notBefore: string; notBeforeLabel: string }): string[] {
  const ms = parseStrictTimestamp(asOf);
  if (ms === null) return [`asOf "${asOf}" must be a full timestamp with a zone, e.g. 2026-10-01T10:00:00+05:30`];
  const problems: string[] = [];
  if (ms > ctx.nowMs + TIME_RULES.maxFutureSkewMs) {
    problems.push(`asOf ${asOf} is in the future (server time ${new Date(ctx.nowMs).toISOString()}, allowed client-clock tolerance ${TIME_RULES.maxFutureSkewMs / 1000} s)`);
  }
  const floor = Date.parse(ctx.notBefore);
  if (!Number.isNaN(floor) && ms < floor) problems.push(`asOf ${asOf} is before ${ctx.notBeforeLabel} (${ctx.notBefore})`);
  return problems;
}
