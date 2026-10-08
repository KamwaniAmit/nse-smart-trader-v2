import { getHealth } from "../apiClient";
import { StatusBadge } from "../components/StatusBadge";
import { useAsync } from "../useAsync";

export function Overview() {
  const health = useAsync(getHealth);
  return (
    <section>
      <h2>Overview</h2>
      <p>
        Foundation build. This app has no market data, no strategy calculations, no broker connection and no order
        placement yet.
      </p>
      <h3>API status</h3>
      {health.status === "loading" && <p>Checking API…</p>}
      {health.status === "error" && (
        <p role="alert">API not reachable ({health.message}). Start it with <code>npm run dev:api</code>.</p>
      )}
      {health.status === "ok" && (
        <dl className="facts">
          <dt>Phase</dt>
          <dd>{health.data.phase}</dd>
          <dt>Broker provider</dt>
          <dd>{health.data.brokerProvider}</dd>
          <dt>Broker connection</dt>
          <dd>
            <StatusBadge status={health.data.brokerConnected ? "CONNECTED" : "NOT_CONNECTED"} />
          </dd>
          <dt>Live orders</dt>
          <dd>{health.data.liveOrdersEnabled ? "ENABLED" : "DISABLED"}</dd>
        </dl>
      )}
    </section>
  );
}
