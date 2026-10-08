import { ProviderNotAvailableError } from "@nsest/core";
import type { BrokerAdapter } from "@nsest/core";
import { NullBrokerAdapter } from "./none/index.js";

/** Phase 1A accepts exactly one provider name: "none". Anything else fails closed. */
export function getBrokerAdapter(provider: string): BrokerAdapter {
  if (provider === "none") return new NullBrokerAdapter();
  throw new ProviderNotAvailableError(provider);
}
