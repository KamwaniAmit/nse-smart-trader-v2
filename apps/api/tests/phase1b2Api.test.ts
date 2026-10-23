// Phase 1B.2 HTTP tests (test-first): status codes for the new rules, derived fields on trade responses, the raw export
// contract, and the historical journal samples written by 1d21f06 and b91fa26. Samples are COPIED to a temp folder;
// the originals are never modified. Every manual price carries an entry time PASSED BY THE TEST (normally serverNow(),
// the injected server clock's current time); no helper reads a clock implicitly.
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
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
