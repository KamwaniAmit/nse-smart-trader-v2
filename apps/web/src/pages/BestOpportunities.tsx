import { RISK_FILTER_OPTIONS } from "@nsest/core/contracts";
import { NotAvailable } from "../components/NotAvailable";
import { RiskBadge } from "../components/RiskBadge";

export function BestOpportunities() {
  return (
    <section>
      <h2>Best Opportunities</h2>
      <fieldset disabled>
        <legend>Risk filter (disabled in Phase 1A)</legend>
        {RISK_FILTER_OPTIONS.map((option) => (
          <label key={option} className="radio">
            <input type="radio" name="risk-filter" value={option} defaultChecked={option === "ALL"} />
            {option}
          </label>
        ))}
      </fieldset>
      <p>
        Risk shown for a candidate: <RiskBadge level={null} />
      </p>
      <NotAvailable>Candidate scanning and risk classification are not implemented yet.</NotAvailable>
    </section>
  );
}
