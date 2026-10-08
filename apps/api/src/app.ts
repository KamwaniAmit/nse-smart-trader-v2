import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { getBrokerAdapter } from "@nsest/adapters";
import type { BrokerAdapter } from "@nsest/core";
import type { ServerConfig } from "./config.js";
import { getHealth, getMarkets } from "./handlers.js";

// Local dev-server origins only. Read-only GET API; nothing else is allowed cross-origin.
const ALLOWED_DEV_ORIGINS: ReadonlySet<string> = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

export function createApp(config: ServerConfig, adapter: BrokerAdapter = getBrokerAdapter(config.brokerProvider)): Express {
  const app = express();
  app.disable("x-powered-by");

  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin !== undefined && ALLOWED_DEV_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET");
      res.setHeader("Vary", "Origin");
    }
    next();
  });

  app.get("/api/health", (_req: Request, res: Response, next: NextFunction) => {
    getHealth(config, adapter)
      .then((body) => res.json(body))
      .catch(next);
  });

  app.get("/api/markets", (_req: Request, res: Response, next: NextFunction) => {
    getMarkets(adapter)
      .then((body) => res.json(body))
      .catch(next);
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "NOT_FOUND" });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "INTERNAL_ERROR" });
  });

  return app;
}
