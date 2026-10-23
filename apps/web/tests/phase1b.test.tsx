import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperTradeRecord } from "@nsest/core/contracts";
import { App } from "../src/App";
import { matchesRiskFilter } from "../src/riskFilter";
import { assessed, makeTrade, risk, stubApi } from "./fixtures";
import type { Call } from "./fixtures";

afterEach(() => vi.unstubAllGlobals());

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const setField = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const posts = (calls: Call[], suffix: string) => calls.filter((c) => c.method === "POST" && c.path.endsWith(suffix));

describe("LONG VOL: manual candidate -> assess -> review (never auto-open)", () => {
  it("assesses the typed candidate, shows entry premium, capital and risk, and opens nothing", async () => {
    const calls = stubApi({ "POST /api/paper/assess": () => ({ body: assessed("LOW") }) });
    at("/long-vol");
    click(/Fill with example numbers/);
    click("Assess candidate");
    expect(await screen.findByText("₹120.75")).toBeInTheDocument();
    expect(screen.getByText("LOW")).toBeInTheDocument();
    expect(screen.getByText("CANDIDATE")).toBeInTheDocument();
    const sent = posts(calls, "/assess")[0]?.body as { source: string; legs: Array<{ optionType: string; strike: number; quote: { bid: number; ask: number } }>; dataSource: string };
    expect(sent.source).toBe("LONG_VOL");
    expect(sent.dataSource).toBe("MANUAL");
    expect(sent.legs.map((l) => [l.optionType, l.strike, l.quote.bid, l.quote.ask])).toEqual([["CE", 22900, 69, 69.8], ["PE", 22800, 50.2, 50.95]]);
    expect(posts(calls, "/review")).toHaveLength(0);
    expect(posts(calls, "/confirm")).toHaveLength(0);
  });

  it("labels manual entry as NOT live market data", () => {
    at("/long-vol");
    expect(screen.getByText(/not live market data/i)).toBeInTheDocument();
  });

  it("a typo in a number is sent as typed so the server rejects it; it is never silently dropped", async () => {
    const calls = stubApi({ "POST /api/paper/assess": () => ({ status: 400, body: { error: "INVALID_REQUEST", message: "The request is not valid.", details: ["legs[0].quote.bid must be a finite number or null"] } }) });
    at("/long-vol");
    click(/Fill with example numbers/);
    setField("CE bid", "6o9");
    click("Assess candidate");
    expect(await screen.findByRole("alert")).toHaveTextContent("legs[0].quote.bid must be a finite number or null");
    expect((posts(calls, "/assess")[0]?.body as { legs: Array<{ quote: { bid: unknown } }> }).legs[0]?.quote.bid).toBe("6o9");
  });

  it("Review is an explicit click: it stores a PAPER_REVIEW trade and says it is NOT a position yet", async () => {
    const calls = stubApi({
      "POST /api/paper/assess": () => ({ body: assessed("LOW") }),
      "POST /api/paper/review": () => ({ status: 201, body: makeTrade("PAPER_REVIEW") }),
    });
    at("/long-vol");
    click(/Fill with example numbers/);
    click("Assess candidate");
    await screen.findByText("₹120.75");
    expect(posts(calls, "/review")).toHaveLength(0);
    click("Review this candidate");
    expect(await screen.findByText(/It is NOT a position yet/)).toBeInTheDocument();
    expect(posts(calls, "/review")).toHaveLength(1);
    expect(posts(calls, "/confirm")).toHaveLength(0);
    expect(screen.getByRole("link", { name: /open Paper Trading to confirm/ })).toBeInTheDocument();
  });

  it("a candidate with no executable entry shows DATA_INSUFFICIENT with its reasons and cannot be reviewed", async () => {
    stubApi({ "POST /api/paper/assess": () => ({ body: assessed(null, "DATA_INSUFFICIENT") }) });
    at("/long-vol");
    click(/Fill with example numbers/);
    click("Assess candidate");
    expect(await screen.findByText("DATA_INSUFFICIENT")).toBeInTheDocument();
    expect(screen.getByText(/CE 22900: INVALID_ASK/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review this candidate" })).toBeDisabled();
    expect(screen.getByText("Insufficient risk data")).toBeInTheDocument();
  });
});

describe("Best Opportunities: single leg and the risk filter", () => {
  it("offers SINGLE_CALL / SINGLE_PUT and shows only the leg that exists", () => {
    at("/best-opportunities");
    const structure = screen.getByLabelText("Structure");
    expect(within(structure).getAllByRole("option").map((o) => o.textContent)).toEqual(["SINGLE_CALL", "SINGLE_PUT"]);
    expect(screen.getByLabelText("CE strike")).toBeInTheDocument();
    expect(screen.queryByLabelText("PE strike")).toBeNull();
    fireEvent.change(structure, { target: { value: "SINGLE_PUT" } });
    expect(screen.queryByLabelText("CE strike")).toBeNull();
    expect(screen.getByLabelText("PE strike")).toBeInTheDocument();
  });

  it("the filter is disabled until a candidate exists, then filters rows: ALL / LOW / MEDIUM / HIGH", async () => {
    const levels = ["LOW", "HIGH", null] as const;
    let n = 0;
    stubApi({ "POST /api/paper/assess": () => ({ body: assessed(levels[n++] ?? null, levels[n - 1] === null ? "DATA_INSUFFICIENT" : "CANDIDATE") }) });
    at("/best-opportunities");
    for (const r of screen.getAllByRole("radio")) expect(r).toBeDisabled();
    for (let i = 0; i < 3; i++) {
      click(/Fill with example numbers/);
      click("Assess candidate");
      await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(i + 2));
    }
    for (const r of screen.getAllByRole("radio")) expect(r).toBeEnabled();
    const rows = () => screen.getAllByRole("row").length - 1;
    expect(rows()).toBe(3); // ALL, including the unknown-risk one
    fireEvent.click(screen.getByRole("radio", { name: "HIGH" }));
    expect(rows()).toBe(1);
    expect(screen.getByText("2 candidate(s) hidden by the risk filter.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "LOW" }));
    expect(rows()).toBe(1);
    fireEvent.click(screen.getByRole("radio", { name: "MEDIUM" }));
    expect(screen.getByText("No candidates assessed yet.")).toBeInTheDocument(); // nothing is MEDIUM; unknown is NOT shown as MEDIUM
    fireEvent.click(screen.getByRole("radio", { name: "ALL" }));
    expect(rows()).toBe(3);
    expect(screen.getByText("Insufficient risk data")).toBeInTheDocument();
  });

  it("matchesRiskFilter: ALL shows everything; a level shows only itself; unknown only under ALL", () => {
    const levels = ["LOW", "MEDIUM", "HIGH", null] as const;
    for (const level of levels) expect(matchesRiskFilter(level, "ALL")).toBe(true);
    for (const f of ["LOW", "MEDIUM", "HIGH"] as const) {
      for (const level of levels) expect(matchesRiskFilter(level, f)).toBe(level === f);
    }
  });
});

const fillFreshQuotes = () => {
  setField("Confirm paper trade: CE 22900 bid", "70");
  setField("Confirm paper trade: CE 22900 ask", "70.5");
  setField("Confirm paper trade: PE 22800 bid", "50.6");
  setField("Confirm paper trade: PE 22800 ask", "51.25");
};

describe("Paper Trading: review -> confirm", () => {
  const list = (trades: PaperTradeRecord[]) => ({ "GET /api/paper/trades": () => ({ body: { trades } }) });

  it("selecting a trade in review never confirms it; the button stays disabled until the checkbox is ticked", async () => {
    const t = makeTrade("PAPER_REVIEW");
    const calls = stubApi({ ...list([t]), [`GET /api/paper/trades/${t.tradeId}`]: () => ({ body: { trade: t, events: [] } }), [`POST /api/paper/trades/${t.tradeId}/confirm`]: () => ({ body: makeTrade("PAPER_OPEN") }) });
    at("/paper-trading");
    fireEvent.click(await screen.findByRole("button", { name: `Open ${t.tradeId}` }));
    const confirm = await screen.findByRole("button", { name: "Confirm paper trade" });
    expect(confirm).toBeDisabled();
    expect(posts(calls, "/confirm")).toHaveLength(0);
    fireEvent.click(screen.getByLabelText("I confirm this paper trade"));
    expect(confirm).toBeEnabled();
    expect(posts(calls, "/confirm")).toHaveLength(0); // ticking is not confirming
    fillFreshQuotes();
    fireEvent.click(confirm);
    await waitFor(() => expect(posts(calls, "/confirm")).toHaveLength(1));
    expect(posts(calls, "/confirm")[0]?.body).toMatchObject({ confirmed: true });
  });

  // Phase 1B.1 (D1): the confirmation carries FRESH prices for the exact legs, each with the time it was typed.
  it("the confirmation sends fresh bid/ask quotes for the EXACT stored legs, each stamped with when it was typed", async () => {
    const t = makeTrade("PAPER_REVIEW");
    const calls = stubApi({ ...list([t]), [`GET /api/paper/trades/${t.tradeId}`]: () => ({ body: { trade: t, events: [] } }), [`POST /api/paper/trades/${t.tradeId}/confirm`]: () => ({ body: makeTrade("PAPER_OPEN") }) });
    at("/paper-trading");
    fireEvent.click(await screen.findByRole("button", { name: `Open ${t.tradeId}` }));
    await screen.findByRole("button", { name: "Confirm paper trade" });
    const before = Date.now();
    fillFreshQuotes();
    fireEvent.click(screen.getByLabelText("I confirm this paper trade"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm paper trade" }));
    await waitFor(() => expect(posts(calls, "/confirm")).toHaveLength(1));
    const body = posts(calls, "/confirm")[0]?.body as { confirmed: boolean; quotes: Array<{ instrument: { id: string }; bid: number; ask: number; asOf: string }> };
    expect(body.confirmed).toBe(true);
    expect(body.quotes.map((q) => [q.instrument.id, q.bid, q.ask])).toEqual([
      ["NIFTY|2026-10-06|CE|22900", 70, 70.5],
      ["NIFTY|2026-10-06|PE|22800", 50.6, 51.25],
    ]);
    for (const q of body.quotes) {
      expect(Date.parse(q.asOf)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(q.asOf)).toBeLessThanOrEqual(Date.now());
    }
    expect(screen.getByText(/at most 60 seconds old/)).toBeInTheDocument();
  });

  it("a stale-quote refusal (QUOTE_NOT_FRESH) is shown, and the trade stays in review", async () => {
    const t = makeTrade("PAPER_REVIEW");
    stubApi({
      ...list([t]),
      [`GET /api/paper/trades/${t.tradeId}`]: () => ({ body: { trade: t, events: [] } }),
      [`POST /api/paper/trades/${t.tradeId}/confirm`]: () => ({ status: 422, body: { error: "QUOTE_NOT_FRESH", message: "Entry quotes must be at most 60 s old by server time. The trade stays in PAPER_REVIEW.", details: ["CE 22900: quote is older than 60 s"], trade: t } }),
    });
    at("/paper-trading");
    fireEvent.click(await screen.findByRole("button", { name: `Open ${t.tradeId}` }));
    await screen.findByRole("button", { name: "Confirm paper trade" });
    fillFreshQuotes();
    fireEvent.click(screen.getByLabelText("I confirm this paper trade"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm paper trade" }));
    expect(await screen.findByText(/at most 60 s old by server time/)).toBeInTheDocument();
    expect(screen.getByText("CE 22900: quote is older than 60 s")).toBeInTheDocument();
  });

  it("shows entry premium (sum of asks), capital and the capital gate during review", async () => {
    const t = makeTrade("PAPER_REVIEW");
    stubApi({ ...list([t]), [`GET /api/paper/trades/${t.tradeId}`]: () => ({ body: { trade: t, events: [] } }) });
    at("/paper-trading");
    fireEvent.click(await screen.findByRole("button", { name: `Open ${t.tradeId}` }));
    expect(await screen.findByText(/Entry premium \(sum of asks\)/)).toBeInTheDocument();
    expect(screen.getByText("₹120.75")).toBeInTheDocument();
    expect(screen.getByText("PASS")).toBeInTheDocument();
    expect(screen.getByText(/Nothing is open yet/)).toBeInTheDocument();
  });
});

describe("Paper Trading: open trade", () => {
  const open = makeTrade("PAPER_OPEN", { lastMonitor: { asOf: "2026-09-28T11:00:00Z", legs: [], dataStatus: "VALID", dataReasons: [], currentExitPremium: 120.05, unrealized: { status: "VALID", reason: null, grossPnl: -45.5, netPnl: null, netStatus: "COSTS_UNAVAILABLE" }, currentRisk: risk("HIGH"), carriedFromEntry: [] } });
  const setup = (trade: PaperTradeRecord = open, extra: Record<string, () => { status?: number; body: unknown }> = {}) => {
    const calls = stubApi({
      "GET /api/paper/trades": () => ({ body: { trades: [trade] } }),
      [`GET /api/paper/trades/${trade.tradeId}`]: () => ({ body: { trade, events: [{ sequence: 1, timestamp: "t", type: "TRADE_OPENED", tradeId: trade.tradeId, fromState: "PAPER_REVIEW", toState: "PAPER_OPEN", payload: {} }] } }),
      ...extra,
    });
    at("/paper-trading");
    return calls;
  };
  const openIt = async (trade = open) => fireEvent.click(await screen.findByRole("button", { name: `Open ${trade.tradeId}` }));

  it("shows ENTRY risk and CURRENT risk separately (LOW at entry, HIGH now)", async () => {
    setup();
    await openIt();
    const panel = (title: string): HTMLElement => {
      const el = screen.getAllByText(title).map((e) => e.closest(".riskpanel")).find((p) => p !== null);
      if (!el) throw new Error(`no risk panel titled ${title}`);
      return el as HTMLElement;
    };
    await screen.findByLabelText("Exit: CE 22900 bid"); // the detail panel has rendered
    const entryPanel = panel("Entry risk");
    const currentPanel = panel("Current risk");
    expect(within(entryPanel).getByText("LOW")).toBeInTheDocument();
    expect(within(currentPanel).getByText("HIGH")).toBeInTheDocument();
  });

  it("shows unrealized gross P&L, and states that net is unavailable without costs", async () => {
    setup();
    await openIt();
    expect(await screen.findByText(/gross ₹-45\.50, net unavailable \(costs not provided\)/)).toBeInTheDocument();
  });

  it("shows an unavailable P&L as DATA_INSUFFICIENT, never as zero", async () => {
    const t = makeTrade("PAPER_OPEN", { lastMonitor: { asOf: "t", legs: [], dataStatus: "DATA_INSUFFICIENT", dataReasons: ["x"], currentExitPremium: null, unrealized: { status: "DATA_INSUFFICIENT", reason: "No valid executable exit price (every leg needs a positive bid). P&L is not estimated.", grossPnl: null, netPnl: null, netStatus: "DATA_INSUFFICIENT" }, currentRisk: risk(null), carriedFromEntry: [] } });
    setup(t);
    await openIt(t);
    expect(await screen.findByText(/Unavailable \(DATA_INSUFFICIENT\)/)).toBeInTheDocument();
    expect(screen.queryByText(/₹0\.00/)).toBeNull();
  });

  it("an exit with blank bids is sent as no price (never zero, never an LTP) and the refusal is shown; the trade stays open", async () => {
    const calls = setup(open, { [`POST /api/paper/trades/${open.tradeId}/exit`]: () => ({ status: 422, body: { error: "DATA_INSUFFICIENT", message: "No valid executable bid for every leg. The trade stays PAPER_OPEN; no exit price is invented.", details: ["NIFTY|2026-10-06|CE|22900: bid is missing or not positive (LTP is never used instead)"] } }) });
    await openIt();
    fireEvent.click(await screen.findByRole("button", { name: "Exit paper trade" }));
    const alert = await screen.findByText(/no exit price is invented/);
    expect(alert).toBeInTheDocument();
    expect(screen.getByText(/LTP is never used instead/)).toBeInTheDocument();
    const sent = posts(calls, "/exit")[0]?.body as { quotes: Array<Record<string, unknown>> };
    expect(sent.quotes.map((q) => q["bid"])).toEqual([null, null]);
    expect(sent.quotes.every((q) => !("ltp" in q))).toBe(true);
    expect(screen.getAllByText("PAPER_OPEN").length).toBeGreaterThan(0);
  });

  it("monitor and exit send the EXACT stored instrument identities with the typed bids", async () => {
    const calls = setup(open, { [`POST /api/paper/trades/${open.tradeId}/exit`]: () => ({ body: open }) });
    await openIt();
    fireEvent.change(await screen.findByLabelText("Exit: CE 22900 bid"), { target: { value: "66.05" } });
    setField("Exit: PE 22800 bid", "54");
    fireEvent.click(await screen.findByRole("button", { name: "Exit paper trade" }));
    await waitFor(() => expect(posts(calls, "/exit")).toHaveLength(1));
    expect(posts(calls, "/exit")[0]?.body).toEqual({
      quotes: [
        { instrument: { provider: "manual", id: "NIFTY|2026-10-06|CE|22900" }, bid: 66.05 },
        { instrument: { provider: "manual", id: "NIFTY|2026-10-06|PE|22800" }, bid: 54 },
      ],
      exitCosts: null,
    });
  });

  // Phase 1B.1 (D3): the safety check no longer asks the user for a date. The server clock decides expiry.
  it("a safety check sends completed sessions but NO client date (server time decides), and reports when no closure applies", async () => {
    const calls = setup(open, { [`POST /api/paper/trades/${open.tradeId}/safety-check`]: () => ({ body: { decision: { action: "NONE", reasons: [], notEvaluated: ["HOLDING_LIMIT not evaluated: completedSessions was not supplied (no trading calendar exists yet)."] }, trade: open } }) });
    await openIt();
    expect(screen.queryByLabelText(/Safety check: As of/)).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Run safety check" }));
    expect(await screen.findByText(/No safety closure applies/)).toBeInTheDocument();
    expect(screen.getByText(/HOLDING_LIMIT not evaluated/)).toBeInTheDocument();
    const body = posts(calls, "/safety-check")[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ completedSessions: null });
    expect(body).not.toHaveProperty("asOf");
  });
});

describe("Paper Trading: history, journal, export", () => {
  it("History shows an expired trade with no price as DATA_INSUFFICIENT (basis NONE) and a rejected candidate with its reasons", async () => {
    const expired = makeTrade("PAPER_EXPIRED", {
      tradeId: "pt_expired",
      exit: { timestamp: "2026-10-07", trigger: "EXPIRY", basis: "NONE", priceAsOf: null, legBids: [], exitPremium: null, exitCosts: null, notes: ["No valid executable bid was supplied and none was ever recorded."] },
      realizedPnl: { status: "DATA_INSUFFICIENT", reason: "No valid executable exit price (every leg needs a positive bid). P&L is not estimated.", grossPnl: null, netPnl: null, netStatus: "DATA_INSUFFICIENT" },
    });
    const rejected = makeTrade("DATA_INSUFFICIENT", { tradeId: "pt_rejected" });
    stubApi({
      "GET /api/paper/trades": () => ({ body: { trades: [expired, rejected] } }),
      "GET /api/paper/trades/pt_expired": () => ({ body: { trade: expired, events: [] } }),
      "GET /api/paper/trades/pt_rejected": () => ({ body: { trade: rejected, events: [] } }),
    });
    at("/paper-trading");
    fireEvent.click(await screen.findByRole("tab", { name: "History" }));
    expect(await screen.findByText("PAPER_EXPIRED")).toBeInTheDocument();
    expect(screen.getAllByText("DATA_INSUFFICIENT").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Open pt_expired" }));
    expect(await screen.findByText(/price basis NONE/)).toBeInTheDocument();
    expect(screen.getAllByText(/Unavailable \(DATA_INSUFFICIENT\)/).length).toBeGreaterThanOrEqual(2); // list row and detail
    fireEvent.click(screen.getByRole("button", { name: "Open pt_rejected" }));
    expect(await screen.findByText(/this candidate had no executable entry price and was not opened/)).toBeInTheDocument();
  });

  // Phase 1B.1 (D2): an old monitored bid is shown as reference only; valuation and P&L stay DATA_INSUFFICIENT.
  it("an expiry without current bids shows valuation DATA_INSUFFICIENT and the old monitored bid as reference only", async () => {
    const expired = makeTrade("PAPER_EXPIRED", {
      tradeId: "pt_stale",
      exit: {
        timestamp: "2026-10-07T03:50:00Z", trigger: "EXPIRY", basis: "NONE", priceAsOf: null, legBids: [], exitPremium: null, exitCosts: null,
        notes: ["No valid executable bid for every leg at closure, so there is no exit price and P&L is DATA_INSUFFICIENT."],
        valuationStatus: "DATA_INSUFFICIENT",
        staleReference: { asOf: "2026-09-29T10:00:00+05:30", legBids: [], exitPremium: 120.05 },
      },
      realizedPnl: { status: "DATA_INSUFFICIENT", reason: "No valid executable exit price (every leg needs a positive bid). P&L is not estimated.", grossPnl: null, netPnl: null, netStatus: "DATA_INSUFFICIENT" },
    });
    stubApi({
      "GET /api/paper/trades": () => ({ body: { trades: [expired] } }),
      "GET /api/paper/trades/pt_stale": () => ({ body: { trade: expired, events: [] } }),
    });
    at("/paper-trading");
    fireEvent.click(await screen.findByRole("tab", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open pt_stale" }));
    expect(await screen.findByText(/valuation DATA_INSUFFICIENT/)).toBeInTheDocument();
    const ref = screen.getByText(/Reference only \(not an exit price, not used for P&L\)/);
    expect(ref).toHaveTextContent("2026-09-29T10:00:00+05:30");
    expect(ref).toHaveTextContent("₹120.05");
    expect(screen.getAllByText(/Unavailable \(DATA_INSUFFICIENT\)/).length).toBeGreaterThanOrEqual(1);
  });

  it("Journal tab lists events and offers the JSON export with the durability warning", async () => {
    stubApi({
      "GET /api/paper/trades": () => ({ body: { trades: [] } }),
      "GET /api/paper/journal": () => ({ body: { events: [{ sequence: 1, timestamp: "2026-09-28T10:00:00Z", type: "REVIEW_STARTED", tradeId: "pt_1", fromState: "CANDIDATE", toState: "PAPER_REVIEW", payload: {} }] } }),
    });
    at("/paper-trading");
    fireEvent.click(screen.getByRole("tab", { name: "Journal" }));
    expect(await screen.findByText("REVIEW_STARTED")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Export journal/ });
    // The export link uses the same API base as every other request (VITE_API_BASE_URL, empty = same origin).
    // That base comes from the environment (for example a local apps/web/.env), so the expectation follows it.
    // Both configurations are pinned deterministically in "journal export URL" below.
    expect(link.getAttribute("href")).toBe(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/paper/export`);
    expect(link).toHaveAttribute("download");
    expect(screen.getByText(/NOT guaranteed durable storage/)).toBeInTheDocument();
  });

  it("the Archived (Legacy) tab still imports nothing", () => {
    stubApi({});
    at("/paper-trading");
    fireEvent.click(screen.getByRole("tab", { name: "Archived (Legacy)" }));
    expect(screen.getByText(/does not import or read any legacy trade records/)).toBeInTheDocument();
  });
});

// The API base is read once, when apiClient is first imported. Each case therefore stubs the variable, resets the module
// registry and imports a fresh copy, so the result does not depend on any local .env file. afterEach restores the
// environment and the module registry even when an assertion fails.
describe("journal export URL follows the configured API base (exportUrl)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const exportUrlWithBase = async (base: string): Promise<string> => {
    vi.resetModules();
    vi.stubEnv("VITE_API_BASE_URL", base);
    const { exportUrl } = await import("../src/apiClient");
    return exportUrl();
  };

  it("an absolute base (local development: API on its own port) gives an absolute export URL", async () => {
    expect(await exportUrlWithBase("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/api/paper/export");
  });

  it("an empty base (same-origin deployment) gives the relative export URL", async () => {
    expect(await exportUrlWithBase("")).toBe("/api/paper/export");
  });
});
