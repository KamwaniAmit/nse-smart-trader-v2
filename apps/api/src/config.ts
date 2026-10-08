export type AppEnv = "development" | "test" | "production";

export interface ServerConfig {
  readonly appEnv: AppEnv;
  readonly apiPort: number;
  readonly brokerProvider: "none";
  readonly liveOrdersEnabled: false;
}

export class ConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Loads and validates server configuration. Fails closed:
 *  - only BROKER_PROVIDER=none is accepted in Phase 1A
 *  - LIVE_ORDERS_ENABLED must be exactly "false" (default) — anything else is refused
 */
export function loadServerConfig(env: Env = process.env): ServerConfig {
  const appEnv = (env.APP_ENV ?? "development").trim();
  if (appEnv !== "development" && appEnv !== "test" && appEnv !== "production") {
    throw new ConfigError("INVALID_APP_ENV", `APP_ENV must be development, test or production (got "${appEnv}").`);
  }

  const rawPort = (env.API_PORT ?? "8787").trim();
  const apiPort = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new ConfigError("INVALID_API_PORT", `API_PORT must be an integer from 1 to 65535 (got "${rawPort}").`);
  }

  const brokerProvider = (env.BROKER_PROVIDER ?? "none").trim();
  if (brokerProvider !== "none") {
    throw new ConfigError(
      "PROVIDER_NOT_AVAILABLE",
      `BROKER_PROVIDER must be "none" in Phase 1A (got "${brokerProvider}").`,
    );
  }

  const rawLive = (env.LIVE_ORDERS_ENABLED ?? "false").trim().toLowerCase();
  if (rawLive !== "false") {
    throw new ConfigError(
      "LIVE_ORDERS_MUST_REMAIN_DISABLED",
      "LIVE_ORDERS_ENABLED must be false. Live order placement does not exist in V2 Phase 1A.",
    );
  }

  return { appEnv, apiPort, brokerProvider: "none", liveOrdersEnabled: false };
}
