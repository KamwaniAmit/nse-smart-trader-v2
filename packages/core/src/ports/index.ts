import type { MarketId } from "../contracts/index.js";
import type { BrokerRef } from "../instruments/brokerRef.js";
import type { InstrumentResolver } from "../instruments/resolver.js";
import type { NormalizedCandle, NormalizedOptionChain, NormalizedQuote } from "../marketdata/types.js";

export * from "./errors.js";

/** Every read port answers in this shape. NOT_CONNECTED is a normal, expected answer. */
export type PortResult<T> =
  | { status: "OK"; data: T }
  | { status: "NOT_CONNECTED" }
  | { status: "DATA_INSUFFICIENT"; reason: string };

export interface BrokerSessionProvider {
  getSessionStatus(): Promise<{ status: "CONNECTED" | "NOT_CONNECTED" }>;
}

export interface QuoteProvider {
  getQuote(instrument: BrokerRef): Promise<PortResult<NormalizedQuote>>;
}

export interface MarketDataProvider {
  getUnderlyingQuote(marketId: MarketId): Promise<PortResult<NormalizedQuote>>;
}

export interface OptionChainProvider {
  listExpiries(marketId: MarketId): Promise<PortResult<string[]>>;
  getOptionChain(marketId: MarketId, expiry: string): Promise<PortResult<NormalizedOptionChain>>;
}

export interface HistoricalDataProvider {
  getDailyCandles(marketId: MarketId, fromDate: string, toDate: string): Promise<PortResult<NormalizedCandle[]>>;
}

export interface TradingCalendarProvider {
  getTradingDaysToExpiry(marketId: MarketId, asOfDate: string, expiry: string): Promise<PortResult<number>>;
}

export interface OrderIntent {
  marketId: MarketId;
  instrument: BrokerRef;
  side: "BUY" | "SELL";
  quantity: number;
  limitPrice: number | null;
}

export interface OrderReceipt {
  orderId: string;
  status: string;
}

export interface OrderProvider {
  placeOrder(intent: OrderIntent): Promise<OrderReceipt>;
  modifyOrder(orderId: string, changes: Partial<Pick<OrderIntent, "quantity" | "limitPrice">>): Promise<OrderReceipt>;
  cancelOrder(orderId: string): Promise<OrderReceipt>;
}

/** Everything a broker implementation must supply. The strategy engine sees only these ports. */
export interface BrokerAdapter {
  readonly name: string;
  readonly session: BrokerSessionProvider;
  readonly resolver: InstrumentResolver;
  readonly quotes: QuoteProvider;
  readonly marketData: MarketDataProvider;
  readonly optionChains: OptionChainProvider;
  readonly historical: HistoricalDataProvider;
  readonly calendar: TradingCalendarProvider;
  readonly orders: OrderProvider;
}
