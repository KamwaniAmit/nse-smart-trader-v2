import { MARKET_DISPLAY_NAMES } from "@nsest/core/contracts";
import type { MarketId } from "@nsest/core/contracts";

interface MarketSelectorProps {
  markets: readonly MarketId[];
  value: MarketId | "";
  onChange: (marketId: MarketId) => void;
  disabled?: boolean;
  disabledReason?: string;
}

export function MarketSelector({ markets, value, onChange, disabled = false, disabledReason }: MarketSelectorProps) {
  return (
    <div className="field">
      <label htmlFor="market-selector">Market</label>
      <select
        id="market-selector"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as MarketId)}
      >
        <option value="">Select a market…</option>
        {markets.map((marketId) => (
          <option key={marketId} value={marketId} disabled={disabled}>
            {MARKET_DISPLAY_NAMES[marketId]}
          </option>
        ))}
      </select>
      {disabled && disabledReason ? <p className="hint">{disabledReason}</p> : null}
    </div>
  );
}
