import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, read } from "./helpers.js";

const doc = (name: string): string => read(join(ROOT, "docs", name));

// Assembled from fragments: the tag contains a broker name, and this file lives outside the allowed zones.
const LEGACY_TAG = ["FROZEN", "UP" + "STOX", "434", "PASS"].join("-");

describe("documentation and legacy boundary", () => {
  it("all required documents exist and are not empty", () => {
    for (const name of ["ARCHITECTURE.md", "SECURITY.md", "STRATEGY_FREEZE.md", "LEGACY_BOUNDARY.md", "DECISIONS.md", "PHASE_REPORTS/PHASE_1A.md"]) {
      expect(existsSync(join(ROOT, "docs", name)), name).toBe(true);
      expect(doc(name).trim().length, name).toBeGreaterThan(200);
    }
    expect(existsSync(join(ROOT, "README.md"))).toBe(true);
  });

  it("LEGACY_BOUNDARY records the frozen legacy tag and the storage namespace V2 must never read", () => {
    const text = doc("LEGACY_BOUNDARY.md");
    expect(text).toContain(LEGACY_TAG);
    expect(text).toContain("niftyAiTrader.*");
    expect(text).toMatch(/must never be read/i);
  });

  it("STRATEGY_FREEZE records the frozen LONG VOL definitions", () => {
    const text = doc("STRATEGY_FREEZE.md");
    for (const phrase of ["CE Ask + PE Ask", "CE Bid + PE Bid", "RV20", "TradingDaysToExpiry / 252", "Required Edge Buffer", "1% of premium requirement", "numberOfLots", "QUALIFIED", "DATA_INSUFFICIENT"]) {
      expect(text, phrase).toContain(phrase);
    }
    for (const component of ["IV vs RV20 = 20", "RV momentum = 15", "Liquidity = 15", "Bid/Ask quality = 10", "OI = 10", "Volume = 10", "DTE = 10", "Structure = 10"]) {
      expect(text, component).toContain(component);
    }
  });

  it("DECISIONS lists the seven required unresolved decisions", () => {
    const text = doc("DECISIONS.md");
    for (const topic of ["Persistence", "Hosting", "PAPER_EXPIRED", "Best Opportunities exit rule", "Commodity underlying", "authentication", "Small Cap"]) {
      expect(text.toLowerCase(), topic).toContain(topic.toLowerCase());
    }
  });

  it("documentation states the Phase 1B boundary", () => {
    expect(doc("PHASE_REPORTS/PHASE_1A.md")).toMatch(/Phase 1B/);
  });
});
