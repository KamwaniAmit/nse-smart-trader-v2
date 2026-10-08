import type { RiskAssessmentRecord } from "@nsest/core/contracts";
import { RiskBadge } from "./RiskBadge";

/** One risk assessment: the level as TEXT, its data status, the reasons, and the rules version it used. */
export function RiskPanel({ title, record }: { title: string; record: RiskAssessmentRecord | null }) {
  if (record === null) {
    return (
      <div className="riskpanel">
        <strong>{title}</strong>: <span>not assessed yet</span>
      </div>
    );
  }
  const r = record.result;
  return (
    <div className="riskpanel">
      <strong>{title}</strong>: <RiskBadge level={r.riskLevel} /> <span>data {r.riskDataStatus}</span>
      {r.riskScore !== null ? <span>, risk score {r.riskScore}</span> : null}
      <details>
        <summary>Why (rules v{record.rulesVersion})</summary>
        <ul>
          {r.riskReasons.map((x) => (
            <li key={x}>{x}</li>
          ))}
          {r.riskWarnings.map((x) => (
            <li key={x} className="hint">{x}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
