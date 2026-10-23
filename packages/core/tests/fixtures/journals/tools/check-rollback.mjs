/* global process, console */
// Test-support tool (not run by the test suite). Loads a journal with an OLDER built copy of the app, on a temporary
// COPY, exercises read and write paths, and reports what the older build did. It documents the rollback limitation:
// an older build can load a newer journal, but its own writes carry none of the newer provenance or safeguards.
//
//   node check-rollback.mjs <repo root built at the older commit> <journal file> <work copy path> [openTradeId]
//
// Never point it at a real journal: it only ever reads the source file and writes the work copy.
import { copyFileSync, readFileSync } from "node:fs";

const [root, src, work, openId] = process.argv.slice(2);
if (!root || !src || !work || src === work) throw new Error("usage: check-rollback.mjs <root> <journal> <work copy> [openTradeId]");
copyFileSync(src, work);
const { createPaperTradingService } = await import(`${root}/packages/core/dist/index.js`);
const { FileJournalRepository } = await import(`${root}/apps/api/dist/persistence/FileJournalRepository.js`);
let ms = Date.parse("2026-10-02T04:30:00.000Z");
const now = () => { const s = new Date(ms).toISOString(); ms += 1000; return s; };
const svc = createPaperTradingService({ repository: new FileJournalRepository({ filePath: work, now }), now, newId: () => `rollback-${ms}` });
const report = {};
const attempt = async (name, fn) => { try { report[name] = await fn(); } catch (e) { report[name] = `THREW ${e.code ?? ""} ${String(e.message).slice(0, 160)}`; } };
await attempt("listTrades", async () => (await svc.listTrades()).length);
await attempt("listEvents", async () => (await svc.listEvents()).length);
await attempt("exportJournal", async () => (await svc.exportJournal()).counts);
if (openId) {
  const CE = { provider: "manual", id: "NIFTY|2026-10-06|CE|22900" }, PE = { provider: "manual", id: "NIFTY|2026-10-06|PE|22800" };
  // An event asOf is sent because 1d21f06 requires one; later builds validate it and keep server time authoritative.
  const body = (asOf) => ({ quotes: [{ instrument: CE, bid: 71, ask: 71.5 }, { instrument: PE, bid: 53, ask: 53.5 }], asOf });
  await attempt("monitor", async () => { const r = await svc.monitor(openId, body(new Date(ms).toISOString())); return r.ok ? { ok: true, lastMonitorKeys: Object.keys(r.value.lastMonitor) } : r.error.code; });
  await attempt("exit", async () => { const r = await svc.exit(openId, body(new Date(ms).toISOString())); return r.ok ? { ok: true, valuationStatus: r.value.exit.valuationStatus ?? null, exitKeys: Object.keys(r.value.exit) } : r.error.code; });
}
report.fileRewritten = readFileSync(src, "utf8") !== readFileSync(work, "utf8");
console.log(JSON.stringify(report, null, 2));
