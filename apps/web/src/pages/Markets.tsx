import { getMarkets } from "../apiClient";
import { StatusBadge } from "../components/StatusBadge";
import { useAsync } from "../useAsync";

export function Markets() {
  const markets = useAsync(getMarkets);
  return (
    <section>
      <h2>Markets</h2>
      <p>No market is configured in Phase 1A. Nothing is guessed or substituted.</p>
      {markets.status === "loading" && <p>Loading markets…</p>}
      {markets.status === "error" && <p role="alert">Could not load markets ({markets.message}).</p>}
      {markets.status === "ok" && (
        <table>
          <thead>
            <tr>
              <th>Market</th>
              <th>Category</th>
              <th>Status</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {markets.data.markets.map((market) => (
              <tr key={market.marketId}>
                <td>{market.displayName}</td>
                <td>{market.category}</td>
                <td>
                  <StatusBadge status={market.status} />
                </td>
                <td>{market.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
