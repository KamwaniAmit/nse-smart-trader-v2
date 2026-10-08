import { useState } from "react";
import { JOURNAL_DURABILITY_NOTICE } from "@nsest/core/contracts";
import type { JournalEventRecord, PaperPnl, PaperTradeRecord } from "@nsest/core/contracts";
import { ApiError, confirmTrade, exitTrade, monitorTrade, safetyCheck } from "../apiClient";
import { inr, num, pnlText } from "../format";
import { QuoteForm } from "./QuoteForm";
import type { ExtraField } from "./QuoteForm";
import { RiskPanel } from "./RiskPanel";
import { StatusBadge } from "./StatusBadge";

interface Props {
  trade: PaperTradeRecord;
  events: readonly JournalEventRecord[];
  /** Called after ANY action attempt (success or refusal) so the lists and the journal reload. */
  onChanged: () => void;
}

interface Msg {
  kind: "error" | "info";
  text: string;
  details?: string[];
}

const optNum = (s: string | undefined): number | null => {
  const t = (s ?? "").trim();
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : (t as unknown as number);
};

function PnlLine({ label, pnl }: { label: string; pnl: PaperPnl | null | undefined }) {
  return (
    <p data-pnl-status={pnl?.status ?? "NONE"}>
      <strong>{label}:</strong> {pnlText(pnl)}
    </p>
  );
}

export function TradeDetail({ trade, events, onChanged }: Props) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);

  const legs = trade.candidate.legs.map((l) => ({ label: `${l.optionType} ${l.strike}`, instrument: l.instrument }));
  const entry = trade.entry;
  const premium = entry ? entry.combinedEntryPremium : trade.review.combinedEntryPremium;
  const capital = trade.review.capital;

  async function run(action: () => Promise<string | void>, okText: string): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const text = await action();
      setMsg({ kind: "info", text: text ?? okText });
    } catch (e) {
      if (e instanceof ApiError) setMsg({ kind: "error", text: e.message, ...(e.body.details ? { details: e.body.details } : {}) });
      else setMsg({ kind: "error", text: e instanceof Error ? e.message : "Request failed" });
    } finally {
      setBusy(false);
      setConfirmed(false);
      onChanged();
    }
  }

  const costs: ExtraField = { key: "exitCosts", label: "Exit costs (₹, optional)" };

  return (
    <section aria-label={`Trade ${trade.tradeId}`}>
      <h3>
        {trade.candidate.marketId} {trade.candidate.structure} <StatusBadge status={trade.state} />
      </h3>
      <p className="hint">
        {trade.tradeId} · {trade.source} · expiry {trade.candidate.expiry} · data source {trade.candidate.dataSource} (not broker-verified)
      </p>
      {msg ? (
        <div role="alert" className={msg.kind === "error" ? "notice" : "hint"}>
          <strong>{msg.kind === "error" ? "Not done: " : ""}</strong>{msg.text}
          {msg.details ? <ul>{msg.details.map((d) => <li key={d}>{d}</li>)}</ul> : null}
        </div>
      ) : null}

      <h4>Entry and capital</h4>
      <p>
        Entry premium (sum of asks): <strong>{inr(premium)}</strong> per unit · lot size {trade.candidate.lotSize} · lots {num(entry ? entry.lots : capital.lots)}
      </p>
      <table>
        <thead>
          <tr><th>Leg</th><th>Strike</th><th>Ask (entry)</th><th>Bid at entry</th></tr>
        </thead>
        <tbody>
          {trade.candidate.legs.map((l) => (
            <tr key={l.instrument.id}>
              <td>{l.optionType}</td><td>{l.strike}</td><td>{num(l.quote.ask)}</td><td>{num(l.quote.bid)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Capital requirement {inr(capital.totalCapitalRequirement)} per lot (premium {inr(capital.premiumRequirement)} + costs {inr(capital.entryCosts)}) · allocation {inr(capital.maxCapitalAllocation)} · gate <strong>{capital.gate}</strong>
        {capital.utilizationPct !== null ? ` · utilization ${capital.utilizationPct}%` : ""}
      </p>
      {capital.reasons.length > 0 ? <p className="hint">{capital.reasons.join(" ")}</p> : null}
      {entry ? (
        <p className="hint">
          Entry snapshot recorded {entry.capturedAt} (immutable). Market data {entry.dataCompleteness.complete ? "complete" : `incomplete: ${entry.dataCompleteness.missing.join(", ")}`}.
        </p>
      ) : null}

      <h4>Risk</h4>
      <RiskPanel title="Entry risk" record={entry ? entry.risk : trade.review.risk} />
      {trade.state === "PAPER_OPEN" ? <RiskPanel title="Current risk" record={trade.currentRisk} /> : null}
      {trade.state !== "PAPER_REVIEW" && trade.state !== "PAPER_OPEN" && trade.state !== "DATA_INSUFFICIENT" ? <RiskPanel title="Last known risk" record={trade.currentRisk} /> : null}

      <h4>P&amp;L</h4>
      {trade.state === "PAPER_OPEN" ? (
        trade.lastMonitor ? (
          <>
            <PnlLine label="Unrealized P&L" pnl={trade.lastMonitor.unrealized} />
            <p className="hint">As of {trade.lastMonitor.asOf}. Exit premium now {inr(trade.lastMonitor.currentExitPremium)} (sum of bids). {trade.lastMonitor.dataReasons.join("; ")}</p>
          </>
        ) : (
          <p>Not monitored yet: no executable bids have been recorded.</p>
        )
      ) : null}
      {trade.realizedPnl ? (
        <>
          <PnlLine label="Realized P&L" pnl={trade.realizedPnl} />
          {trade.exit ? (
            <p className="hint">
              {trade.exit.trigger} · price basis {trade.exit.basis}
              {trade.exit.priceAsOf ? ` (as of ${trade.exit.priceAsOf})` : ""} · exit premium {inr(trade.exit.exitPremium)} {trade.exit.notes.join(" ")}
            </p>
          ) : null}
        </>
      ) : null}
      {trade.state === "DATA_INSUFFICIENT" ? (
        <p data-pnl-status="DATA_INSUFFICIENT">
          <strong>DATA_INSUFFICIENT:</strong> this candidate had no executable entry price and was not opened. {trade.rejectionReasons.join("; ")}
        </p>
      ) : null}

      {trade.state === "PAPER_REVIEW" ? (
        <fieldset>
          <legend>Confirm paper trade</legend>
          <p>Nothing is open yet. Confirming records the entry snapshot and opens a PAPER trade. No real order is ever placed.</p>
          <label>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            I confirm this paper trade
          </label>{" "}
          <button type="button" disabled={!confirmed || busy} onClick={() => void run(async () => void (await confirmTrade(trade.tradeId, { confirmed: true })), "Paper trade opened.")}>
            Confirm paper trade
          </button>
        </fieldset>
      ) : null}

      {trade.state === "PAPER_OPEN" ? (
        <>
          <QuoteForm
            title="Monitor" legs={legs} extended disabled={busy} submitLabel="Record monitor update"
            extra={[{ key: "tradingDaysToExpiry", label: "Trading days to expiry" }, { key: "spot", label: "Spot" }, costs]}
            onSubmit={(quotes, x) => void run(async () => void (await monitorTrade(trade.tradeId, { quotes, tradingDaysToExpiry: optNum(x["tradingDaysToExpiry"]), spot: optNum(x["spot"]), exitCosts: optNum(x["exitCosts"]) })), "Monitor update recorded.")}
          />
          <QuoteForm
            title="Exit" legs={legs} disabled={busy} submitLabel="Exit paper trade" extra={[costs]}
            onSubmit={(quotes, x) => void run(async () => void (await exitTrade(trade.tradeId, { quotes, exitCosts: optNum(x["exitCosts"]) })), "Paper trade exited.")}
          />
          <QuoteForm
            title="Safety check" legs={legs} disabled={busy} submitLabel="Run safety check"
            extra={[{ key: "asOf", label: "As of (YYYY-MM-DD or timestamp)" }, { key: "completedSessions", label: "Completed sessions (optional)", hint: "No trading calendar exists: if blank, the holding limit is not evaluated." }, costs]}
            onSubmit={(quotes, x) =>
              void run(
                async () => {
                  const res = await safetyCheck(trade.tradeId, { asOf: x["asOf"] ?? "", completedSessions: optNum(x["completedSessions"]), quotes, exitCosts: optNum(x["exitCosts"]) });
                  if (res.decision.action === "NONE") return `No safety closure applies. ${res.decision.notEvaluated.join(" ")}`.trim();
                  return undefined;
                },
                "Safety closure applied.",
              )}
          />
        </>
      ) : null}

      <h4>Journal for this trade</h4>
      <ol>
        {events.map((e) => (
          <li key={e.sequence}>
            #{e.sequence} {e.timestamp} {e.type} ({e.fromState ?? "-"} → {e.toState ?? "-"})
          </li>
        ))}
      </ol>
      <p className="hint">{JOURNAL_DURABILITY_NOTICE}</p>
    </section>
  );
}
