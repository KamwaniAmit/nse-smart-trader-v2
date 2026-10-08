import { describe, expect, it } from "vitest";
import {
  OPPORTUNITY_STATUSES,
  RISK_FILTER_OPTIONS,
  RISK_INPUT_FIELDS,
  RISK_LEVELS,
  insufficientRisk,
} from "../src/index.js";
import type { RiskResult } from "../src/index.js";

// Phase 1A defines the risk CONTRACT only. These tests check the contract's shape,
// not any classification (no thresholds exist yet).

describe("risk contract", () => {
  it("defines exactly LOW, MEDIUM, HIGH", () => {
    expect([...RISK_LEVELS]).toEqual(["LOW", "MEDIUM", "HIGH"]);
  });

  it("defines the filter values ALL, LOW, MEDIUM, HIGH", () => {
    expect([...RISK_FILTER_OPTIONS]).toEqual(["ALL", "LOW", "MEDIUM", "HIGH"]);
  });

  it("can represent a LOW result", () => {
    const result = { riskLevel: "LOW", riskScore: 12, riskReasons: ["a"], riskWarnings: [], riskDataStatus: "COMPLETE" } satisfies RiskResult;
    expect(result.riskLevel).toBe("LOW");
  });

  it("can represent a MEDIUM result", () => {
    const result = { riskLevel: "MEDIUM", riskScore: 50, riskReasons: [], riskWarnings: ["w"], riskDataStatus: "PARTIAL" } satisfies RiskResult;
    expect(result.riskLevel).toBe("MEDIUM");
  });

  it("can represent a HIGH result", () => {
    const result = { riskLevel: "HIGH", riskScore: 90, riskReasons: [], riskWarnings: [], riskDataStatus: "COMPLETE" } satisfies RiskResult;
    expect(result.riskLevel).toBe("HIGH");
  });

  it("insufficientRisk never guesses: null level, null score, INSUFFICIENT", () => {
    const result = insufficientRisk("no spread data");
    expect(result.riskLevel).toBeNull();
    expect(result.riskScore).toBeNull();
    expect(result.riskDataStatus).toBe("INSUFFICIENT");
    expect(result.riskWarnings).toEqual(["no spread data"]);
  });

  it("RiskResult carries no score, edge, capital or status fields (separate dimensions)", () => {
    const keys = Object.keys(insufficientRisk("x"));
    expect(keys.sort()).toEqual(["riskDataStatus", "riskLevel", "riskReasons", "riskScore", "riskWarnings"]);
    for (const forbidden of ["score", "expectedNetEdge", "netEdge", "capitalRequirement", "status"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("risk inputs do not include the opportunity score or status", () => {
    const fields: readonly string[] = RISK_INPUT_FIELDS;
    expect(fields).not.toContain("score");
    expect(fields).not.toContain("opportunityScore");
    expect(fields).not.toContain("status");
  });

  it("the opportunity status set is exactly the frozen five", () => {
    expect([...OPPORTUNITY_STATUSES]).toEqual(["QUALIFIED", "WATCH", "FILTERED", "REJECTED", "DATA_INSUFFICIENT"]);
  });
});
