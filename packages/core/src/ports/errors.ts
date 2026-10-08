export class LiveOrdersDisabledError extends Error {
  readonly code = "LIVE_ORDERS_DISABLED";
  constructor() {
    super("LIVE_ORDERS_DISABLED: live order placement is disabled.");
    this.name = "LiveOrdersDisabledError";
  }
}

export class ProviderNotAvailableError extends Error {
  readonly code = "PROVIDER_NOT_AVAILABLE";
  constructor(provider: string) {
    super(`PROVIDER_NOT_AVAILABLE: broker provider "${provider}" is not available.`);
    this.name = "ProviderNotAvailableError";
  }
}
