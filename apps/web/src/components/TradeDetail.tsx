import { useState } from "react";
import { JOURNAL_DURABILITY_NOTICE } from "@nsest/core/contracts";
import type { ExpiryStatusDTO, JournalEventRecord, PaperPnl, PaperTradeRecord, PriceQualityDTO } from "@nsest/core/contracts";
import { ApiError, confirmTrade, exitTrade, monitorTrade, safetyCheck } from "../apiClient";
import { inr, num, pnlText } from "../format";
import { QuoteForm } from "./QuoteForm";
import type { ExtraField } from "./QuoteForm";
import { RiskPanel } from "./RiskPanel";
import { StatusBadge } from "./StatusBadge";

interface Props {
  /** The trade as the API returns it. priceQuality / expiryStatus are derived by the server (Phase 1B.2). */
  trade: PaperTradeRecord & { priceQuality?: PriceQualityDTO; expiryStatus?: ExpiryStatusDTO };
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
  const quality = trade.priceQuality;
  const expiryStatus = trade.expiryStatus?.status;
  const exit = trade.exit;
  const manualChecked = exit?.valuationStatus === "MANUAL_ENTRY_CHECKED";

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
      {entry ? (
        <table>
          <thead>
            <tr><th>Leg</th><th>Strike</th><th>Ask (entry)</th><th>Bid at entry</th><th>Quote entry time (user-entered)</th></tr>
          </thead>
          <tbody>
            {entry.legs.map((l) => (
              <tr key={l.instrument.id}>
                <td>{l.optionType}</td><td>{l.strike}</td><td>{num(l.entryAsk)}</td><td>{num(l.entryBid)}</td><td>{l.quoteAsOf ?? "not recorded (v1 snapshot)"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table>
          <thead>
            <tr><th>Leg</th><th>Strike</th><th>Ask (review)</th><th>Bid (review)</th></tr>
          </thead>
          <tbody>
            {trade.candidate.legs.map((l) => (
              <tr key={l.instrument.id}>
                <td>{l.optionType}</td><td>{l.strike}</td><td>{num(l.quote.ask)}</td><td>{num(l.quote.bid)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
            <p className="hint">Recorded by the server at {trade.lastMonitor.asOf} (processing time; these quotes carry no observation time). Exit premium now {inr(trade.lastMonitor.currentExitPremium)} (sum of bids). {trade.lastMonitor.dataReasons.join("; ")}</p>
          </>
        ) : (
          <p>Not monitored yet: no executable bids have been recorded.</p>
        )
      ) : null}
      {trade.realizedPnl ? (
        <>
          <PnlLine label="Realized P&L" pnl={trade.realizedPnl} />
          {exit && manualChecked ? (
            <p className="hint" data-valuation="MANUAL_ENTRY_CHECKED">
              {exit.trigger} · valued from prices you entered · the application&apos;s manual-input checks passed (valid bid and ask, entered at most 60 s before the server processed them) · not exchange-sourced, exchange-timestamped or independently verified
              {` · processed by the server at ${exit.timestamp}`}
              {" · exit premium "}{inr(exit.exitPremium)}
            </p>
          ) : null}
          {exit && !manualChecked ? (
            <p className="hint">
              {exit.trigger} · price basis {exit.basis}
              {exit.valuationStatus ? ` · valuation ${exit.valuationStatus}` : ""}
              {` · processed by the server at ${exit.timestamp}`}
              {exit.priceAsOf
                ? ` · price time ${exit.priceAsOf} recorded by an earlier version; not a verified quote-observation time`
                : " · quote observation time: not available"}
              {" · exit premium "}{inr(exit.exitPremium)} {exit.notes.join(" ")}
            </p>
          ) : null}
          {exit?.trigger === "EXPIRY" && exit.exitPremium === null ? (
            <p className="hint">No approved settlement-price source: the expiry closure has no exit price, so its P&amp;L is not available.</p>
          ) : null}
          {exit?.trigger === "HOLDING_LIMIT" ? (
            <p className="hint">Holding limit: the completed-session count was entered by you (session count entered by you; there is no trading calendar).</p>
          ) : null}
          {trade.exit?.staleReference ? (
            <p className="hint" data-stale-reference="true">
              Reference only (not an exit price, not used for P&amp;L): last valid monitored bids recorded by the server at {trade.exit.staleReference.asOf}, exit premium {inr(trade.exit.staleReference.exitPremium)}.
            </p>
          ) : null}
        </>
      ) : null}
      {quality ? (
        <div className="hint" data-price-quality={quality.level}>
          <p>Price quality: <strong>{quality.level}</strong>. {quality.note}</p>
          {quality.warnings.length > 0 ? <ul>{quality.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
        </div>
      ) : null}
      {trade.state === "DATA_INSUFFICIENT" ? (
        <p data-pnl-status="DATA_INSUFFICIENT">
          <strong>DATA_INSUFFICIENT:</strong> this candidate had no executable entry price and was not opened. {trade.rejectionReasons.join("; ")}
        </p>
      ) : null}

      {trade.state === "PAPER_REVIEW" && expiryStatus === "EXPIRED_REVIEW" ? (
        <p className="notice" data-expiry-status="EXPIRED_REVIEW">
          This review&apos;s contract expired at 15:30 IST on {trade.candidate.expiry} (provisional paper-safety cutoff), so it cannot be confirmed. It stays in PAPER_REVIEW as history.
        </p>
      ) : null}
      {trade.state === "PAPER_REVIEW" && expiryStatus !== "EXPIRED_REVIEW" ? (
        <>
          <p>Nothing is open yet. Confirming records the entry snapshot and opens a PAPER trade. No real order is ever placed.</p>
          <p className="hint">
            The review prices above are history. A paper trade opens only at FRESH prices: enter the current bid and ask for each leg (at most 60 seconds old). Entry premium, capital and entry risk are recalculated from them.
          </p>
          <QuoteForm
            title="Confirm paper trade" legs={legs} extended timestamped disabled={!confirmed || busy} submitLabel="Confirm paper trade" extra={[]}
            beforeSubmit={
              <label>
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                I confirm this paper trade
              </label>
            }
            onSubmit={(quotes) => void run(async () => void (await confirmTrade(trade.tradeId, { confirmed: true, quotes })), "Paper trade opened.")}
          />
        </>
      ) : null}

      {trade.state === "PAPER_OPEN" && expiryStatus === "EXPIRED_PENDING_CLOSURE" ? (
        <p className="notice" data-expiry-status="EXPIRED_PENDING_CLOSURE">
          Contract expired at 15:30 IST on {trade.candidate.expiry} (provisional paper-safety cutoff). Monitoring and exit are closed; run the safety check to record the expiry closure. There is no approved settlement-price source, so its P&amp;L will be DATA_INSUFFICIENT.
        </p>
      ) : null}
      {trade.state === "PAPER_OPEN" && expiryStatus !== "EXPIRED_PENDING_CLOSURE" ? (
        <>
          <QuoteForm
            title="Monitor" legs={legs} extended timestamped disabled={busy} submitLabel="Record monitor update"
            extra={[{ key: "tradingDaysToExpiry", label: "Trading days to expiry" }, { key: "spot", label: "Spot" }, costs]}
            onSubmit={(quotes, x) => void run(async () => void (await monitorTrade(trade.tradeId, { quotes, tradingDaysToExpiry: optNum(x["tradingDaysToExpiry"]), spot: optNum(x["spot"]), exitCosts: optNum(x["exitCosts"]) })), "Monitor update recorded.")}
          />
          <QuoteForm
            title="Exit" legs={legs} withAsk timestamped disabled={busy} submitLabel="Exit paper trade" extra={[costs]}
            onSubmit={(quotes, x) => void run(async () => void (await exitTrade(trade.tradeId, { quotes, exitCosts: optNum(x["exitCosts"]) })), "Paper trade exited.")}
          />
        </>
      ) : null}
      {trade.state === "PAPER_OPEN" ? (
        <>
          <QuoteForm
            title="Safety check" legs={legs} withAsk timestamped disabled={busy} submitLabel="Run safety check"
            extra={[{ key: "completedSessions", label: "Completed sessions (optional)", hint: "No trading calendar exists: if blank, the holding limit is not evaluated. Expiry is judged on the server clock: the provisional 15:30 IST cutoff on the expiry date." }, costs]}
            onSubmit={(quotes, x) =>
              void run(
                async () => {
                  const res = await safetyCheck(trade.tradeId, { completedSessions: optNum(x["completedSessions"]), quotes, exitCosts: optNum(x["exitCosts"]) });
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
