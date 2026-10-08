import type { MarketId } from "../contracts/index.js";
import type { BrokerRef } from "./brokerRef.js";

export type ResolutionResult =
  | { readonly status: "RESOLVED"; readonly marketId: MarketId; readonly ref: BrokerRef }
  | { readonly status: "NOT_CONFIGURED"; readonly marketId: MarketId; readonly reason: string }
  | { readonly status: "DATA_INSUFFICIENT"; readonly marketId: MarketId; readonly reason: string };

export interface InstrumentResolver {
  resolveMarket(marketId: MarketId): Promise<ResolutionResult>;
}

/** Default resolver for Phase 1A: nothing is configured, nothing is guessed. */
export class NotConfiguredResolver implements InstrumentResolver {
  async resolveMarket(marketId: MarketId): Promise<ResolutionResult> {
    return {
      status: "NOT_CONFIGURED",
      marketId,
      reason:
        marketId === "SMALLCAP"
          ? "SMALL CAP requires explicit resolution against a real broker-supported instrument."
          : "No broker is connected; instrument is not configured.",
    };
  }
}

export class InstrumentSubstitutionError extends Error {
  readonly code = "INSTRUMENT_SUBSTITUTION";
  constructor(requested: MarketId, received: MarketId) {
    super(`Requested ${requested} but resolution returned ${received}. Substitution is forbidden.`);
    this.name = "InstrumentSubstitutionError";
  }
}

/** A requested market must never silently receive another market's instrument. */
export function assertNoSubstitution(requested: MarketId, result: ResolutionResult): void {
  if (result.marketId !== requested) {
    throw new InstrumentSubstitutionError(requested, result.marketId);
  }
}
