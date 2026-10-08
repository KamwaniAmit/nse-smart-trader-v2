import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { getBrokerAdapter } from "@nsest/adapters";
import type { BrokerAdapter } from "@nsest/core";
import type { ServerConfig } from "./config.js";
import { getHealth, getMarkets } from "./handlers.js";
import { createPaperRouter } from "./paperRoutes.js";
import { createDefaultPaperService } from "./paperService.js";
import type { PaperTradingService } from "@nsest/core";

// Local dev-server origins only. Nothing else is allowed cross-origin.
const ALLOWED_DEV_ORIGINS: ReadonlySet<string> = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

export interface AppOptions {
  /** Phase 1B paper-trading service. Defaults to the file-backed one (created lazily; nothing is read or written until first use). */
  paperService?: PaperTradingService;
}

export function createApp(
  config: ServerConfig,
  adapter: BrokerAdapter = getBrokerAdapter(config.brokerProvider),
  options: AppOptions = {},
): Express {
  const app = express();
  app.disable("x-powered-by");

  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin !== undefined && ALLOWED_DEV_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
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

  // Phase 1B: paper trading. Broker-independent; no order, broker, login or authentication routes exist.
  app.use("/api/paper", createPaperRouter(options.paperService ?? createDefaultPaperService()));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "NOT_FOUND" });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = (err as { type?: string } | null)?.type;
    if (type === "entity.parse.failed") {
      res.status(400).json({ error: "INVALID_REQUEST", message: "The request body is not valid JSON." });
      return;
    }
    if (type === "entity.too.large") {
      res.status(413).json({ error: "INVALID_REQUEST", message: "The request body is too large." });
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR" });
  });

  return app;
}
