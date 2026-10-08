# Legacy Boundary

The previous Upstox/Vercel application is **frozen** at the tag:

```
FROZEN-UPSTOX-434-PASS
```

It achieved a regression baseline of 434/434 PASS. That number is a historical reference only; it is not part of this project's baseline.

## Rules

1. Legacy code is not copied into V2, imported, or referenced.
2. The legacy repository is never modified from V2 work.
3. The legacy browser storage namespace `niftyAiTrader.*` must never be read by V2. V2 imports no legacy paper trades and shows no legacy trade as active.
4. The Paper Trading page has an "Archived (Legacy)" tab that is empty by design. Phase 1B keeps it empty: legacy trades are never imported or read.
5. The frozen strategy definitions are re-stated in `STRATEGY_FREEZE.md`, not copied as code.
6. Legacy historical research (the certified NIFTY/VIX dataset and the closed Upstox investigation) remains a reference and is not part of this repository.

## Enforcement

`tests/architecture/security.test.ts` fails if any production source mentions the legacy storage namespace.
