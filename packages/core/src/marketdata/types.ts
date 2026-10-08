import type { MarketId } from "../contracts/index.js";
import type { BrokerRef } from "../instruments/brokerRef.js";

// Normalized market data. Any numeric field may be null (= unavailable; never guessed).
// IV convention: 0.18 means 18%.

export interface NormalizedGreeks {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

export interface NormalizedQuote {
  marketId: MarketId | null;
  instrument: BrokerRef | null;
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  asOf: string | null;
}

export type OptionType = "CE" | "PE";

export interface NormalizedOptionLeg {
  instrument: BrokerRef | null;
  optionType: OptionType;
  strike: number | null;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  ltp: number | null;
  volume: number | null;
  oi: number | null;
  iv: number | null;
  greeks: NormalizedGreeks | null;
  quoteTimestamp: string | null;
}

export interface NormalizedOptionChainRow {
  strike: number;
  ce: NormalizedOptionLeg | null;
  pe: NormalizedOptionLeg | null;
}

export interface NormalizedOptionChain {
  marketId: MarketId;
  expiry: string | null;
  spot: number | null;
  rows: NormalizedOptionChainRow[];
  asOf: string | null;
}

export interface NormalizedCandle {
  timestamp: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  oi: number | null;
}
