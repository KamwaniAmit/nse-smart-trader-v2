# Open Decisions

Nothing below is decided. Phase 1A deliberately avoids pre-empting any of these.

1. **Persistence / storage.** Multi-user sessions, stored broker tokens, and the journal all need durable storage, but no database or hosted storage service is approved. Phase 1A has no persistence. Must be decided before the broker-auth phase.
2. **Hosting / server architecture.** The API is a local Express server. A hosted environment may prefer serverless functions. Handlers are plain functions to keep either option open.
3. **PAPER_EXPIRED vs PAPER_AUTO_CLOSED.** Both exist in the contract. Proposed meaning: PAPER_EXPIRED = expiry passed with no valid exit price (exit stays null); PAPER_AUTO_CLOSED = closed by a safety rule. One may be removed.
4. **Best Opportunities exit rule.** LONG VOL has a defined exit rule; Best Opportunities does not. Undefined for now.
5. **Commodity underlying definition.** Gold, silver and crude options normally sit on futures, not a spot index. Which instrument is "spot", and which series feeds RV20, is unresolved. The market definition keeps `underlyingKind` UNRESOLVED.
6. **FYERS authentication implementation.** Deferred until FYERS account verification and explicit authorization. Use the current FYERS API v3 auth-code flow, server-side only.
7. **Small Cap instrument definition.** SMALL CAP is not defined. It must be resolved against a real broker-supported instrument or stay NOT_CONFIGURED.

## Smaller notes

- **Risk inputs.** The original specification lists "Expected Net Edge quality" as a possible risk factor while also requiring Risk to be separate from Expected Net Edge. The risk-input list in core keeps that name for now; confirm in the Risk phase whether an edge-quality input is acceptable.
- **Risk thresholds.** None exist. They must be proposed, documented and approved before any LOW/MEDIUM/HIGH classification is implemented.
- **Best Opportunities risk filter.** The legacy filter allowed multiple selections (HIGH/MEDIUM); the new requirement is a single selection ALL/LOW/MEDIUM/HIGH. Default assumed: ALL.
- **PWA.** Phase 1A includes a web manifest only. A service worker is deferred, because caching API responses needs a deliberate design.
- **CORS.** The API allows only the local Vite dev origin, GET only. Revisit with the hosting decision.
