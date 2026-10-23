import { InMemoryJournalRepository, createPaperTradingService } from "../src/index.js";

// Fixture numbers are the legacy example you gave: entry CE Ask 69.8 + PE Ask 50.95 = 120.75, lot size 65,
// exit bids 66.05 + 54.00 = 120.05, so one lot is 1 x 65 x (120.05 - 120.75) = -45.50 gross.

export const CE_ID = { provider: "manual", id: "NIFTY|2026-10-06|CE|22900" };
export const PE_ID = { provider: "manual", id: "NIFTY|2026-10-06|PE|22800" };

const depth = { volume: 6000, oi: 12000, bidQty: 6500, askQty: 6500 };

/** A LONG VOL STRANGLE candidate as a client would send it. Override any field. */
export function longVolRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "LONG_VOL",
    marketId: "NIFTY",
    structure: "STRANGLE",
    expiry: "2026-10-06",
    lotSize: 65,
    asOf: "2026-09-28T10:00:00+05:30",
    legs: [
      { optionType: "CE", strike: 22900, quote: { bid: 69.0, ask: 69.8, ...depth } },
      { optionType: "PE", strike: 22800, quote: { bid: 50.2, ask: 50.95, ...depth } },
    ],
    spot: 22831.15,
    score: 62,
    expectedMove: 230,
    impliedMove: 180,
    expectedNetEdge: 700,
    iv: 0.15,
    rv20: 0.12,
    rvRegime: "RV_ACCELERATING",
    tradingDaysToExpiry: 8,
    maxCapitalAllocation: 100000,
    entryCosts: 250,
    requestedLots: 1,
    ...over,
  };
}

/** Exit quotes for the two legs of longVolRaw(). Default: CE bid 66.05, PE bid 54.00. */
export const exitQuotes = (ceBid: number | null = 66.05, peBid: number | null = 54.0, extra: Record<string, unknown> = {}) => ({
  quotes: [
    { instrument: CE_ID, bid: ceBid, ask: ceBid === null ? null : ceBid + 0.5, volume: 7000, oi: 12000, bidQty: 6500, askQty: 6500 },
    { instrument: PE_ID, bid: peBid, ask: peBid === null ? null : peBid + 0.5, volume: 7000, oi: 12000, bidQty: 6500, askQty: 6500 },
  ],
  ...extra,
});

/** The fixture clock starts here. Each call to the service clock returns the current time and then moves it 1s on. */
export const T0 = "2026-09-28T10:00:00Z";
const iso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");

/**
 * A service with an in-memory journal, an INJECTED clock (Phase 1B.1, D3) and predictable ids.
 * No broker, no disk, no network. `clock` lets a test read the time without moving it, or move it on.
 */
export function makeService(start: string = T0) {
  let ms = Date.parse(start);
  let id = 0;
  const now = () => {
    const s = iso(ms);
    ms += 1000;
    return s;
  };
  const clock = {
    peek: (): string => iso(ms),
    set: (to: string): void => {
      ms = Date.parse(to);
    },
    advance: (deltaMs: number): void => {
      ms += deltaMs;
    },
  };
  const repository = new InMemoryJournalRepository(now);
  const service = createPaperTradingService({ repository, now, newId: () => `${++id}` });
  return { service, repository, clock };
}

type RawLeg = { optionType: "CE" | "PE"; strike: number; instrument?: { provider: string; id: string }; quote: Record<string, unknown> };

/**
 * Fresh entry quotes for the EXACT legs of a candidate (Phase 1B.1, D1). By default they repeat the candidate's own
 * prices, so the established numbers (entry 120.75) still hold, and they are stamped with the current clock time.
 */
export function freshQuotes(raw: Record<string, unknown> = longVolRaw(), asOf?: string, override: Record<string, unknown> = {}) {
  const legs = raw["legs"] as RawLeg[];
  return legs.map((l) => ({
    instrument: l.instrument ?? { provider: "manual", id: `${String(raw["marketId"])}|${String(raw["expiry"])}|${l.optionType}|${l.strike}` },
    ...l.quote,
    ...(asOf === undefined ? {} : { asOf }),
    ...override,
  }));
}

/** A valid confirmation body: confirmed: true plus fresh quotes stamped with the service clock's current time. */
export const confirmBody = (svc: ReturnType<typeof makeService>, raw: Record<string, unknown> = longVolRaw()) => ({
  confirmed: true,
  quotes: freshQuotes(raw, svc.clock.peek()),
});

/** Review a candidate and return its id (throws if it did not succeed). */
export async function reviewed(svc: ReturnType<typeof makeService>, raw: Record<string, unknown> = longVolRaw()): Promise<string> {
  const r = await svc.service.beginReview(raw);
  if (!r.ok) throw new Error(`review failed: ${JSON.stringify(r.error)}`);
  return r.value.tradeId;
}

/** Review and explicitly confirm. */
export async function opened(svc: ReturnType<typeof makeService>, raw: Record<string, unknown> = longVolRaw()): Promise<string> {
  const id = await reviewed(svc, raw);
  const c = await svc.service.confirm(id, confirmBody(svc, raw));
  if (!c.ok) throw new Error(`confirm failed: ${JSON.stringify(c.error)}`);
  return id;
}
