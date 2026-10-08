import { useState } from "react";
import { MARKET_IDS } from "@nsest/core/contracts";
import type { MarketId } from "@nsest/core/contracts";
import { MarketSelector } from "../components/MarketSelector";
import { NotAvailable } from "../components/NotAvailable";

export function LongVol() {
  const [market, setMarket] = useState<MarketId | "">("");
  return (
    <section>
      <h2>LONG VOL Opportunities</h2>
      <p>LONG VOL = buy a CE and a PE (straddle or strangle).</p>
      <MarketSelector
        markets={MARKET_IDS}
        value={market}
        onChange={setMarket}
        disabled
        disabledReason="Disabled: market data is not configured."
      />
      <NotAvailable>Scanning, scoring, edge and risk are not implemented yet.</NotAvailable>
    </section>
  );
}
