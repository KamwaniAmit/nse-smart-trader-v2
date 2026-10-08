import { describe, expect, it } from "vitest";
import { ALLOWED_TRANSITIONS, PAPER_LIFECYCLE_STATES, PAPER_TERMINAL_STATES, SAFETY_RULES, evaluateSafety, isAllowedTransition, isTerminalState } from "../src/index.js";

describe("lifecycle transition table", () => {
  it("defines exactly the Phase 1B states", () => {
    expect([...PAPER_LIFECYCLE_STATES]).toEqual(["CANDIDATE", "PAPER_REVIEW", "PAPER_OPEN", "PAPER_EXITED", "PAPER_EXPIRED", "PAPER_AUTO_CLOSED", "DATA_INSUFFICIENT"]);
  });
  it("candidate -> review is allowed", () => expect(isAllowedTransition("CANDIDATE", "PAPER_REVIEW")).toBe(true));
  it("candidate -> DATA_INSUFFICIENT is allowed (no executable entry)", () => expect(isAllowedTransition("CANDIDATE", "DATA_INSUFFICIENT")).toBe(true));
  it("review -> open is allowed", () => expect(isAllowedTransition("PAPER_REVIEW", "PAPER_OPEN")).toBe(true));
  it("there is NO automatic path: a candidate cannot go straight to PAPER_OPEN", () => expect(isAllowedTransition("CANDIDATE", "PAPER_OPEN")).toBe(false));
  it("a reviewed trade cannot skip to a closed state", () => {
    for (const to of ["PAPER_EXITED", "PAPER_EXPIRED", "PAPER_AUTO_CLOSED"] as const) expect(isAllowedTransition("PAPER_REVIEW", to)).toBe(false);
  });
  it("an open trade can exit, expire or be auto-closed", () => {
    for (const to of ["PAPER_EXITED", "PAPER_EXPIRED", "PAPER_AUTO_CLOSED"] as const) expect(isAllowedTransition("PAPER_OPEN", to)).toBe(true);
  });
  it("an open trade cannot go back to review or to a candidate", () => {
    expect(isAllowedTransition("PAPER_OPEN", "PAPER_REVIEW")).toBe(false);
    expect(isAllowedTransition("PAPER_OPEN", "CANDIDATE")).toBe(false);
  });
  it("terminal states have no way out", () => {
    for (const s of PAPER_TERMINAL_STATES) {
      expect(isTerminalState(s)).toBe(true);
      expect(ALLOWED_TRANSITIONS[s]).toEqual([]);
    }
  });
  it("non-terminal states are not terminal", () => {
    for (const s of ["CANDIDATE", "PAPER_REVIEW", "PAPER_OPEN"] as const) expect(isTerminalState(s)).toBe(false);
  });
});

describe("safety rules (expiry and holding limit)", () => {
  const base = { expiry: "2026-10-06", completedSessions: null as number | null };
  it("holding limit is 2 sessions (frozen forward protocol)", () => expect(SAFETY_RULES.maxHoldingSessions).toBe(2));
  it("the expiry day itself is NOT treated as expired (market hours are not configured)", () => {
    expect(evaluateSafety({ ...base, asOf: "2026-10-06T10:00:00+05:30" }).action).toBe("NONE");
  });
  it("the day after expiry IS expired", () => {
    const d = evaluateSafety({ ...base, asOf: "2026-10-07T09:20:00+05:30" });
    expect(d.action).toBe("EXPIRE");
    expect(d.reasons[0]).toMatch(/Expiry 2026-10-06 has passed/);
  });
  it("completed sessions at the limit -> AUTO_CLOSE", () => {
    expect(evaluateSafety({ ...base, asOf: "2026-10-01", completedSessions: 2 }).action).toBe("AUTO_CLOSE");
    expect(evaluateSafety({ ...base, asOf: "2026-10-01", completedSessions: 5 }).action).toBe("AUTO_CLOSE");
  });
  it("below the limit -> NONE, with nothing left unevaluated", () => {
    expect(evaluateSafety({ ...base, asOf: "2026-10-01", completedSessions: 1 })).toEqual({ action: "NONE", reasons: [], notEvaluated: [] });
  });
  it("unknown completed sessions is reported as NOT evaluated, never estimated", () => {
    const d = evaluateSafety({ ...base, asOf: "2026-10-01" });
    expect(d.action).toBe("NONE");
    expect(d.notEvaluated[0]).toMatch(/HOLDING_LIMIT not evaluated.*no trading calendar/);
  });
  it("EXPIRY wins when both rules apply", () => {
    expect(evaluateSafety({ ...base, asOf: "2026-10-08", completedSessions: 9 }).action).toBe("EXPIRE");
  });
});
