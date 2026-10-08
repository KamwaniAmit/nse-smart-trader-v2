import { describe, expect, it } from "vitest";
import { ConfigError, loadServerConfig } from "../src/config.js";

describe("loadServerConfig", () => {
  it("loads safe defaults from an empty environment", () => {
    expect(loadServerConfig({})).toEqual({ appEnv: "development", apiPort: 8787, brokerProvider: "none", liveOrdersEnabled: false });
  });

  it("loads the values in .env.example", () => {
    const config = loadServerConfig({ APP_ENV: "development", API_PORT: "8787", BROKER_PROVIDER: "none", LIVE_ORDERS_ENABLED: "false" });
    expect(config.apiPort).toBe(8787);
  });

  it("rejects any broker provider other than none", () => {
    expect(() => loadServerConfig({ BROKER_PROVIDER: "some-other-broker" })).toThrowError(ConfigError);
    try {
      loadServerConfig({ BROKER_PROVIDER: "some-other-broker" });
    } catch (error) {
      expect((error as ConfigError).code).toBe("PROVIDER_NOT_AVAILABLE");
    }
  });

  it("rejects LIVE_ORDERS_ENABLED=true", () => {
    try {
      loadServerConfig({ LIVE_ORDERS_ENABLED: "true" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ConfigError).code).toBe("LIVE_ORDERS_MUST_REMAIN_DISABLED");
    }
  });

  it("refuses every value for LIVE_ORDERS_ENABLED except false (fail closed)", () => {
    for (const value of ["TRUE", "1", "yes", "on", "maybe"]) {
      expect(() => loadServerConfig({ LIVE_ORDERS_ENABLED: value }), value).toThrowError(ConfigError);
    }
  });

  it("rejects an invalid port or environment name", () => {
    expect(() => loadServerConfig({ API_PORT: "abc" })).toThrowError(ConfigError);
    expect(() => loadServerConfig({ API_PORT: "70000" })).toThrowError(ConfigError);
    expect(() => loadServerConfig({ APP_ENV: "staging" })).toThrowError(ConfigError);
  });
});
