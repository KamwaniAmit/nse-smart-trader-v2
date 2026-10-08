import { useState } from "react";
import { RISK_FILTER_OPTIONS } from "@nsest/core/contracts";
import type { PaperSource, RiskFilter } from "@nsest/core/contracts";
import { ApiError, assessCandidate, reviewCandidate } from "../apiClient";
import { matchesRiskFilter } from "../riskFilter";
import { CandidateForm } from "./CandidateForm";
import { CandidateList } from "./CandidateList";
import type { AssessedItem } from "./CandidateList";
import type { CandidateInputDTO } from "@nsest/core/contracts";

interface Msg {
  kind: "error" | "info";
  text: string;
  details?: string[];
}

/**
 * Candidate -> review. Candidates exist only in this page's memory until the user clicks Review, which stores
 * a PAPER_REVIEW record on the server. Opening a trade happens on the Paper Trading page, after an explicit confirmation.
 */
export function PaperCandidateWorkflow({ source, withRiskFilter }: { source: PaperSource; withRiskFilter: boolean }) {
  const [items, setItems] = useState<AssessedItem[]>([]);
  const [seq, setSeq] = useState(0);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [reviewed, setReviewed] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<RiskFilter>("ALL");

  const fail = (e: unknown): void => {
    if (e instanceof ApiError) setMsg({ kind: "error", text: e.message, ...(e.body.details ? { details: e.body.details } : {}) });
    else setMsg({ kind: "error", text: e instanceof Error ? e.message : "Request failed" });
  };

  async function onAssess(input: CandidateInputDTO): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const response = await assessCandidate(input);
      const key = `c${seq}`;
      setSeq(seq + 1);
      setItems((prev) => [...prev, { key, input, response }]);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function onReview(item: AssessedItem): Promise<void> {
    setBusyKey(item.key);
    setMsg(null);
    try {
      const trade = await reviewCandidate(item.input);
      setReviewed((prev) => ({ ...prev, [item.key]: trade.tradeId }));
      setMsg({ kind: "info", text: `Opened for review as ${trade.tradeId}. It is NOT a position yet: confirm it on the Paper Trading page.` });
    } catch (e) {
      fail(e);
    } finally {
      setBusyKey(null);
    }
  }

  const visible = items.filter((i) => matchesRiskFilter(i.response.review.risk.result.riskLevel, filter));

  return (
    <div>
      {withRiskFilter ? (
        <fieldset disabled={items.length === 0}>
          <legend>Risk filter{items.length === 0 ? " (disabled: no candidates yet)" : ""}</legend>
          {RISK_FILTER_OPTIONS.map((option) => (
            <label key={option} className="radio">
              <input type="radio" name="risk-filter" value={option} checked={filter === option} onChange={() => setFilter(option)} />
              {option}
            </label>
          ))}
          <p className="hint">The filter only chooses which rows to show. It never changes any Score or Expected Net Edge. Unknown risk appears only under ALL.</p>
        </fieldset>
      ) : null}

      {msg ? (
        <div role="alert" className={msg.kind === "error" ? "notice" : "hint"}>
          {msg.text}
          {msg.details ? <ul>{msg.details.map((d) => <li key={d}>{d}</li>)}</ul> : null}
        </div>
      ) : null}

      <h3>Assessed candidates</h3>
      <CandidateList items={visible} busyKey={busyKey} reviewedTradeIds={reviewed} onReview={(i) => void onReview(i)} />
      {visible.length < items.length ? <p className="hint">{items.length - visible.length} candidate(s) hidden by the risk filter.</p> : null}

      <CandidateForm source={source} busy={busy} onAssess={(input) => void onAssess(input)} />
    </div>
  );
}
