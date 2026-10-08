import { LiveOrdersDisabledError } from "@nsest/core";
import type { OrderProvider, OrderReceipt } from "@nsest/core";

/** Every order operation rejects with LIVE_ORDERS_DISABLED. There is no live-order path in V2 Phase 1A. */
export class DisabledOrderProvider implements OrderProvider {
  placeOrder(): Promise<OrderReceipt> {
    return Promise.reject(new LiveOrdersDisabledError());
  }
  modifyOrder(): Promise<OrderReceipt> {
    return Promise.reject(new LiveOrdersDisabledError());
  }
  cancelOrder(): Promise<OrderReceipt> {
    return Promise.reject(new LiveOrdersDisabledError());
  }
}
