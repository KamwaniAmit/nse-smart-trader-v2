// Phase 1B.2 web tests (test-first). The UI must say where each price came from (typed by the user, entry time checked
// by the server), never present it as exchange-sourced, exchange-timestamped or independently verified, show expired / pending states clearly, and stop normal actions
// once the server reports the contract has passed its provisional 15:30 IST cutoff.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperTradeRecord } from "@nsest/core/contracts";
import { App } from "../src/App";
import { makeTrade, risk, stubApi } from "./fixtures";
import type { Call } from "./fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const at = (path: string) => render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
const setField = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const posts = (calls: Call[], suffix: string) => calls.filter((c) => c.method === "POST" && c.path.endsWith(suffix));
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** A trade as the API returns it: the stored record plus the derived Phase 1B.2 fields (A7, A10). */
const withView = (t: PaperTradeRecord, v: Any = {}): PaperTradeRecord =>
  ({ ...t, priceQuality: { level: "NO_PRICE", flags: [], warnings: [] }, expiryStatus: { status: "BEFORE_CUTOFF", cutoff: "2026-10-06T15:30:00+05:30" }, ...v }) as unknown as PaperTradeRecord;
const pnl = { status: "VALID" as const, reason: null, grossPnl: -45.5, netPnl: null, netStatus: "COSTS_UNAVAILABLE" as const };

async function show(trade: PaperTradeRecord, extra: Record<string, () => { status?: number; body: unknown }> = {}) {
  const calls = stubApi({
    "GET /api/paper/trades": () => ({ body: { trades: [trade] } }),
    [`GET /api/paper/trades/${trade.tradeId}`]: () => ({ body: { trade, events: [] } }),
    ...extra,
  });
  at("/paper-trading");
  if (trade.state !== "PAPER_OPEN" && trade.state !== "PAPER_REVIEW") fireEvent.click(await screen.findByRole("tab", { name: "History" }));
  fireEvent.click(await screen.findByRole("button", { name: `Open ${trade.tradeId}` }));
  return calls;
}

describe("A2 / HIGH-2: monitor, exit and safety forms collect bid AND ask with per-price entry times", () => {
  const T1 = Date.parse("2026-10-01T05:00:00.000Z");
  const atMs = (ms: number) => vi.setSystemTime(new Date(T1 + ms));
  const iso = (ms: number) => new Date(T1 + ms).toISOString();
  const open = withView(makeTrade("PAPER_OPEN"));

  it("the exit form sends bid, ask and the OLDER of each leg's two entry times", async () => {
    const calls = await show(open, { [`POST /api/paper/trades/${open.tradeId}/exit`]: () => ({ body: open }) });
    await screen.findByLabelText("Exit: CE 22900 ask");
    vi.useFakeTimers({ toFake: ["Date"] });
    atMs(0); setField("Exit: CE 22900 bid", "66.05");
    atMs(2_000); setField("Exit: CE 22900 ask", "66.55");
    atMs(1_000); setField("Exit: PE 22800 bid", "54");
    atMs(3_000); setField("Exit: PE 22800 ask", "54.5");
    fireEvent.click(screen.getByRole("button", { name: "Exit paper trade" }));
    await waitFor(() => expect(posts(calls, "/exit")).toHaveLength(1));
    expect(posts(calls, "/exit")[0]?.body).toEqual({
      quotes: [
        { instrument: { provider: "manual", id: "NIFTY|2026-10-06|CE|22900" }, bid: 66.05, ask: 66.55, asOf: iso(0) },
        { instrument: { provider: "manual", id: "NIFTY|2026-10-06|PE|22800" }, bid: 54, ask: 54.5, asOf: iso(1_000) },
      ],
      exitCosts: null,
    });
  });

  it("a leg with a missing ask is sent without an entry time (the server refuses it)", async () => {
    const calls = await show(open, { [`POST /api/paper/trades/${open.tradeId}/exit`]: () => ({ status: 422, body: { error: "DATA_INSUFFICIENT", message: "x", details: [] } }) });
    await screen.findByLabelText("Exit: CE 22900 ask");
    vi.useFakeTimers({ toFake: ["Date"] }); // only the clock is controlled; React keeps real timers
    atMs(0); setField("Exit: CE 22900 bid", "66.05");
    atMs(1_000); setField("Exit: PE 22800 bid", "54");
    atMs(2_000); setField("Exit: PE 22800 ask", "54.5");
    fireEvent.click(screen.getByRole("button", { name: "Exit paper trade" }));
    await waitFor(() => expect(posts(calls, "/exit")).toHaveLength(1));
    const q = (posts(calls, "/exit")[0]?.body as { quotes: Array<Record<string, unknown>> }).quotes;
    expect(q[0]).toMatchObject({ bid: 66.05, ask: null });
    expect(q[0]).not.toHaveProperty("asOf");
    expect(q[1]).toMatchObject({ bid: 54, ask: 54.5, asOf: iso(1_000) });
  });

  it("the safety check form has ask fields and sends entry times", async () => {
    const calls = await show(open, { [`POST /api/paper/trades/${open.tradeId}/safety-check`]: () => ({ body: { decision: { action: "NONE", reasons: [], notEvaluated: [] }, trade: open } }) });
    await screen.findByLabelText("Safety check: CE 22900 ask");
    vi.useFakeTimers({ toFake: ["Date"] });
    atMs(5_000);
    for (const [l, v] of [["CE 22900 bid", "66.05"], ["CE 22900 ask", "66.55"], ["PE 22800 bid", "54"], ["PE 22800 ask", "54.5"]] as const) setField(`Safety check: ${l}`, v);
    fireEvent.click(screen.getByRole("button", { name: "Run safety check" }));
    await waitFor(() => expect(posts(calls, "/safety-check")).toHaveLength(1));
    const body = posts(calls, "/safety-check")[0]?.body as { quotes: Array<Record<string, unknown>> };
    expect(body.quotes.map((q) => [q["bid"], q["ask"], q["asOf"]])).toEqual([[66.05, 66.55, iso(5_000)], [54, 54.5, iso(5_000)]]);
  });

  it("the monitor form sends entry times", async () => {
    const calls = await show(open, { [`POST /api/paper/trades/${open.tradeId}/monitor`]: () => ({ body: open }) });
    await screen.findByLabelText("Monitor: CE 22900 ask");
    vi.useFakeTimers({ toFake: ["Date"] });
    atMs(7_000);
    for (const [l, v] of [["CE 22900 bid", "66.05"], ["CE 22900 ask", "66.55"], ["PE 22800 bid", "54"], ["PE 22800 ask", "54.5"]] as const) setField(`Monitor: ${l}`, v);
    fireEvent.click(screen.getByRole("button", { name: "Record monitor update" }));
    await waitFor(() => expect(posts(calls, "/monitor")).toHaveLength(1));
    expect((posts(calls, "/monitor")[0]?.body as { quotes: Array<Record<string, unknown>> }).quotes.map((q) => q["asOf"])).toEqual([iso(7_000), iso(7_000)]);
  });

  it("the exit form says its times are user-entry times, the 60 s limit, and never claims exchange verification", async () => {
    await show(open);
    await screen.findByLabelText("Exit: CE 22900 ask");
    const hints = screen.getAllByText(/user-entry times, not exchange timestamps/);
    expect(hints.length).toBeGreaterThanOrEqual(2); // monitor and exit (and safety) forms
    expect(screen.getAllByText(/60 seconds/).length).toBeGreaterThanOrEqual(1);
  });
});

describe("A4 / A5 / A9: valuation labels describe the evidence", () => {
  it("an exit from checked manual prices: 'valued from prices you entered', manual-input checks passed, NOT exchange-sourced or verified", async () => {
    await show(withView(makeTrade("PAPER_EXITED", {
      tradeId: "pt_checked",
      exit: { timestamp: "2026-10-01T09:30:00.000Z", trigger: "USER_EXIT", basis: "CURRENT_QUOTE", priceAsOf: null, legBids: [], exitPremium: 120.05, exitCosts: null, notes: [], valuationStatus: "MANUAL_ENTRY_CHECKED", staleReference: null, priceProvenance: "MANUAL_USER_ENTRY" } as Any as PaperTradeRecord["exit"],
      realizedPnl: pnl,
    }), { priceQuality: { level: "MANUAL_ENTRY_CHECKED", flags: [], warnings: [] }, expiryStatus: { status: "CLOSED", cutoff: "2026-10-06T15:30:00+05:30" } }));
    expect(await screen.findByText(/valued from prices you entered/)).toBeInTheDocument();
    // MANUAL_ENTRY_CHECKED = the app's manual-input checks passed. Never presented as exchange-sourced or verified.
    expect(screen.getByText(/manual-input checks passed/)).toBeInTheDocument();
    expect(screen.getByText(/not exchange-sourced, exchange-timestamped or independently verified/)).toBeInTheDocument();
    expect(screen.queryByText(/price basis CURRENT_QUOTE/)).toBeNull();
    expect(screen.queryByText(/(?<!not )exchange-verified/)).toBeNull();
  });

  it("an unpriced expiry closure says there is no approved settlement-price source", async () => {
    await show(withView(makeTrade("PAPER_EXPIRED", {
      tradeId: "pt_exp",
      exit: { timestamp: "2026-10-06T10:00:00.000Z", trigger: "EXPIRY", basis: "NONE", priceAsOf: null, legBids: [], exitPremium: null, exitCosts: null, notes: [], valuationStatus: "DATA_INSUFFICIENT", staleReference: null },
      realizedPnl: { status: "DATA_INSUFFICIENT", reason: "No valid executable exit price.", grossPnl: null, netPnl: null, netStatus: "DATA_INSUFFICIENT" },
    }), { expiryStatus: { status: "CLOSED", cutoff: "2026-10-06T15:30:00+05:30" } }));
    expect(await screen.findByText(/No approved settlement-price source/)).toBeInTheDocument();
  });

  it("a holding-limit closure says the session count was entered by the user", async () => {
    await show(withView(makeTrade("PAPER_AUTO_CLOSED", {
      tradeId: "pt_hl",
      exit: { timestamp: "2026-10-01T09:30:00.000Z", trigger: "HOLDING_LIMIT", basis: "CURRENT_QUOTE", priceAsOf: null, legBids: [], exitPremium: 120.05, exitCosts: null, notes: [], valuationStatus: "MANUAL_ENTRY_CHECKED", staleReference: null, priceProvenance: "MANUAL_USER_ENTRY", sessionsSource: "USER_PROVIDED" } as Any as PaperTradeRecord["exit"],
      realizedPnl: pnl,
    }), { priceQuality: { level: "MANUAL_ENTRY_CHECKED", flags: ["SESSION_COUNT_USER_PROVIDED"], warnings: ["The completed-session count was entered by the user; there is no trading calendar."] } }));
    expect(await screen.findByText(/session count entered by you/i)).toBeInTheDocument();
  });
});

describe("A7 / A12: expired and pending states stop normal actions", () => {
  it("an open trade past the cutoff: says it expired at 15:30 IST, hides Monitor and Exit, keeps the safety check", async () => {
    await show(withView(makeTrade("PAPER_OPEN"), { expiryStatus: { status: "EXPIRED_PENDING_CLOSURE", cutoff: "2026-10-06T15:30:00+05:30" } }));
    expect(await screen.findByText(/expired at 15:30 IST on 2026-10-06/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Exit: CE 22900 bid")).toBeNull();
    expect(screen.queryByRole("button", { name: "Record monitor update" })).toBeNull();
    expect(screen.getByRole("button", { name: "Run safety check" })).toBeInTheDocument();
  });

  it("an expired review cannot be confirmed: the confirmation form is replaced by an explanation", async () => {
    await show(withView(makeTrade("PAPER_REVIEW"), { expiryStatus: { status: "EXPIRED_REVIEW", cutoff: "2026-10-06T15:30:00+05:30" } }));
    expect(await screen.findByText(/cannot be confirmed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm paper trade" })).toBeNull();
  });

  it("a 409 CONTRACT_EXPIRED reply is shown and the trade stays open", async () => {
    const open = withView(makeTrade("PAPER_OPEN"));
    await show(open, { [`POST /api/paper/trades/${open.tradeId}/exit`]: () => ({ status: 409, body: { error: "CONTRACT_EXPIRED", message: "The contract passed its paper-safety cutoff (15:30 IST on 2026-10-06). Run the expiry closure.", details: [] } }) });
    await screen.findByLabelText("Exit: CE 22900 ask");
    fireEvent.click(screen.getByRole("button", { name: "Exit paper trade" }));
    expect(await screen.findByText(/Run the expiry closure/)).toBeInTheDocument();
    expect(screen.getAllByText("PAPER_OPEN").length).toBeGreaterThan(0);
  });
});

describe("A10: price quality is visible in the list and the detail", () => {
  const legacy = withView(makeTrade("PAPER_EXITED", {
    tradeId: "pt_legacy_q",
    exit: { timestamp: "2026-10-01T09:30:00Z", trigger: "USER_EXIT", basis: "CURRENT_QUOTE", priceAsOf: null, legBids: [], exitPremium: 120.05, exitCosts: null, notes: [], valuationStatus: "EXECUTABLE_QUOTE", staleReference: null },
    realizedPnl: pnl,
  }), { priceQuality: { level: "UNVERIFIED_LEGACY", flags: ["ASK_AND_PRICE_AGE_NOT_CHECKED"], warnings: ["Recorded before Phase 1B.2: the ask and the price entry time were not checked."] }, expiryStatus: { status: "CLOSED", cutoff: "2026-10-06T15:30:00+05:30" } });

  it("the history list shows the quality level next to the P&L", async () => {
    stubApi({ "GET /api/paper/trades": () => ({ body: { trades: [legacy] } }) });
    at("/paper-trading");
    fireEvent.click(await screen.findByRole("tab", { name: "History" }));
    expect(await screen.findByText("UNVERIFIED_LEGACY")).toBeInTheDocument();
  });

  it("the detail shows the quality warnings", async () => {
    await show(legacy);
    expect(await screen.findByText(/the ask and the price entry time were not checked/)).toBeInTheDocument();
  });

  it("the open-trades list says when the unrealized P&L was recorded", async () => {
    const t = withView(makeTrade("PAPER_OPEN", { lastMonitor: { asOf: "2026-09-28T11:00:00Z", legs: [], dataStatus: "VALID", dataReasons: [], currentExitPremium: 120.05, unrealized: pnl, currentRisk: risk("LOW"), carriedFromEntry: [] } }));
    stubApi({ "GET /api/paper/trades": () => ({ body: { trades: [t] } }) });
    at("/paper-trading");
    expect(await screen.findByText(/recorded 2026-09-28T11:00:00Z/)).toBeInTheDocument();
  });
});

describe("M1: an unrealized P&L read after the cutoff is shown as a historical snapshot, never a current valuation", () => {
  const T = "2026-10-05T05:00:00.000Z";
  const monitored = (pq: Any, status: string) =>
    withView(makeTrade("PAPER_OPEN", {
      tradeId: "pt_snap",
      lastMonitor: { asOf: T, legs: [], dataStatus: "VALID", dataReasons: [], currentExitPremium: 120.05, unrealized: pnl, currentRisk: risk("LOW"), carriedFromEntry: [] },
    }), { priceQuality: pq, expiryStatus: { status, cutoff: "2026-10-06T15:30:00+05:30" } });

  it("with the server's UNREALIZED_SNAPSHOT_AFTER_CUTOFF flag: labelled historical, 'at that time', and the list says so", async () => {
    await show(monitored({
      level: "NO_PRICE",
      flags: ["UNREALIZED_SNAPSHOT_AFTER_CUTOFF"],
      warnings: ["The contract has reached its provisional 15:30 IST paper-safety cutoff. The unrealized P&L shown is a historical snapshot, not a current or executable valuation."],
      note: `There is no current price: … recorded by the server at ${T} …`,
    }, "EXPIRED_PENDING_CLOSURE"));
    expect(await screen.findByText(/Unrealized P&L \(historical snapshot from before the expiry cutoff; not a current or executable valuation\)/)).toBeInTheDocument();
    expect(screen.getByText(/Exit premium at that time/)).toBeInTheDocument();
    expect(screen.queryByText(/Exit premium now/)).toBeNull();
    expect(screen.getByText(/historical snapshot \(before expiry cutoff\); not a current valuation/)).toBeInTheDocument();
    expect(document.querySelector('[data-price-quality="NO_PRICE"]')).not.toBeNull();
  });

  it("without the flag (before the cutoff) the existing wording is unchanged", async () => {
    await show(monitored({ level: "MANUAL_ENTRY_CHECKED", flags: [], warnings: [], note: "Valued from prices entered manually." }, "BEFORE_CUTOFF"));
    expect(await screen.findByText(/Exit premium now/)).toBeInTheDocument();
    expect(screen.queryByText(/historical snapshot/)).toBeNull();
  });
});
