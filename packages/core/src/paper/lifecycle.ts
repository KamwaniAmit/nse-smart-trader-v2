import type { PaperLifecycleState } from "../contracts/index.js";
import { PAPER_TERMINAL_STATES } from "../contracts/index.js";

/**
 * Phase 1B lifecycle. This sits BESIDE the frozen Phase 1A PaperTradeStatus contract (which is unchanged).
 *   CANDIDATE -> PAPER_REVIEW -> PAPER_OPEN -> PAPER_EXITED | PAPER_EXPIRED | PAPER_AUTO_CLOSED
 *   CANDIDATE -> DATA_INSUFFICIENT   (no executable entry prices; terminal)
 * There is no automatic path into PAPER_OPEN: only an explicit confirmation moves PAPER_REVIEW to PAPER_OPEN.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<PaperLifecycleState, readonly PaperLifecycleState[]>> = {
  CANDIDATE: ["PAPER_REVIEW", "DATA_INSUFFICIENT"],
  PAPER_REVIEW: ["PAPER_OPEN"],
  PAPER_OPEN: ["PAPER_EXITED", "PAPER_EXPIRED", "PAPER_AUTO_CLOSED"],
  PAPER_EXITED: [],
  PAPER_EXPIRED: [],
  PAPER_AUTO_CLOSED: [],
  DATA_INSUFFICIENT: [],
};

export function isAllowedTransition(from: PaperLifecycleState, to: PaperLifecycleState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminalState(state: PaperLifecycleState): boolean {
  return (PAPER_TERMINAL_STATES as readonly string[]).includes(state);
}
