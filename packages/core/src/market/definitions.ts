import { MARKET_DISPLAY_NAMES, MARKET_IDS } from "../contracts/index.js";
import type { MarketCategory, MarketId } from "../contracts/index.js";
import type { BrokerRef } from "../instruments/brokerRef.js";

/** A value that is either explicitly unresolved or resolved from a named source. Never guessed. */
export type Unresolved<T> =
  | { readonly status: "UNRESOLVED"; readonly reason: string }
  | { readonly status: "RESOLVED"; readonly value: T; readonly source: string };

export interface MarketDefinition {
  readonly marketId: MarketId;
  readonly displayName: string;
  readonly category: MarketCategory;
  readonly requiresExplicitResolution: boolean;
  readonly exchange: Unresolved<string>;
  readonly segment: Unresolved<string>;
  readonly underlyingKind: Unresolved<string>;
  readonly instrumentKey: Unresolved<BrokerRef>;
  readonly lotSize: Unresolved<number>;
  readonly tickSize: Unresolved<number>;
  readonly expiryRules: Unresolved<string>;
  readonly strikeRules: Unresolved<string>;
  readonly tradingHours: Unresolved<string>;
  readonly currency: Unresolved<string>;
  readonly derivativesAvailability: Unresolved<boolean>;
}

const CATEGORY: Readonly<Record<MarketId, MarketCategory>> = {
  NIFTY: "INDEX",
  BANKNIFTY: "INDEX",
  SMALLCAP: "INDEX",
  GOLD: "COMMODITY",
  SILVER: "COMMODITY",
  CRUDEOIL: "COMMODITY",
};

export const NOT_CONFIGURED_REASON =
  "Not configured: requires broker-verified instrument data. No broker is connected in Phase 1A.";
export const SMALLCAP_NOT_CONFIGURED_REASON =
  "SMALL CAP is not a defined instrument. It must be explicitly resolved against a real broker-supported instrument; nothing is substituted.";

function unresolved(reason: string): Unresolved<never> {
  return Object.freeze({ status: "UNRESOLVED" as const, reason });
}

export function getMarketDefinitions(): readonly MarketDefinition[] {
  return Object.freeze(
    MARKET_IDS.map((marketId): MarketDefinition => {
      const reason = marketId === "SMALLCAP" ? SMALLCAP_NOT_CONFIGURED_REASON : NOT_CONFIGURED_REASON;
      return Object.freeze({
        marketId,
        displayName: MARKET_DISPLAY_NAMES[marketId],
        category: CATEGORY[marketId],
        requiresExplicitResolution: marketId === "SMALLCAP",
        exchange: unresolved(reason),
        segment: unresolved(reason),
        underlyingKind: unresolved(reason),
        instrumentKey: unresolved(reason),
        lotSize: unresolved(reason),
        tickSize: unresolved(reason),
        expiryRules: unresolved(reason),
        strikeRules: unresolved(reason),
        tradingHours: unresolved(reason),
        currency: unresolved(reason),
        derivativesAvailability: unresolved(reason),
      });
    }),
  );
}
