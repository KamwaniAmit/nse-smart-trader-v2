import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { getBrokerAdapter } from "@nsest/adapters";
import { MARKET_IDS } from "@nsest/core";
import type { HealthResponse, MarketsResponse } from "@nsest/core";
import { createApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { getHealth, getMarkets } from "../src/handlers.js";

const config = loadServerConfig({});

describe("handlers (plain functions)", () => {
  it("getHealth reports phase 1A, provider none, not connected, live orders off", async () => {
    expect(await getHealth(config, getBrokerAdapter("none"))).toEqual<HealthResponse>({
      status: "ok",
      phase: "1A",
      brokerProvider: "none",
      brokerConnected: false,
      liveOrdersEnabled: false,
    });
  });

  it("getMarkets returns all six markets, all NOT_CONFIGURED", async () => {
    const body = await getMarkets(getBrokerAdapter("none"));
    expect(body.markets.map((m) => m.marketId)).toEqual([...MARKET_IDS]);
    expect(body.markets.every((m) => m.status === "NOT_CONFIGURED")).toBe(true);
  });

  it("marks SMALL CAP as requiring explicit resolution", async () => {
    const body = await getMarkets(getBrokerAdapter("none"));
    const flagged = body.markets.filter((m) => m.requiresExplicitResolution).map((m) => m.marketId);
    expect(flagged).toEqual(["SMALLCAP"]);
  });
});

// Real HTTP against this project's own server on an ephemeral loopback port. No external network.
function get(port: number, path: string, method = "GET"): Promise<{ status: number; body: unknown; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as unknown, contentType: String(res.headers["content-type"]) }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("HTTP API", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createApp(config).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("GET /api/health", async () => {
    const res = await get(port, "/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", phase: "1A", brokerProvider: "none", brokerConnected: false, liveOrdersEnabled: false });
  });

  it("GET /api/markets returns six markets, all NOT_CONFIGURED", async () => {
    const res = await get(port, "/api/markets");
    expect(res.status).toBe(200);
    const body = res.body as MarketsResponse;
    expect(body.markets).toHaveLength(6);
    expect(body.markets.every((m) => m.status === "NOT_CONFIGURED")).toBe(true);
  });

  it("unknown routes return JSON 404", async () => {
    const res = await get(port, "/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.contentType).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "NOT_FOUND" });
  });

  it("non-GET methods on a known path are also a JSON 404 (read-only API)", async () => {
    const res = await get(port, "/api/health", "POST");
    expect(res.status).toBe(404);
  });
});
