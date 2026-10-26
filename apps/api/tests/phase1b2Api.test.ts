// Phase 1B.2 HTTP tests (test-first): status codes for the new rules, derived fields on trade responses, the raw export
// contract, and the historical journal samples written by 1d21f06 and b91fa26. Samples are COPIED to a temp folder;
// the originals are never modified. Every manual price carries an entry time PASSED BY THE TEST (normally serverNow(),
// the injected server clock's current time); no helper reads a clock implicitly.
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { createDefaultPaperService } from "../src/paperService.js";

const CE = { provider: "manual", id: "NIFTY|2026-10-06|CE|22900" };
const PE = { provider: "manual", id: "NIFTY|2026-10-06|PE|22800" };
const depth = { volume: 6000, oi: 12000, bidQty: 6500, askQty: 6500 };
const candidate = () => ({
  source: "LONG_VOL", marketId: "NIFTY", structure: "STRANGLE", expiry: "2026-10-06", lotSize: 65, asOf: "2026-09-28T10:00:00+05:30",
  legs: [
    { optionType: "CE", strike: 22900, quote: { bid: 69.0, ask: 69.8, ...depth } },
    { optionType: "PE", strike: 22800, quote: { bid: 50.2, ask: 50.95, ...depth } },
  ],
  spot: 22831.15, score: 62, expectedMove: 230, impliedMove: 180, expectedNetEdge: 700, iv: 0.15, rv20: 0.12, rvRegime: "RV_ACCELERATING",
  tradingDaysToExpiry: 8, maxCapitalAllocation: 100000, entryCosts: 250, requestedLots: 1,
});

const CUTOFF = "2026-10-06T10:00:00.000Z"; // 15:30 IST on the fixture expiry date (A3)
let clockMs = Date.parse("2026-09-28T10:00:00.000Z");
const clockNow = (): string => {
  const s = new Date(clockMs).toISOString();
  clockMs += 1;
  return s;
};
const setClock = (iso: string): void => {
  clockMs = Date.parse(iso);
};
/** The injected server clock's CURRENT time, without moving it: the time the server will read next. */
const serverNow = (): string => new Date(clockMs).toISOString();
/** Manually entered prices with bid, ask and the given entry time (null = no entry time sent). */
const prices = (at: string | null, ce: [number | null, number | null] = [66.05, 66.55], pe: [number | null, number | null] = [54, 54.5]) => ({
  quotes: [
    { instrument: CE, bid: ce[0], ask: ce[1], ...(at === null ? {} : { asOf: at }) },
    { instrument: PE, bid: pe[0], ask: pe[1], ...(at === null ? {} : { asOf: at }) },
  ],
});
const confirmBody = (at: string) => ({ confirmed: true, quotes: [{ instrument: CE, bid: 69, ask: 69.8, ...depth, asOf: at }, { instrument: PE, bid: 50.2, ask: 50.95, ...depth, asOf: at }] });

interface Reply { status: number; body: any; raw: string } // eslint-disable-line @typescript-eslint/no-explicit-any
function call(port: number, method: string, path: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, path, method, headers: payload === undefined ? {} : { "Content-Type": "application/json" } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data === "" ? null : JSON.parse(data), raw: data }));
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

let dir: string;
let file: string;
let servers: Server[] = [];
async function start(path = file): Promise<number> {
  const server = createApp(loadServerConfig({}), undefined, { paperService: createDefaultPaperService(path, { now: clockNow }) }).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}
beforeEach(async () => {
  setClock("2026-09-28T10:00:00.000Z");
  dir = await mkdtemp(join(tmpdir(), "nsest-1b2-"));
  file = join(dir, "journal.json");
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
  await rm(dir, { recursive: true, force: true });
});
const reviewed = async (port: number): Promise<string> => {
  const r = await call(port, "POST", "/api/paper/review", candidate());
  expect(r.status).toBe(201);
  return r.body.tradeId as string;
};
const opened = async (port: number): Promise<string> => {
  const id = await reviewed(port);
  expect((await call(port, "POST", `/api/paper/trades/${id}/confirm`, confirmBody(serverNow()))).status).toBe(200);
  return id;
};

describe("A6: CONTRACT_EXPIRED is HTTP 409 on every gated action", () => {
  it("assess and review at the cutoff", async () => {
    setClock(CUTOFF);
    const port = await start();
    for (const path of ["/api/paper/assess", "/api/paper/review"]) {
      const r = await call(port, "POST", path, candidate());
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("CONTRACT_EXPIRED");
    }
  });
  it("confirm, monitor and exit at the cutoff", async () => {
    const port = await start();
    const review = await reviewed(port);
    const open = await opened(port);
    setClock(CUTOFF);
    const replies = [
      await call(port, "POST", `/api/paper/trades/${review}/confirm`, confirmBody(serverNow())),
      await call(port, "POST", `/api/paper/trades/${open}/monitor`, prices(serverNow())),
      await call(port, "POST", `/api/paper/trades/${open}/exit`, prices(serverNow())),
    ];
    expect(replies.map((r) => [r.status, r.body.error])).toEqual([[409, "CONTRACT_EXPIRED"], [409, "CONTRACT_EXPIRED"], [409, "CONTRACT_EXPIRED"]]);
  });
  it("an exit with stale manual prices is 422 QUOTE_NOT_FRESH; a crossed one is 422 DATA_INSUFFICIENT", async () => {
    const port = await start();
    const id = await opened(port);
    const stale = new Date(Date.parse(serverNow()) - 60_001).toISOString();
    expect((await call(port, "POST", `/api/paper/trades/${id}/exit`, prices(stale))).body.error).toBe("QUOTE_NOT_FRESH");
    const crossed = await call(port, "POST", `/api/paper/trades/${id}/exit`, prices(serverNow(), [660.5, 66.55]));
    expect([crossed.status, crossed.body.error]).toEqual([422, "DATA_INSUFFICIENT"]);
  });
});

describe("A10: derived priceQuality / expiryStatus on trade responses; the raw export is unchanged", () => {
  it("D2: GET /trades, GET /trades/:id and the monitor and exit responses carry the derived fields", async () => {
    const port = await start();
    const id = await opened(port);
    const mon = await call(port, "POST", `/api/paper/trades/${id}/monitor`, prices(serverNow()));
    expect(mon.status).toBe(200);
    expect(mon.body.priceQuality).toBeDefined();
    expect(mon.body.expiryStatus).toMatchObject({ status: "BEFORE_CUTOFF" });
    const exit = await call(port, "POST", `/api/paper/trades/${id}/exit`, prices(serverNow()));
    expect(exit.status).toBe(200);
    expect(exit.body.priceQuality).toMatchObject({ level: "MANUAL_ENTRY_CHECKED" });
    // MANUAL_ENTRY_CHECKED = the app's manual-input validation rules passed; never exchange-sourced or verified.
    expect(exit.body.priceQuality.note).toMatch(/not exchange-sourced, exchange-timestamped or independently verified/i);
    const one = await call(port, "GET", `/api/paper/trades/${id}`);
    expect(one.body.trade.priceQuality).toMatchObject({ level: "MANUAL_ENTRY_CHECKED", flags: [] });
    expect(one.body.trade.expiryStatus).toMatchObject({ status: "CLOSED" });
    const list = await call(port, "GET", "/api/paper/trades");
    expect(list.body.trades.every((t: { priceQuality?: unknown; expiryStatus?: unknown }) => t.priceQuality !== undefined && t.expiryStatus !== undefined)).toBe(true);
  });

  it("guard: GET /export is exactly the stored journal (no derived fields), and reads never rewrite the file", async () => {
    const port = await start();
    const id = await opened(port);
    expect((await call(port, "POST", `/api/paper/trades/${id}/monitor`, prices(serverNow()))).status).toBe(200);
    await reviewed(port);
    setClock(CUTOFF); // derived EXPIRED_PENDING_CLOSURE / EXPIRED_REVIEW are computed on the reads below
    const stored = await readFile(file, "utf8");
    await call(port, "GET", "/api/paper/trades");
    await call(port, "GET", `/api/paper/trades/${id}`);
    const exp = await call(port, "GET", "/api/paper/export");
    expect(await readFile(file, "utf8")).toBe(stored);
    const journal = JSON.parse(stored) as { trades: Record<string, unknown>; events: unknown[] };
    expect(Object.fromEntries((exp.body.trades as Array<{ tradeId: string }>).map((t) => [t.tradeId, t]))).toEqual(journal.trades);
    expect(exp.body.events).toEqual(journal.events);
    expect(Object.keys(exp.body).sort()).toEqual(["app", "counts", "durabilityNotice", "events", "exportVersion", "exportedAt", "trades"]);
    expect(exp.raw).not.toMatch(/priceQuality|expiryStatus/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
const SAMPLES = fileURLToPath(new URL("../../../packages/core/tests/fixtures/journals/", import.meta.url));
const useSample = async (name: string): Promise<string> => {
  await copyFile(join(SAMPLES, name), file);
  return readFile(file, "utf8");
};

describe.each([["journal-1d21f06.json", "1d21f06", 8, 22], ["journal-b91fa26.json", "b91fa26", 8, 23]])("historical sample %s", (name, v, nTrades, nEvents) => {
  it("guard: loads, lists every trade and exports the stored records unchanged; reads do not rewrite the file", async () => {
    const original = await useSample(name);
    setClock("2026-10-02T04:30:00.000Z");
    const port = await start();
    const list = await call(port, "GET", "/api/paper/trades");
    expect(list.status).toBe(200);
    expect(list.body.trades).toHaveLength(nTrades);
    const exp = await call(port, "GET", "/api/paper/export");
    const journal = JSON.parse(original) as { trades: Record<string, unknown>; events: unknown[] };
    expect(exp.body.counts).toEqual({ trades: nTrades, events: nEvents });
    expect(Object.fromEntries((exp.body.trades as Array<{ tradeId: string }>).map((t) => [t.tradeId, t]))).toEqual(journal.trades);
    expect(exp.body.events).toEqual(journal.events);
    expect(exp.raw).not.toMatch(/priceQuality|expiryStatus/);
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("every listed trade carries priceQuality, and the stored records stay byte-identical", async () => {
    const original = await useSample(name);
    const port = await start();
    const list = await call(port, "GET", "/api/paper/trades");
    expect(list.body.trades.every((t: { priceQuality?: { level?: string } }) => typeof t.priceQuality?.level === "string")).toBe(true);
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("an old open trade past the cutoff: monitor and exit 409; the expiry closure is unpriced", async () => {
    await useSample(name);
    const openId = `pt_${v}-open`;
    setClock(CUTOFF);
    const port = await start();
    expect((await call(port, "GET", `/api/paper/trades/${openId}`)).body.trade.expiryStatus).toMatchObject({ status: "EXPIRED_PENDING_CLOSURE" });
    expect((await call(port, "POST", `/api/paper/trades/${openId}/monitor`, prices(serverNow()))).status).toBe(409);
    expect((await call(port, "POST", `/api/paper/trades/${openId}/exit`, prices(serverNow()))).status).toBe(409);
    const s = await call(port, "POST", `/api/paper/trades/${openId}/safety-check`, prices(serverNow()));
    expect(s.status).toBe(200);
    expect(s.body.trade).toMatchObject({ state: "PAPER_EXPIRED", exit: { basis: "NONE", exitPremium: null }, realizedPnl: { status: "DATA_INSUFFICIENT" } });
  });

  it("an old review past the cutoff cannot be confirmed (409) and is reported as EXPIRED_REVIEW", async () => {
    await useSample(name);
    const reviewId = `pt_${v}-review`;
    setClock(CUTOFF);
    const port = await start();
    expect((await call(port, "POST", `/api/paper/trades/${reviewId}/confirm`, confirmBody(serverNow()))).status).toBe(409);
    expect((await call(port, "GET", `/api/paper/trades/${reviewId}`)).body.trade.expiryStatus).toMatchObject({ status: "EXPIRED_REVIEW" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Final review: instrument identity. New candidates must be consistent. OLDER records (copied from the b91fa26 sample and
// edited in the temp copy only) are never rewritten and stay readable; a record that is not CONSISTENT is never confirmed,
// monitored, exited or priced, and can only be closed unpriced. The cutoff is never later than a readable instrument expiry.
describe("final review: instrument identity (HTTP)", () => {
  const withInstruments = (ceId: string, peId: string) => ({ ...candidate(), legs: [
    { optionType: "CE", strike: 22900, instrument: { provider: "manual", id: ceId }, quote: { bid: 69.0, ask: 69.8, ...depth } },
    { optionType: "PE", strike: 22800, instrument: { provider: "manual", id: peId }, quote: { bid: 50.2, ask: 50.95, ...depth } },
  ] });

  it.each([
    ["market", "BANKNIFTY|2026-10-06|CE|22900", /instrument market "BANKNIFTY" does not match the market "NIFTY"/],
    ["expiry", "NIFTY|2026-12-29|CE|22900", /instrument expiry "2026-12-29" does not match the expiry "2026-10-06"/],
    ["option type", "NIFTY|2026-10-06|PE|22900", /instrument option type "PE" does not match the option type "CE"/],
    ["strike", "NIFTY|2026-10-06|CE|23000", /instrument strike "23000" does not match the strike "22900"/],
  ])("assess and review refuse a %s mismatch with 400 INVALID_REQUEST; nothing is stored", async (_n, ceId, message) => {
    const port = await start();
    const bad = withInstruments(ceId, "NIFTY|2026-10-06|PE|22800");
    const a = await call(port, "POST", "/api/paper/assess", bad);
    expect(a.status).toBe(400);
    expect(a.body.error).toBe("INVALID_REQUEST");
    expect(a.body.details.join(" ")).toMatch(message);
    expect((await call(port, "POST", "/api/paper/review", bad)).status).toBe(400);
    expect((await call(port, "GET", "/api/paper/trades")).body.trades).toEqual([]);
  });

  it("a consistent explicit instrument is accepted and reported CONSISTENT", async () => {
    const port = await start();
    const good = await call(port, "POST", "/api/paper/review", withInstruments("NIFTY|2026-10-06|CE|22900", "NIFTY|2026-10-06|PE|22800"));
    expect(good.status).toBe(201);
    expect(good.body.expiryStatus).toMatchObject({ status: "BEFORE_CUTOFF", expiryUsed: "2026-10-06", instrumentCheck: "CONSISTENT", instrumentReasons: [] });
  });

  /** A temp copy of the b91fa26 sample whose trade `id` has its legs' instruments replaced (the original is untouched). */
  const seedLegacy = async (id: string, ids: [unknown, unknown]): Promise<string> => {
    const j = JSON.parse(await readFile(join(SAMPLES, "journal-b91fa26.json"), "utf8")) as { trades: Record<string, { candidate: { legs: Array<{ instrument: unknown }> } }> };
    const legs = j.trades[id]?.candidate.legs ?? [];
    legs.forEach((l, i) => (l.instrument = ids[i]));
    const text = JSON.stringify(j, null, 2);
    await writeFile(file, text, "utf8");
    return text;
  };
  const OPEN = "pt_b91fa26-open";
  const OPAQUE: [unknown, unknown] = [{ provider: "p", id: "abc" }, { provider: "manual", id: "NIFTY|2026-10-06|PE|22800" }];
  /** Valid, fresh manual prices for the legs exactly as stored (so only the instrument rule can refuse them). */
  const pricesFor = (legs: Array<{ instrument: unknown }>, at: string) => ({
    quotes: [{ instrument: legs[0]?.instrument, bid: 66.05, ask: 66.55, asOf: at }, { instrument: legs[1]?.instrument, bid: 54, ask: 54.5, asOf: at }],
  });

  it("UNVERIFIABLE older open trade, before the cutoff: readable and flagged; monitor and exit refused (422, nothing written)", async () => {
    const stored = await seedLegacy(OPEN, OPAQUE);
    setClock("2026-10-02T04:30:00.000Z");
    const port = await start();
    const g = await call(port, "GET", `/api/paper/trades/${OPEN}`);
    expect(g.status).toBe(200);
    expect(g.body.trade.expiryStatus).toMatchObject({ status: "BEFORE_CUTOFF", expiryUsed: "2026-10-06", instrumentCheck: "UNVERIFIABLE" });
    expect(g.body.trade.expiryStatus.instrumentReasons.join(" ")).toMatch(/CE 22900: a "p" instrument cannot be verified/);
    expect(g.body.trade.priceQuality.flags).toContain("INSTRUMENT_IDENTITY_UNVERIFIED");
    expect(g.body.trade.priceQuality.level).not.toBe("MANUAL_ENTRY_CHECKED");
    const legs = g.body.trade.candidate.legs;
    for (const action of ["monitor", "exit"]) {
      const r = await call(port, "POST", `/api/paper/trades/${OPEN}/${action}`, pricesFor(legs, serverNow()));
      expect(r.status).toBe(422);
      expect(r.body.error).toBe("DATA_INSUFFICIENT");
      expect(r.body.message).toMatch(/do not verifiably identify its contract \(UNVERIFIABLE\)/);
    }
    expect(await readFile(file, "utf8")).toBe(stored); // refused before anything is written
  });

  it("UNVERIFIABLE older open trade: a holding-limit closure is UNPRICED even with valid prices", async () => {
    await seedLegacy(OPEN, OPAQUE);
    setClock("2026-10-02T04:30:00.000Z");
    const port = await start();
    const legs = (await call(port, "GET", `/api/paper/trades/${OPEN}`)).body.trade.candidate.legs;
    const s = await call(port, "POST", `/api/paper/trades/${OPEN}/safety-check`, { completedSessions: 2, ...pricesFor(legs, serverNow()) });
    expect(s.status).toBe(200);
    expect(s.body.decision.action).toBe("AUTO_CLOSE");
    expect(s.body.trade).toMatchObject({ state: "PAPER_AUTO_CLOSED", exit: { trigger: "HOLDING_LIMIT", basis: "NONE", exitPremium: null, valuationStatus: "DATA_INSUFFICIENT", priceProvenance: "NONE" }, realizedPnl: { status: "DATA_INSUFFICIENT" } });
    expect(s.body.trade.exit.notes.join(" ")).toMatch(/Not priced: the instruments do not verifiably identify this contract \(UNVERIFIABLE\)/);
  });

  it("UNVERIFIABLE older open trade: the expiry closure uses the candidate expiry, boundary pinned at 15:30 IST, and is unpriced", async () => {
    await seedLegacy(OPEN, OPAQUE);
    setClock("2026-10-06T09:00:00.000Z");
    let port = await start();
    const legs = (await call(port, "GET", `/api/paper/trades/${OPEN}`)).body.trade.candidate.legs;
    setClock("2026-10-06T09:59:59.999Z"); // 15:29:59.999 IST: the next server read
    const before = await call(port, "POST", `/api/paper/trades/${OPEN}/safety-check`, {});
    expect(before.body.decision.action).toBe("NONE");
    expect(before.body.trade.state).toBe("PAPER_OPEN");
    setClock(CUTOFF); // 15:30:00.000 IST (inclusive)
    port = await start();
    expect((await call(port, "POST", `/api/paper/trades/${OPEN}/monitor`, pricesFor(legs, serverNow()))).status).toBe(409); // expiry gate first
    const s = await call(port, "POST", `/api/paper/trades/${OPEN}/safety-check`, pricesFor(legs, serverNow()));
    expect(s.body.decision.action).toBe("EXPIRE");
    expect(s.body.trade).toMatchObject({ state: "PAPER_EXPIRED", exit: { trigger: "EXPIRY", basis: "NONE", exitPremium: null, valuationStatus: "DATA_INSUFFICIENT" }, realizedPnl: { status: "DATA_INSUFFICIENT" } });
  });

  it("MISMATCH older open trade (instrument names an EARLIER expiry): monitor refused before; the earlier cutoff applies (boundary pinned)", async () => {
    const stored = await seedLegacy(OPEN, [{ provider: "manual", id: "NIFTY|2026-10-01|CE|22900" }, { provider: "manual", id: "NIFTY|2026-10-01|PE|22800" }]);
    setClock("2026-10-01T09:00:00.000Z");
    let port = await start();
    const g = await call(port, "GET", `/api/paper/trades/${OPEN}`);
    expect(g.body.trade.expiryStatus).toMatchObject({ status: "BEFORE_CUTOFF", cutoff: "2026-10-01T15:30:00+05:30", expiryUsed: "2026-10-01", instrumentCheck: "MISMATCH" });
    expect(g.body.trade.candidate.expiry).toBe("2026-10-06"); // never rewritten
    const legs = g.body.trade.candidate.legs;
    expect((await call(port, "POST", `/api/paper/trades/${OPEN}/monitor`, pricesFor(legs, serverNow()))).status).toBe(422);
    setClock("2026-10-01T09:59:59.999Z"); // 15:29:59.999 IST on the instrument expiry date
    expect((await call(port, "POST", `/api/paper/trades/${OPEN}/safety-check`, {})).body.decision.action).toBe("NONE");
    setClock("2026-10-01T10:00:00.000Z");
    port = await start();
    const at = await call(port, "GET", `/api/paper/trades/${OPEN}`);
    expect(at.body.trade.expiryStatus).toMatchObject({ status: "EXPIRED_PENDING_CLOSURE", expiryUsed: "2026-10-01" });
    expect(await readFile(file, "utf8")).toBe(stored); // reads and refusals never rewrite the journal
    expect((await call(port, "POST", `/api/paper/trades/${OPEN}/exit`, pricesFor(legs, serverNow()))).status).toBe(409);
    const s = await call(port, "POST", `/api/paper/trades/${OPEN}/safety-check`, {});
    expect(s.body.trade).toMatchObject({ state: "PAPER_EXPIRED", exit: { basis: "NONE", exitPremium: null }, realizedPnl: { status: "DATA_INSUFFICIENT" } });
  });

  it.each([
    ["an opaque provider", [{ provider: "p", id: "abc" }, { provider: "manual", id: "NIFTY|2026-10-06|PE|22800" }], "UNVERIFIABLE", "2026-10-06"],
    ["a malformed manual id", [{ provider: "manual", id: "NIFTY|2026-10-06|CE" }, { provider: "manual", id: "NIFTY|2026-10-06|PE|22800" }], "UNVERIFIABLE", "2026-10-06"],
    ["a LATER instrument expiry (never extends the cutoff)", [{ provider: "manual", id: "NIFTY|2026-12-29|CE|22900" }, { provider: "manual", id: "NIFTY|2026-10-06|PE|22800" }], "MISMATCH", "2026-10-06"],
    ["a strike mismatch", [{ provider: "manual", id: "NIFTY|2026-10-06|CE|23000" }, { provider: "manual", id: "NIFTY|2026-10-06|PE|22800" }], "MISMATCH", "2026-10-06"],
    ["an option-type mismatch", [{ provider: "manual", id: "NIFTY|2026-10-06|PE|22900" }, { provider: "manual", id: "NIFTY|2026-10-06|PE|22800" }], "MISMATCH", "2026-10-06"],
  ])("an OLDER review with %s stays readable but cannot be confirmed (422); nothing changes", async (_n, ids, check, used) => {
    const stored = await seedLegacy("pt_b91fa26-review", ids as [unknown, unknown]);
    setClock("2026-10-02T04:30:00.000Z");
    const port = await start();
    const g = await call(port, "GET", "/api/paper/trades/pt_b91fa26-review");
    expect(g.status).toBe(200);
    expect(g.body.trade.expiryStatus).toMatchObject({ status: "BEFORE_CUTOFF", expiryUsed: used, instrumentCheck: check });
    const legs = g.body.trade.candidate.legs as Array<{ instrument: unknown }>;
    const c = await call(port, "POST", "/api/paper/trades/pt_b91fa26-review/confirm", {
      confirmed: true, quotes: legs.map((l, i) => ({ instrument: l.instrument, bid: i === 0 ? 69 : 50.2, ask: i === 0 ? 69.8 : 50.95, ...depth, asOf: serverNow() })),
    });
    expect(c.status).toBe(422);
    expect(c.body.error).toBe("DATA_INSUFFICIENT");
    expect(c.body.message).toContain(`(${check})`);
    expect(await readFile(file, "utf8")).toBe(stored); // refused before anything is written
    const exp = await call(port, "GET", "/api/paper/export");
    expect(exp.raw).not.toMatch(/expiryUsed|instrumentCheck|instrumentReasons|priceQuality|expiryStatus/);
  });
});
