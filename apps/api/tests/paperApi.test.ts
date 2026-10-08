import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { createDefaultPaperService } from "../src/paperService.js";

const CE = { provider: "manual", id: "NIFTY|2026-10-06|CE|22900" };
const PE = { provider: "manual", id: "NIFTY|2026-10-06|PE|22800" };
const depth = { volume: 6000, oi: 12000, bidQty: 6500, askQty: 6500 };
const candidate = (over: Record<string, unknown> = {}) => ({
  source: "LONG_VOL", marketId: "NIFTY", structure: "STRANGLE", expiry: "2026-10-06", lotSize: 65, asOf: "2026-09-28T10:00:00+05:30",
  legs: [
    { optionType: "CE", strike: 22900, quote: { bid: 69.0, ask: 69.8, ...depth } },
    { optionType: "PE", strike: 22800, quote: { bid: 50.2, ask: 50.95, ...depth } },
  ],
  spot: 22831.15, score: 62, expectedMove: 230, impliedMove: 180, expectedNetEdge: 700, iv: 0.15, rv20: 0.12, rvRegime: "RV_ACCELERATING",
  tradingDaysToExpiry: 8, maxCapitalAllocation: 100000, entryCosts: 250, requestedLots: 1, ...over,
});
const bids = (ce: number | null, pe: number | null) => ({ quotes: [{ instrument: CE, bid: ce }, { instrument: PE, bid: pe }] });

interface Reply { status: number; body: any; headers: Record<string, string | string[] | undefined> } // eslint-disable-line @typescript-eslint/no-explicit-any
function call(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const h: Record<string, string> = { ...headers };
    if (payload !== undefined && h["Content-Type"] === undefined) h["Content-Type"] = "application/json";
    const req = request({ host: "127.0.0.1", port, path, method, headers: h }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (data += c));
      res.on("end", () => {
        let parsed: unknown = data === "" ? null : data;
        try {
          if (data !== "") parsed = JSON.parse(data);
        } catch {
          // Express answers a plain OPTIONS request with a text body; keep it as text.
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
      });
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
  const server = createApp(loadServerConfig({}), undefined, { paperService: createDefaultPaperService(path) }).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}
const stop = (s: Server) => new Promise<void>((r) => s.close(() => r()));
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nsest-api-"));
  file = join(dir, "journal.json");
});
afterEach(async () => {
  await Promise.all(servers.map(stop));
  servers = [];
  await rm(dir, { recursive: true, force: true });
});

async function reviewed(port: number, over: Record<string, unknown> = {}): Promise<string> {
  const r = await call(port, "POST", "/api/paper/review", candidate(over));
  expect(r.status).toBe(201);
  return r.body.tradeId as string;
}
const opened = async (port: number, over: Record<string, unknown> = {}) => {
  const id = await reviewed(port, over);
  expect((await call(port, "POST", `/api/paper/trades/${id}/confirm`, { confirmed: true })).status).toBe(200);
  return id;
};

describe("assess and review", () => {
  it("POST /assess evaluates and stores nothing", async () => {
    const port = await start();
    const r = await call(port, "POST", "/api/paper/assess", candidate());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "CANDIDATE", review: { combinedEntryPremium: 120.75, risk: { result: { riskLevel: "LOW" } } } });
    expect((await call(port, "GET", "/api/paper/trades")).body.trades).toEqual([]);
  });

  it("an invalid body is a 400 INVALID_REQUEST with details", async () => {
    const port = await start();
    const r = await call(port, "POST", "/api/paper/assess", { source: "LONG_VOL" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("INVALID_REQUEST");
    expect(r.body.details.length).toBeGreaterThan(0);
  });

  it("malformed JSON is a 400, not a 500", async () => {
    const port = await start();
    const r = await call(port, "POST", "/api/paper/assess", "{ not json");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("INVALID_REQUEST");
  });

  it("a non-JSON content type is not parsed and is refused (a plain cross-site form post cannot create anything)", async () => {
    const port = await start();
    const r = await call(port, "POST", "/api/paper/review", "source=LONG_VOL", { "Content-Type": "application/x-www-form-urlencoded" });
    expect(r.status).toBe(400);
    expect((await call(port, "GET", "/api/paper/trades")).body.trades).toEqual([]);
  });

  it("an oversized body is refused", async () => {
    const port = await start();
    const r = await call(port, "POST", "/api/paper/assess", candidate({ note: "x".repeat(300_000) }));
    expect(r.status).toBe(413);
  });

  it("POST /review creates a PAPER_REVIEW trade (201) that is NOT open", async () => {
    const port = await start();
    const r = await call(port, "POST", "/api/paper/review", candidate());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ state: "PAPER_REVIEW", entry: null });
    expect((await call(port, "GET", "/api/paper/trades?state=PAPER_OPEN")).body.trades).toEqual([]);
  });

  it("a candidate with no executable entry is a 422 and a stored DATA_INSUFFICIENT record", async () => {
    const port = await start();
    const r = await call(port, "POST", "/api/paper/review", candidate({ legs: [
      { optionType: "CE", strike: 22900, quote: { bid: 69, ask: null, ltp: 69.5 } },
      { optionType: "PE", strike: 22800, quote: { bid: 50.2, ask: 50.95 } },
    ] }));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: "DATA_INSUFFICIENT", trade: { state: "DATA_INSUFFICIENT", entry: null } });
    expect((await call(port, "GET", "/api/paper/trades?state=DATA_INSUFFICIENT")).body.trades).toHaveLength(1);
  });
});

describe("confirmation, monitoring, exit", () => {
  it("opening requires explicit confirmation", async () => {
    const port = await start();
    const id = await reviewed(port);
    const none = await call(port, "POST", `/api/paper/trades/${id}/confirm`, {});
    expect(none.status).toBe(400);
    const no = await call(port, "POST", `/api/paper/trades/${id}/confirm`, { confirmed: false });
    expect(no.status).toBe(400);
    expect(no.body.error).toBe("CONFIRMATION_REQUIRED");
    expect((await call(port, "GET", `/api/paper/trades/${id}`)).body.trade.state).toBe("PAPER_REVIEW");
    const yes = await call(port, "POST", `/api/paper/trades/${id}/confirm`, { confirmed: true });
    expect(yes.status).toBe(200);
    expect(yes.body).toMatchObject({ state: "PAPER_OPEN", entry: { combinedEntryPremium: 120.75, lots: 1 } });
  });

  it("a second confirmation is a 409", async () => {
    const port = await start();
    const id = await opened(port);
    expect((await call(port, "POST", `/api/paper/trades/${id}/confirm`, { confirmed: true })).status).toBe(409);
  });

  it("monitor returns unrealized P&L; entry risk and snapshot are unchanged", async () => {
    const port = await start();
    const id = await opened(port);
    const before = (await call(port, "GET", `/api/paper/trades/${id}`)).body.trade;
    const r = await call(port, "POST", `/api/paper/trades/${id}/monitor`, bids(66.05, 54));
    expect(r.status).toBe(200);
    expect(r.body.lastMonitor).toMatchObject({ dataStatus: "VALID", currentExitPremium: 120.05, unrealized: { grossPnl: -45.5 } });
    expect(r.body.entry).toEqual(before.entry);
  });

  it("an exit with a missing bid is a 422 and the trade stays PAPER_OPEN", async () => {
    const port = await start();
    const id = await opened(port);
    const r = await call(port, "POST", `/api/paper/trades/${id}/exit`, bids(null, 54));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: "DATA_INSUFFICIENT", trade: { state: "PAPER_OPEN", exit: null } });
  });

  it("an exit with an LTP only (no bid) is refused", async () => {
    const port = await start();
    const id = await opened(port);
    const r = await call(port, "POST", `/api/paper/trades/${id}/exit`, { quotes: [{ instrument: CE, bid: null, ltp: 66 }, { instrument: PE, bid: null, ltp: 54 }] });
    expect(r.status).toBe(422);
  });

  it("a valid exit is PAPER_EXITED with realized gross -45.50", async () => {
    const port = await start();
    const id = await opened(port);
    const r = await call(port, "POST", `/api/paper/trades/${id}/exit`, bids(66.05, 54));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "PAPER_EXITED", realizedPnl: { status: "VALID", grossPnl: -45.5 } });
    expect((await call(port, "POST", `/api/paper/trades/${id}/exit`, bids(66.05, 54))).status).toBe(409);
  });

  it("safety check: after expiry with no price -> PAPER_EXPIRED and P&L DATA_INSUFFICIENT", async () => {
    const port = await start();
    const id = await opened(port);
    const r = await call(port, "POST", `/api/paper/trades/${id}/safety-check`, { asOf: "2026-10-07T09:20:00+05:30" });
    expect(r.status).toBe(200);
    expect(r.body.decision.action).toBe("EXPIRE");
    expect(r.body.trade).toMatchObject({ state: "PAPER_EXPIRED", exit: { basis: "NONE", exitPremium: null }, realizedPnl: { status: "DATA_INSUFFICIENT" } });
  });

  it("safety check: holding limit with valid bids -> PAPER_AUTO_CLOSED", async () => {
    const port = await start();
    const id = await opened(port);
    const r = await call(port, "POST", `/api/paper/trades/${id}/safety-check`, { asOf: "2026-10-01T15:00:00+05:30", completedSessions: 2, ...bids(66.05, 54) });
    expect(r.body.trade).toMatchObject({ state: "PAPER_AUTO_CLOSED", realizedPnl: { grossPnl: -45.5 } });
  });
});

describe("lookup, filters, journal and export", () => {
  it("unknown, 'constructor' and '__proto__' trade ids are 404", async () => {
    const port = await start();
    for (const id of ["pt_nope", "constructor", "__proto__", "toString"]) {
      const r = await call(port, "GET", `/api/paper/trades/${id}`);
      expect(r.status, id).toBe(404);
      expect((await call(port, "POST", `/api/paper/trades/${id}/confirm`, { confirmed: true })).status, id).toBe(404);
    }
  });

  it("GET /trades/:id returns the trade with its events", async () => {
    const port = await start();
    const id = await opened(port);
    const r = await call(port, "GET", `/api/paper/trades/${id}`);
    expect(r.body.events.map((e: { type: string }) => e.type)).toEqual(["REVIEW_STARTED", "TRADE_OPENED"]);
  });

  it("filters by state and by risk; bad filter values are 400", async () => {
    const port = await start();
    const low = await opened(port);
    const high = await opened(port, { legs: [
      { optionType: "CE", strike: 22900, quote: { bid: 60, ask: 75, ...depth } },
      { optionType: "PE", strike: 22800, quote: { bid: 45, ask: 58, ...depth } },
    ] });
    const ids = async (q: string) => (await call(port, "GET", `/api/paper/trades${q}`)).body.trades.map((t: { tradeId: string }) => t.tradeId);
    expect(await ids("?risk=ALL")).toEqual([low, high]);
    expect(await ids("?risk=LOW")).toEqual([low]);
    expect(await ids("?risk=HIGH")).toEqual([high]);
    expect(await ids("?risk=MEDIUM")).toEqual([]);
    expect(await ids("?state=PAPER_OPEN&risk=HIGH")).toEqual([high]);
    expect(await ids("?state=PAPER_REVIEW")).toEqual([]);
    expect((await call(port, "GET", "/api/paper/trades?risk=EXTREME")).status).toBe(400);
    expect((await call(port, "GET", "/api/paper/trades?state=BOGUS")).status).toBe(400);
  });

  it("GET /journal lists events, optionally for one trade", async () => {
    const port = await start();
    const a = await opened(port);
    await reviewed(port);
    expect((await call(port, "GET", "/api/paper/journal")).body.events).toHaveLength(3);
    expect((await call(port, "GET", `/api/paper/journal?tradeId=${a}`)).body.events).toHaveLength(2);
  });

  it("GET /export downloads the whole journal as JSON with a durability notice", async () => {
    const port = await start();
    await opened(port);
    const r = await call(port, "GET", "/api/paper/export");
    expect(r.status).toBe(200);
    expect(String(r.headers["content-disposition"])).toMatch(/^attachment; filename="paper-journal-\d{14}\.json"$/);
    expect(r.body).toMatchObject({ exportVersion: 1, app: "nse-smart-trader-v2", counts: { trades: 1, events: 2 } });
    expect(r.body.durabilityNotice).toMatch(/NOT guaranteed durable/);
  });
});

describe("persistence through the API", () => {
  it("a restarted server (new process state, same file) still has the trade, entry snapshot and events", async () => {
    const first = await start();
    const id = await opened(first);
    await call(first, "POST", `/api/paper/trades/${id}/monitor`, bids(66.05, 54));
    const snapshot = (await call(first, "GET", `/api/paper/trades/${id}`)).body;
    await Promise.all(servers.map(stop));
    servers = [];

    const second = await start();
    const again = (await call(second, "GET", `/api/paper/trades/${id}`)).body;
    expect(again.trade).toEqual(snapshot.trade);
    expect(again.events).toEqual(snapshot.events);
    expect(again.trade.entry.combinedEntryPremium).toBe(120.75);
  });

  it("a corrupt journal file is reported as STORAGE_ERROR (500) and is not overwritten", async () => {
    await writeFile(file, "{ corrupt", "utf8");
    const port = await start();
    const list = await call(port, "GET", "/api/paper/trades");
    expect(list.status).toBe(500);
    expect(list.body.error).toBe("STORAGE_ERROR");
    const create = await call(port, "POST", "/api/paper/review", candidate());
    expect(create.status).toBe(500);
    await expect(readFile(file, "utf8")).resolves.toBe("{ corrupt");
  });
});

describe("no live trading, broker or authentication endpoints", () => {
  it.each([
    ["POST", "/api/orders"], ["POST", "/api/order"], ["POST", "/api/paper/orders"], ["POST", "/api/paper/place-order"],
    ["POST", "/api/broker/login"], ["GET", "/api/broker/callback"], ["POST", "/api/auth"], ["POST", "/api/auth/token"], ["GET", "/api/broker/profile"],
    ["DELETE", "/api/paper/trades/pt_1"], ["PUT", "/api/paper/trades/pt_1"],
  ])("%s %s is a 404", async (method, path) => {
    const port = await start();
    expect((await call(port, method, path, method === "GET" ? undefined : {})).status).toBe(404);
  });

  it("the Phase 1A endpoints are unchanged", async () => {
    const port = await start();
    expect((await call(port, "GET", "/api/health")).body).toEqual({ status: "ok", phase: "1A", brokerProvider: "none", brokerConnected: false, liveOrdersEnabled: false });
    expect((await call(port, "GET", "/api/markets")).body.markets).toHaveLength(6);
  });
});

describe("CORS (local dev origin only)", () => {
  it("answers the preflight for the local Vite origin and allows POST with Content-Type", async () => {
    const port = await start();
    const r = await call(port, "OPTIONS", "/api/paper/review", undefined, { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST" });
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(String(r.headers["access-control-allow-methods"])).toMatch(/POST/);
    expect(r.headers["access-control-allow-headers"]).toBe("Content-Type");
  });

  it("gives a foreign origin no CORS permission at all", async () => {
    const port = await start();
    const pre = await call(port, "OPTIONS", "/api/paper/review", undefined, { Origin: "https://evil.example" });
    expect(pre.status).not.toBe(204); // the dev-origin preflight answer is NOT given
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
    expect(pre.headers["access-control-allow-methods"]).toBeUndefined();
    expect(pre.headers["access-control-allow-headers"]).toBeUndefined();
    const get = await call(port, "GET", "/api/paper/trades", undefined, { Origin: "https://evil.example" });
    expect(get.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
