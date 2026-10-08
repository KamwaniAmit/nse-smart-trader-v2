import { assertNoSubstitution, getMarketDefinitions } from "@nsest/core";
import type { BrokerAdapter, HealthResponse, MarketsResponse, MarketSummaryDTO } from "@nsest/core";
import type { ServerConfig } from "./config.js";

// Plain functions: no Express types, so they can be unit-tested and later hosted anywhere.

export async function getHealth(config: ServerConfig, adapter: BrokerAdapter): Promise<HealthResponse> {
  const session = await adapter.session.getSessionStatus();
  return {
    status: "ok",
    phase: "1A",
    brokerProvider: config.brokerProvider,
    brokerConnected: session.status === "CONNECTED",
    liveOrdersEnabled: config.liveOrdersEnabled,
  };
}

export async function getMarkets(adapter: BrokerAdapter): Promise<MarketsResponse> {
  const markets: MarketSummaryDTO[] = [];
  for (const definition of getMarketDefinitions()) {
    const result = await adapter.resolver.resolveMarket(definition.marketId);
    assertNoSubstitution(definition.marketId, result);
    markets.push({
      marketId: definition.marketId,
      displayName: definition.displayName,
      category: definition.category,
      status: result.status,
      reason: result.status === "RESOLVED" ? "Resolved by broker adapter." : result.reason,
      requiresExplicitResolution: definition.requiresExplicitResolution,
    });
  }
  return { markets };
}
