import { NotAvailable } from "../components/NotAvailable";
import { StatusBadge } from "../components/StatusBadge";

export function Broker() {
  return (
    <section>
      <h2>Broker</h2>
      <p>
        Status: <StatusBadge status="NOT_CONNECTED" /> <span>Not connected</span>
      </p>
      <NotAvailable>Broker connection and authentication are not implemented yet. No credentials are accepted.</NotAvailable>
    </section>
  );
}
