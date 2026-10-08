import { Link } from "react-router-dom";
import type { AssessResponseDTO, CandidateInputDTO } from "@nsest/core/contracts";
import { inr, num } from "../format";
import { RiskBadge } from "./RiskBadge";
import { StatusBadge } from "./StatusBadge";

export interface AssessedItem {
  key: string;
  input: CandidateInputDTO;
  response: AssessResponseDTO;
}

interface Props {
  items: readonly AssessedItem[];
  busyKey: string | null;
  reviewedTradeIds: Readonly<Record<string, string>>;
  onReview: (item: AssessedItem) => void;
}

/** Candidates the user has assessed. Review is an explicit click; nothing opens automatically. */
export function CandidateList({ items, busyKey, reviewedTradeIds, onReview }: Props) {
  if (items.length === 0) return <p>No candidates assessed yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Candidate</th><th>Entry premium</th><th>Capital</th><th>Risk</th><th>State</th><th></th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const c = item.response.candidate;
          const r = item.response.review;
          const insufficient = item.response.state === "DATA_INSUFFICIENT";
          const reviewed = reviewedTradeIds[item.key];
          return (
            <tr key={item.key}>
              <td>
                {c.marketId} {c.structure}
                <br />
                <span className="hint">{c.legs.map((l) => `${l.optionType} ${l.strike}`).join(" / ")}, expiry {c.expiry}</span>
              </td>
              <td>{insufficient ? "n/a" : inr(r.combinedEntryPremium)}</td>
              <td>
                lots {num(r.capital.lots)}, requirement {inr(r.capital.totalCapitalRequirement)}
                <br />
                <span className="hint">capital gate {r.capital.gate}</span>
              </td>
              <td>
                <RiskBadge level={r.risk.result.riskLevel} />
                <br />
                <span className="hint">data {r.risk.result.riskDataStatus}</span>
              </td>
              <td>
                <StatusBadge status={item.response.state} />
                {insufficient ? <div className="hint">{r.entryReasons.join("; ")}</div> : null}
              </td>
              <td>
                {reviewed ? (
                  <span>
                    In review: <Link to="/paper-trading">open Paper Trading to confirm</Link>
                  </span>
                ) : (
                  <button type="button" disabled={insufficient || busyKey === item.key} onClick={() => onReview(item)}>
                    Review this candidate
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
