import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKET_DISPLAY_NAMES, MARKET_IDS } from "@nsest/core/contracts";
import type { MarketsResponse } from "@nsest/core/contracts";
import { App } from "../src/App";
import { RiskBadge } from "../src/components/RiskBadge";


// Stubbed responses mimic THIS project's own /api shape only. They are test fixtures,
// not market data, and are never presented as live data.
const marketsFixture: MarketsResponse = {
  markets: MARKET_IDS.map((marketId) => ({
    marketId,
    displayName: MARKET_DISPLAY_NAMES[marketId],
    category: marketId === "GOLD" || marketId === "SILVER" || marketId === "CRUDEOIL" ? "COMMODITY" : "INDEX",
    status: "NOT_CONFIGURED",
    reason: "fixture reason",
    requiresExplicitResolution: marketId === "SMALLCAP",
  })),
};

function stubApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/api/markets")) return new Response(JSON.stringify(marketsFixture), { status: 200 });
      if (url.endsWith("/api/health")) {
        return new Response(
          JSON.stringify({ status: "ok", phase: "1A", brokerProvider: "none", brokerConnected: false, liveOrdersEnabled: false }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }),
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(stubApi);
afterEach(() => vi.unstubAllGlobals());

describe("application shell", () => {
  it("shows all six sidebar sections", () => {
    renderAt("/");
    const nav = screen.getByRole("navigation", { name: /main navigation/i });
    for (const label of ["Overview", "Markets", "LONG VOL", "Best Opportunities", "Paper Trading", "Broker"]) {
      expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("Broker page says Not connected", () => {
    renderAt("/broker");
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText(/Not available in Phase 1A/i)).toBeInTheDocument();
  });

  it("Markets page lists all six markets as NOT_CONFIGURED", async () => {
    renderAt("/markets");
    expect(await screen.findByText("BANK NIFTY")).toBeInTheDocument();
    expect(screen.getByText("SMALL CAP")).toBeInTheDocument();
    expect(screen.getByText("CRUDE OIL")).toBeInTheDocument();
    expect(screen.getAllByText("NOT_CONFIGURED")).toHaveLength(6);
  });

  it("LONG VOL page offers all six markets in a disabled selector", () => {
    renderAt("/long-vol");
    const select = screen.getByLabelText("Market");
    expect(select).toBeDisabled();
    for (const name of ["NIFTY", "BANK NIFTY", "SMALL CAP", "GOLD", "SILVER", "CRUDE OIL"]) {
      expect(within(select).getByRole("option", { name })).toBeInTheDocument();
    }
    expect(screen.getByText(/Not available in Phase 1A/i)).toBeInTheDocument();
  });

  it("Best Opportunities shows a disabled ALL/LOW/MEDIUM/HIGH risk filter, ALL selected", () => {
    renderAt("/best-opportunities");
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(["ALL", "LOW", "MEDIUM", "HIGH"]);
    for (const radio of radios) expect(radio).toBeDisabled();
    expect(screen.getByRole("radio", { name: "ALL" })).toBeChecked();
  });

  it("Paper Trading has Active and Archived (Legacy) tabs with empty states", () => {
    renderAt("/paper-trading");
    expect(screen.getByRole("tab", { name: "Active" })).toBeInTheDocument();
    expect(screen.getByText("No active paper trades.")).toBeInTheDocument();
    screen.getByRole("tab", { name: "Archived (Legacy)" }).click();
    return screen.findByText(/does not import or read any legacy trade records/i);
  });

  it("Overview reports the API status from /api/health", async () => {
    renderAt("/");
    expect(await screen.findByText("NOT_CONNECTED")).toBeInTheDocument();
    expect(screen.getByText("DISABLED")).toBeInTheDocument();
  });

  it("Overview explains clearly when the API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    renderAt("/");
    expect(await screen.findByRole("alert")).toHaveTextContent(/API not reachable/i);
  });
});

describe("RiskBadge", () => {
  it("shows text for null: Insufficient risk data", () => {
    render(<RiskBadge level={null} />);
    expect(screen.getByText("Insufficient risk data")).toBeInTheDocument();
  });

  it("shows the level as text for LOW, MEDIUM and HIGH (never colour alone)", () => {
    for (const level of ["LOW", "MEDIUM", "HIGH"] as const) {
      const { unmount } = render(<RiskBadge level={level} />);
      expect(screen.getByText(level)).toBeInTheDocument();
      unmount();
    }
  });
});
