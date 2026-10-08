/** Opaque broker-side identifier. `provider` is a plain string; core never branches on it. */
export interface BrokerRef {
  readonly provider: string;
  readonly id: string;
}
