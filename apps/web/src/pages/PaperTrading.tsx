import { useEffect, useState } from "react";
import { JOURNAL_DURABILITY_NOTICE } from "@nsest/core/contracts";
import type { JournalEventRecord, PaperTradeRecord } from "@nsest/core/contracts";
import { exportUrl, getTrade, listJournal, listTrades } from "../apiClient";
import { RiskBadge } from "../components/RiskBadge";
import { StatusBadge } from "../components/StatusBadge";
import { TradeDetail } from "../components/TradeDetail";
import { pnlText } from "../format";

type Tab = "active" | "history" | "archived" | "journal";
const ACTIVE = ["PAPER_REVIEW", "PAPER_OPEN"];

const message = (e: unknown): string => (e instanceof Error ? e.message : "Request failed");

function TradeTable({ trades, selectedId, onSelect }: { trades: readonly PaperTradeRecord[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <table>
      <thead>
        <tr><th>Trade</th><th>State</th><th>Entry risk</th><th>Current risk</th><th>P&amp;L</th><th></th></tr>
      </thead>
      <tbody>
        {trades.map((t) => {
          const pnl = t.realizedPnl ?? t.lastMonitor?.unrealized ?? null;
          return (
            <tr key={t.tradeId} aria-selected={t.tradeId === selectedId}>
              <td>{t.candidate.marketId} {t.candidate.structure}<br /><span className="hint">{t.tradeId} · expiry {t.candidate.expiry}</span></td>
              <td><StatusBadge status={t.state} /></td>
              <td><RiskBadge level={(t.entry ? t.entry.risk : t.review.risk).result.riskLevel} /></td>
              <td>{t.state === "PAPER_OPEN" ? <RiskBadge level={t.currentRisk?.result.riskLevel ?? null} /> : <span className="hint">n/a</span>}</td>
              <td>{pnl ? pnlText(pnl) : <span className="hint">n/a</span>}</td>
              <td><button type="button" onClick={() => onSelect(t.tradeId)}>Open {t.tradeId}</button></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function PaperTrading() {
  const [tab, setTab] = useState<Tab>("active");
  const [tick, setTick] = useState(0);
  const [trades, setTrades] = useState<PaperTradeRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ trade: PaperTradeRecord; events: JournalEventRecord[] } | null>(null);
  const [events, setEvents] = useState<JournalEventRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    listTrades()
      .then((t) => {
        if (!cancelled) {
          setTrades(t);
          setLoadError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(message(e));
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useEffect(() => {
    if (selectedId === null) return undefined;
    let cancelled = false;
    getTrade(selectedId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(message(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, tick]);

  useEffect(() => {
    if (tab !== "journal") return undefined;
    let cancelled = false;
    listJournal()
      .then((e) => {
        if (!cancelled) setEvents(e);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(message(e));
      });
    return () => {
      cancelled = true;
    };
  }, [tab, tick]);

  const active = trades.filter((t) => ACTIVE.includes(t.state));
  const history = trades.filter((t) => !ACTIVE.includes(t.state));
  const shown = detail !== null && detail.trade.tradeId === selectedId ? detail : null;

  return (
    <section>
      <h2>Paper Trading</h2>
      <p className="hint">Paper trades only: no real order is ever placed, and no broker is involved.</p>
      {loadError ? <p role="alert">Could not load paper trades ({loadError}). Is the API running (npm run dev:api)?</p> : null}
      <div role="tablist" aria-label="Paper trades">
        <button role="tab" aria-selected={tab === "active"} onClick={() => setTab("active")}>Active</button>
        <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>History</button>
        <button role="tab" aria-selected={tab === "journal"} onClick={() => setTab("journal")}>Journal</button>
        <button role="tab" aria-selected={tab === "archived"} onClick={() => setTab("archived")}>Archived (Legacy)</button>
      </div>
      <div role="tabpanel">
        {tab === "active" ? (active.length === 0 ? <p>No active paper trades.</p> : <TradeTable trades={active} selectedId={selectedId} onSelect={setSelectedId} />) : null}
        {tab === "history" ? (history.length === 0 ? <p>No finished paper trades.</p> : <TradeTable trades={history} selectedId={selectedId} onSelect={setSelectedId} />) : null}
        {tab === "archived" ? <p>No archived legacy trades. V2 does not import or read any legacy trade records.</p> : null}
        {tab === "journal" ? (
          <div>
            <p>
              <a href={exportUrl()} download>Export journal (JSON backup)</a>
            </p>
            <p className="hint">{JOURNAL_DURABILITY_NOTICE}</p>
            {events.length === 0 ? <p>The journal is empty.</p> : (
              <table>
                <thead><tr><th>#</th><th>Time</th><th>Event</th><th>Trade</th><th>Change</th></tr></thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.sequence}><td>{e.sequence}</td><td>{e.timestamp}</td><td>{e.type}</td><td>{e.tradeId ?? "-"}</td><td>{e.fromState ?? "-"} → {e.toState ?? "-"}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : null}
      </div>
      {shown && tab !== "archived" && tab !== "journal" ? <TradeDetail trade={shown.trade} events={shown.events} onChanged={() => setTick((n) => n + 1)} /> : null}
    </section>
  );
}
