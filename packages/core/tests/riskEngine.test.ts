import { describe, expect, it } from "vitest";
import {
  RISK_LEVEL_CUTOFFS,
  RISK_RULES_VERSION,
  SCORED_FACTORS,
  TOTAL_SCORED_WEIGHT,
  assessRisk,
  bandOf,
  createRiskEngine,
  filterByRisk,
} from "../src/index.js";
import type { RiskEngineInput, RiskFilter, RiskResult } from "../src/index.js";

// Every number here is the one in docs/RISK_ENGINE.md (rules v1.0.0).

/** All twelve scored inputs, each in its LOW band. */
const allLow = (): Record<string, number | string | boolean> => ({
  bidAskSpreadQuality: 1,
  daysToExpiry: 10,
  capitalUtilization: 20,
  maxLossDefined: true,
  liquidityVolume: 6000,
  openInterest: 12000,
  contractLiquidity: 6,
  expectedNetEdgeQuality: 0.1,
  ivRvRelationship: 0.8,
  rvRegime: "RV_ACCELERATING",
  structureType: "STRADDLE",
  distanceFromAtm: 0.5,
});
const as = (o: Record<string, unknown>): RiskEngineInput => o as RiskEngineInput;

/** Worked example A in docs/RISK_ENGINE.md. */
const exampleA = (): Record<string, number | string | boolean> => ({
  ...allLow(),
  bidAskSpreadQuality: 3.0,
  daysToExpiry: 8,
  capitalUtilization: 60,
  expectedNetEdgeQuality: 0.08,
  ivRvRelationship: 1.5,
  structureType: "STRANGLE",
  distanceFromAtm: 2,
});

describe("rule table integrity", () => {
  it("states rules version 1.0.0", () => {
    expect(RISK_RULES_VERSION).toBe("1.0.0");
  });
  it("weights sum to exactly 100", () => {
    expect(TOTAL_SCORED_WEIGHT).toBe(100);
  });
  it("has the three required factors, all critical", () => {
    const required = SCORED_FACTORS.filter((f) => f.required).map((f) => f.field);
    expect(required).toEqual(["bidAskSpreadQuality", "daysToExpiry", "capitalUtilization"]);
    expect(SCORED_FACTORS.filter((f) => f.required).every((f) => f.critical)).toBe(true);
  });
  it("uses equal-thirds cutoffs 34 and 67", () => {
    expect(RISK_LEVEL_CUTOFFS).toEqual({ mediumFrom: 34, highFrom: 67 });
  });
  it("cannot reach a score-only HIGH without a critical factor being HIGH (max 63.0 < 67)", () => {
    const nonCriticalMax = SCORED_FACTORS.filter((f) => !f.critical).reduce((s, f) => s + f.weight * (f.field === "rvRegime" || f.field === "structureType" ? 50 : 100), 0);
    const criticalAtMedium = SCORED_FACTORS.filter((f) => f.critical).reduce((s, f) => s + f.weight * (f.field === "maxLossDefined" ? 0 : 50), 0);
    expect((nonCriticalMax + criticalAtMedium) / TOTAL_SCORED_WEIGHT).toBe(63);
  });
});

describe("band boundaries (docs/RISK_ENGINE.md)", () => {
  const cases: Array<[Parameters<typeof bandOf>[0], unknown, "LOW" | "MEDIUM" | "HIGH" | null]> = [
    ["bidAskSpreadQuality", 0, "LOW"], ["bidAskSpreadQuality", 2.5, "LOW"], ["bidAskSpreadQuality", 2.51, "MEDIUM"],
    ["bidAskSpreadQuality", 5, "MEDIUM"], ["bidAskSpreadQuality", 5.01, "HIGH"], ["bidAskSpreadQuality", -1, null],
    ["daysToExpiry", 0, "HIGH"], ["daysToExpiry", 1, "HIGH"], ["daysToExpiry", 2, "MEDIUM"], ["daysToExpiry", 6, "MEDIUM"],
    ["daysToExpiry", 7, "LOW"], ["daysToExpiry", 30, "LOW"], ["daysToExpiry", 31, "MEDIUM"], ["daysToExpiry", 2.5, null],
    ["capitalUtilization", 50, "LOW"], ["capitalUtilization", 50.01, "MEDIUM"], ["capitalUtilization", 100, "MEDIUM"], ["capitalUtilization", 100.01, "HIGH"],
    ["liquidityVolume", 5000, "LOW"], ["liquidityVolume", 4999, "MEDIUM"], ["liquidityVolume", 2500, "MEDIUM"], ["liquidityVolume", 2499, "HIGH"],
    ["openInterest", 10000, "LOW"], ["openInterest", 9999, "MEDIUM"], ["openInterest", 5000, "MEDIUM"], ["openInterest", 4999, "HIGH"],
    ["contractLiquidity", 5, "LOW"], ["contractLiquidity", 4.99, "MEDIUM"], ["contractLiquidity", 1, "MEDIUM"], ["contractLiquidity", 0.99, "HIGH"],
    ["expectedNetEdgeQuality", 0.05, "LOW"], ["expectedNetEdgeQuality", 0.0499, "MEDIUM"], ["expectedNetEdgeQuality", 0.0001, "MEDIUM"],
    ["expectedNetEdgeQuality", 0, "HIGH"], ["expectedNetEdgeQuality", -0.2, "HIGH"],
    ["ivRvRelationship", 0.99, "LOW"], ["ivRvRelationship", 1, "MEDIUM"], ["ivRvRelationship", 1.99, "MEDIUM"], ["ivRvRelationship", 2, "HIGH"],
    ["rvRegime", "RV_ACCELERATING", "LOW"], ["rvRegime", "RV_DECELERATING", "MEDIUM"], ["rvRegime", "other", null],
    ["structureType", "STRADDLE", "LOW"], ["structureType", "STRANGLE", "MEDIUM"], ["structureType", "SINGLE_CALL", "MEDIUM"],
    ["structureType", "SINGLE_PUT", "MEDIUM"], ["structureType", "IRON_CONDOR", null],
    ["distanceFromAtm", 1, "LOW"], ["distanceFromAtm", 1.01, "MEDIUM"], ["distanceFromAtm", 3, "MEDIUM"], ["distanceFromAtm", 3.01, "HIGH"],
    ["maxLossDefined", true, "LOW"], ["maxLossDefined", false, "HIGH"], ["maxLossDefined", "yes", null],
  ];
  it.each(cases)("%s = %s -> %s", (field, value, expected) => {
    expect(bandOf(field, value)).toBe(expected);
  });
});

describe("risk levels", () => {
  it("LOW: every input in its LOW band -> LOW, score 0, COMPLETE", () => {
    const r = assessRisk(as(allLow()));
    expect(r).toMatchObject({ riskLevel: "LOW", riskScore: 0, riskDataStatus: "COMPLETE" });
  });

  it("LOW: worked example A scores exactly 22.0 and is LOW and COMPLETE", () => {
    expect(assessRisk(as(exampleA()))).toMatchObject({ riskLevel: "LOW", riskScore: 22, riskDataStatus: "COMPLETE" });
  });

  it("MEDIUM: a mixed profile with no HIGH factor scores 46.0 and is MEDIUM", () => {
    const r = assessRisk(as({
      ...allLow(), bidAskSpreadQuality: 3, daysToExpiry: 3, capitalUtilization: 60, liquidityVolume: 3000, openInterest: 6000,
      contractLiquidity: 2, expectedNetEdgeQuality: 0.02, ivRvRelationship: 1.5, rvRegime: "RV_DECELERATING",
      structureType: "STRANGLE", distanceFromAtm: 2,
    }));
    expect(r).toMatchObject({ riskLevel: "MEDIUM", riskScore: 46, riskDataStatus: "COMPLETE" });
  });

  it("HIGH: worked example B - weighted score 31.0 is LOW alone, but a critical HIGH factor escalates to HIGH", () => {
    const r = assessRisk(as({ ...exampleA(), bidAskSpreadQuality: 6 }));
    expect(r.riskScore).toBe(31);
    expect(r.riskLevel).toBe("HIGH");
    expect(r.riskReasons.join("\n")).toMatch(/Escalated to HIGH: critical factor\(s\) banded HIGH: bidAskSpreadQuality/);
  });

  it.each([
    ["bidAskSpreadQuality", 6],
    ["daysToExpiry", 1],
    ["capitalUtilization", 120],
    ["contractLiquidity", 0.5],
    ["maxLossDefined", false],
  ])("each critical factor alone forces HIGH: %s", (field, value) => {
    expect(assessRisk(as({ ...allLow(), [field]: value })).riskLevel).toBe("HIGH");
  });

  it.each([
    ["liquidityVolume", 100],
    ["openInterest", 100],
    ["expectedNetEdgeQuality", -0.1],
    ["ivRvRelationship", 3],
    ["distanceFromAtm", 5],
  ])("a non-critical HIGH factor raises LOW to at least MEDIUM, never to HIGH: %s", (field, value) => {
    const r = assessRisk(as({ ...allLow(), [field]: value }));
    expect(r.riskLevel).toBe("MEDIUM");
    expect(r.riskReasons.join("\n")).toMatch(/Raised to at least MEDIUM/);
  });

  it("expiryProximity <= 1 escalates to HIGH; 2 does not", () => {
    expect(assessRisk(as({ ...allLow(), expiryProximity: 1 })).riskLevel).toBe("HIGH");
    expect(assessRisk(as({ ...allLow(), expiryProximity: 0 })).riskLevel).toBe("HIGH");
    expect(assessRisk(as({ ...allLow(), expiryProximity: 2 })).riskLevel).toBe("LOW");
  });

  it("an invalid expiryProximity is ignored with a warning, not guessed", () => {
    const r = assessRisk(as({ ...allLow(), expiryProximity: "soon" }));
    expect(r.riskLevel).toBe("LOW");
    expect(r.riskWarnings).toContain("Ignored invalid input: expiryProximity");
  });
});

describe("insufficient and partial data (never guessed)", () => {
  it("worked example C: missing daysToExpiry -> level null, score null, INSUFFICIENT", () => {
    const input = exampleA();
    delete input["daysToExpiry"];
    const r = assessRisk(as(input));
    expect(r.riskLevel).toBeNull();
    expect(r.riskScore).toBeNull();
    expect(r.riskDataStatus).toBe("INSUFFICIENT");
    expect(r.riskWarnings[0]).toMatch(/daysToExpiry/);
  });

  it.each(["bidAskSpreadQuality", "daysToExpiry", "capitalUtilization"])("missing required input %s -> INSUFFICIENT", (field) => {
    const input = allLow();
    delete input[field];
    expect(assessRisk(as(input))).toMatchObject({ riskLevel: null, riskScore: null, riskDataStatus: "INSUFFICIENT" });
  });

  it("an empty input is INSUFFICIENT and names all three required inputs", () => {
    const r = assessRisk(as({}));
    expect(r.riskLevel).toBeNull();
    expect(r.riskWarnings[0]).toMatch(/bidAskSpreadQuality, daysToExpiry, capitalUtilization/);
  });

  it("invalid values count as missing: NaN, Infinity, negatives, wrong types, null", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, "3", null, undefined, {}]) {
      expect(assessRisk(as({ ...allLow(), bidAskSpreadQuality: bad })).riskDataStatus, String(bad)).toBe("INSUFFICIENT");
    }
  });

  it("missing optional inputs -> PARTIAL, with a warning, and the score is normalized over what is available", () => {
    const input = exampleA();
    delete input["liquidityVolume"];
    delete input["openInterest"];
    const r = assessRisk(as(input));
    expect(r.riskDataStatus).toBe("PARTIAL");
    expect(r.riskWarnings.join("\n")).toMatch(/Not assessed .*liquidityVolume, openInterest/);
    // weights without volume/OI total 84; the same 2200 weighted points give 26.2
    expect(r.riskScore).toBe(26.2);
    expect(r.riskLevel).toBe("LOW");
  });

  it("an invalid optional input is ignored with a warning and the result is PARTIAL", () => {
    const r = assessRisk(as({ ...allLow(), openInterest: -5 }));
    expect(r.riskDataStatus).toBe("PARTIAL");
    expect(r.riskWarnings.join("\n")).toMatch(/Ignored invalid input\(s\): openInterest/);
  });
});

describe("expectedNetEdgeQuality is a risk input, and nothing more", () => {
  it("changing only expectedNetEdgeQuality from LOW to HIGH moves the score by exactly its weight (10.0)", () => {
    const low = assessRisk(as({ ...allLow(), expectedNetEdgeQuality: 0.1 }));
    const high = assessRisk(as({ ...allLow(), expectedNetEdgeQuality: -0.1 }));
    expect((high.riskScore ?? 0) - (low.riskScore ?? 0)).toBe(10);
    expect(high.riskReasons.join("\n")).toMatch(/expectedNetEdgeQuality = -0.1 -> HIGH/);
  });

  it("is optional: without it the result is PARTIAL, not INSUFFICIENT", () => {
    const input = allLow();
    delete input["expectedNetEdgeQuality"];
    expect(assessRisk(as(input)).riskDataStatus).toBe("PARTIAL");
  });

  it("the engine never receives or returns Expected Net Edge: result has exactly the five risk fields", () => {
    const r = assessRisk(as({ ...allLow(), expectedNetEdge: 999 }));
    expect(Object.keys(r).sort()).toEqual(["riskDataStatus", "riskLevel", "riskReasons", "riskScore", "riskWarnings"]);
  });

  it("a raw expectedNetEdge value passed alongside is ignored: it cannot replace or override anything", () => {
    expect(assessRisk(as({ ...allLow(), expectedNetEdge: 999999 }))).toEqual(assessRisk(as(allLow())));
    expect(assessRisk(as({ ...allLow(), expectedNetEdge: -999999 }))).toEqual(assessRisk(as(allLow())));
  });
});

describe("independence from Score, Status and Capital", () => {
  it("opportunity score and status keys have no effect (no score dependency)", () => {
    const base = assessRisk(as(exampleA()));
    for (const extra of [{ score: 0 }, { score: 100 }, { opportunityScore: 99 }, { status: "QUALIFIED" }, { status: "REJECTED" }, { capitalRequirement: 1 }]) {
      expect(assessRisk(as({ ...exampleA(), ...extra })), JSON.stringify(extra)).toEqual(base);
    }
  });
});

describe("determinism and purity", () => {
  it("returns identical results for identical input", () => {
    expect(assessRisk(as(exampleA()))).toEqual(assessRisk(as(exampleA())));
  });
  it("does not mutate its input", () => {
    const input = Object.freeze(exampleA());
    expect(() => assessRisk(as(input))).not.toThrow();
  });
  it("createRiskEngine implements the frozen RiskEngine contract", () => {
    expect(createRiskEngine().assess(as(exampleA()))).toEqual(assessRisk(as(exampleA())));
  });
});

describe("risk filter ALL / LOW / MEDIUM / HIGH", () => {
  const risk = (riskLevel: RiskResult["riskLevel"]): RiskResult => ({ riskLevel, riskScore: null, riskReasons: [], riskWarnings: [], riskDataStatus: riskLevel ? "COMPLETE" : "INSUFFICIENT" });
  const items = [
    { id: "a", score: 90, expectedNetEdge: 500, risk: risk("HIGH") },
    { id: "b", score: 10, expectedNetEdge: -5, risk: risk("LOW") },
    { id: "c", score: 55, expectedNetEdge: 100, risk: risk(null) },
    { id: "d", score: 70, expectedNetEdge: 300, risk: risk("MEDIUM") },
    { id: "e", score: 20, expectedNetEdge: 50, risk: risk("LOW") },
  ];
  const ids = (f: RiskFilter) => filterByRisk(items, f).map((i) => i.id);

  it("ALL returns everything, including unknown risk, in the original order", () => expect(ids("ALL")).toEqual(["a", "b", "c", "d", "e"]));
  it("LOW returns only LOW", () => expect(ids("LOW")).toEqual(["b", "e"]));
  it("MEDIUM returns only MEDIUM", () => expect(ids("MEDIUM")).toEqual(["d"]));
  it("HIGH returns only HIGH", () => expect(ids("HIGH")).toEqual(["a"]));
  it("an item with unknown risk is never shown under LOW, MEDIUM or HIGH", () => {
    for (const f of ["LOW", "MEDIUM", "HIGH"] as const) expect(ids(f)).not.toContain("c");
  });
  it("does not change Score or Expected Net Edge, does not reorder, and does not mutate the input", () => {
    const before = JSON.stringify(items);
    const out = filterByRisk(items, "ALL");
    expect(JSON.stringify(items)).toBe(before);
    expect(out).not.toBe(items);
    for (const kept of filterByRisk(items, "LOW")) {
      const original = items.find((i) => i.id === kept.id);
      expect(kept).toBe(original);
    }
  });
});
