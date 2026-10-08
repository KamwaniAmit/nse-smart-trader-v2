import { NotAvailable } from "../components/NotAvailable";
import { PaperCandidateWorkflow } from "../components/PaperCandidateWorkflow";

export function BestOpportunities() {
  return (
    <section>
      <h2>Best Opportunities</h2>
      <p>Single-leg candidates (a call or a put). Entry = the option's Ask. Exit = its Bid.</p>
      <NotAvailable>Live candidate scanning needs a broker, which is not connected. Enter a candidate manually below to use the paper-trading workflow.</NotAvailable>
      <PaperCandidateWorkflow source="BEST_OPPORTUNITY" withRiskFilter />
    </section>
  );
}
