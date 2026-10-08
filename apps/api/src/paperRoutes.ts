import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { JournalRepositoryError, PAPER_LIFECYCLE_STATES, RISK_FILTER_OPTIONS } from "@nsest/core";
import type { ApiErrorBody, PaperErrorCode, PaperLifecycleState, PaperTradingService, RiskFilter, ServiceResult } from "@nsest/core";

// Phase 1B paper-trading routes, mounted at /api/paper. Pure HTTP translation: all rules live in core.
// There is deliberately NO order, broker, login or authentication route here.

const STATUS: Readonly<Record<PaperErrorCode, number>> = {
  INVALID_REQUEST: 400,
  CONFIRMATION_REQUIRED: 400,
  NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  DATA_INSUFFICIENT: 422,
  CAPITAL_GATE_FAILED: 422,
  LOTS_UNRESOLVED: 422,
  STORAGE_ERROR: 500,
};

function send<T>(res: Response, result: ServiceResult<T>, okStatus = 200): void {
  if (result.ok) {
    res.status(okStatus).json(result.value);
    return;
  }
  const { code, message, details, trade } = result.error;
  const body: ApiErrorBody = { error: code, message, ...(details ? { details } : {}), ...(trade ? { trade } : {}) };
  res.status(STATUS[code]).json(body);
}

const bad = (res: Response, message: string, details?: string[]): void => {
  const body: ApiErrorBody = { error: "INVALID_REQUEST", message, ...(details ? { details } : {}) };
  res.status(400).json(body);
};

type Handler = (req: Request, res: Response) => Promise<void> | void;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction): void => {
  Promise.resolve(fn(req, res)).catch((err: unknown) => {
    // Storage problems (corrupt or unreadable journal file) are reported clearly rather than as a generic 500.
    if (err instanceof JournalRepositoryError) {
      const body: ApiErrorBody = { error: "STORAGE_ERROR", message: err.message };
      res.status(500).json(body);
      return;
    }
    next(err);
  });
};

const asList = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value]).flatMap((v) => String(v).split(",")).map((s) => s.trim()).filter((s) => s !== "");

export function createPaperRouter(service: PaperTradingService): Router {
  const router = Router();
  // Only application/json bodies are parsed; anything else leaves req.body undefined and is rejected as INVALID_REQUEST.
  router.use(express.json({ limit: "256kb" }));

  router.get("/trades", wrap(async (req, res) => {
    const states = asList(req.query["state"]);
    const unknownState = states.find((s) => !(PAPER_LIFECYCLE_STATES as readonly string[]).includes(s));
    if (unknownState !== undefined) return bad(res, `Unknown state "${unknownState}".`, [`state must be one of ${PAPER_LIFECYCLE_STATES.join(", ")}`]);
    const riskRaw = req.query["risk"];
    if (riskRaw !== undefined && !(typeof riskRaw === "string" && (RISK_FILTER_OPTIONS as readonly string[]).includes(riskRaw))) {
      return bad(res, "Unknown risk filter.", [`risk must be one of ${RISK_FILTER_OPTIONS.join(", ")}`]);
    }
    const trades = await service.listTrades({
      ...(states.length > 0 ? { states: states as PaperLifecycleState[] } : {}),
      ...(typeof riskRaw === "string" ? { risk: riskRaw as RiskFilter } : {}),
    });
    res.json({ trades });
  }));

  router.get("/trades/:id", wrap(async (req, res) => send(res, await service.getTrade(String(req.params["id"])))));

  router.get("/journal", wrap(async (req, res) => {
    const tradeId = req.query["tradeId"];
    res.json({ events: await service.listEvents(typeof tradeId === "string" ? { tradeId } : undefined) });
  }));

  router.get("/export", wrap(async (_req, res) => {
    const exported = await service.exportJournal();
    const stamp = exported.exportedAt.replace(/[^0-9]/g, "").slice(0, 14);
    res.setHeader("Content-Disposition", `attachment; filename="paper-journal-${stamp}.json"`);
    res.json(exported);
  }));

  router.post("/assess", wrap((req, res) => send(res, service.assess(req.body as unknown))));
  router.post("/review", wrap(async (req, res) => send(res, await service.beginReview(req.body as unknown), 201)));
  router.post("/trades/:id/confirm", wrap(async (req, res) => send(res, await service.confirm(String(req.params["id"]), req.body as unknown))));
  router.post("/trades/:id/monitor", wrap(async (req, res) => send(res, await service.monitor(String(req.params["id"]), req.body as unknown))));
  router.post("/trades/:id/exit", wrap(async (req, res) => send(res, await service.exit(String(req.params["id"]), req.body as unknown))));
  router.post("/trades/:id/safety-check", wrap(async (req, res) => send(res, await service.runSafetyCheck(String(req.params["id"]), req.body as unknown))));

  return router;
}
