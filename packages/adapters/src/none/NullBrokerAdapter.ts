import { NotConfiguredResolver } from "@nsest/core";
import type {
  BrokerAdapter,
  BrokerSessionProvider,
  HistoricalDataProvider,
  InstrumentResolver,
  MarketDataProvider,
  OptionChainProvider,
  OrderProvider,
  QuoteProvider,
  TradingCalendarProvider,
} from "@nsest/core";
import { DisabledOrderProvider } from "./DisabledOrderProvider.js";

const notConnected = async (): Promise<{ status: "NOT_CONNECTED" }> => ({ status: "NOT_CONNECTED" });

/** The only adapter available in Phase 1A. Every read answers NOT_CONNECTED. It makes no network calls. */
export class NullBrokerAdapter implements BrokerAdapter {
  readonly name = "none";
  readonly session: BrokerSessionProvider = { getSessionStatus: notConnected };
  readonly resolver: InstrumentResolver = new NotConfiguredResolver();
  readonly quotes: QuoteProvider = { getQuote: notConnected };
  readonly marketData: MarketDataProvider = { getUnderlyingQuote: notConnected };
  readonly optionChains: OptionChainProvider = { listExpiries: notConnected, getOptionChain: notConnected };
  readonly historical: HistoricalDataProvider = { getDailyCandles: notConnected };
  readonly calendar: TradingCalendarProvider = { getTradingDaysToExpiry: notConnected };
  readonly orders: OrderProvider = new DisabledOrderProvider();
}
