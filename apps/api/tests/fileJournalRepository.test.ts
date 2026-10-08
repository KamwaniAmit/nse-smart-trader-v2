import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPaperTradingService } from "@nsest/core";
import type { NewJournalEvent, PaperTradeRecord } from "@nsest/core";
import { FileJournalRepository } from "../src/persistence/FileJournalRepository.js";

let dir: string;
let file: string;
let idCounter = 0; // shared by every service instance, so separate instances never reuse an id
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nsest-journal-"));
  file = join(dir, "nested", "paper-journal.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const raw = (over: Record<string, unknown> = {}) => ({
  source: "LONG_VOL", marketId: "NIFTY", structure: "STRADDLE", expiry: "2026-10-06", lotSize: 65, asOf: "2026-09-28T10:00:00+05:30",
  legs: [
    { optionType: "CE", strike: 22850, quote: { bid: 100, ask: 101, volume: 9000, oi: 20000, bidQty: 6500, askQty: 6500 } },
    { optionType: "PE", strike: 22850, quote: { bid: 90, ask: 91, volume: 9000, oi: 20000, bidQty: 6500, askQty: 6500 } },
  ],
  spot: 22850, tradingDaysToExpiry: 8, maxCapitalAllocation: 100000, entryCosts: 250, requestedLots: 1, ...over,
});
const make = (path = file) => {
  let n = 0;
  const repository = new FileJournalRepository({ filePath: path, now: () => "2026-09-28T12:00:00Z" });
  const service = createPaperTradingService({ repository, now: () => `2026-09-28T10:00:${String(n++ % 60).padStart(2, "0")}Z`, newId: () => `${++idCounter}` });
  return { repository, service };
};
const ev = (id: string): NewJournalEvent => ({ timestamp: "t", type: "REVIEW_STARTED", tradeId: id, fromState: "CANDIDATE", toState: "PAPER_REVIEW" });
async function review(s: ReturnType<typeof make>, over: Record<string, unknown> = {}): Promise<PaperTradeRecord> {
  const r = await s.service.beginReview(raw(over));
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

describe("FileJournalRepository: basic operations", () => {
  it("starts empty, and does not create the file until something is written", async () => {
    const { repository } = make();
    expect(await repository.listTrades()).toEqual([]);
    expect(await repository.listEvents()).toEqual([]);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the folder and writes a valid, human-readable JSON file on the first write", async () => {
    const s = make();
    const t = await review(s);
    const onDisk = JSON.parse(await readFile(file, "utf8")) as { schemaVersion: number; trades: Record<string, unknown>; events: unknown[]; nextSequence: number };
    expect(onDisk.schemaVersion).toBe(1);
    expect(Object.keys(onDisk.trades)).toEqual([t.tradeId]);
    expect(onDisk.events).toHaveLength(1);
    expect(onDisk.nextSequence).toBe(2);
    expect(await readFile(file, "utf8")).toMatch(/^\{\n {2}"schemaVersion": 1,/);
  });

  it("creates, retrieves, updates and lists through the shared rules", async () => {
    const s = make();
    const t = await review(s);
    expect((await s.repository.getTrade(t.tradeId))?.state).toBe("PAPER_REVIEW");
    const c = await s.service.confirm(t.tradeId, { confirmed: true });
    expect(c.ok && c.value.state).toBe("PAPER_OPEN");
    expect((await s.repository.listTrades({ states: ["PAPER_OPEN"] })).length).toBe(1);
    expect((await s.repository.listEvents({ tradeId: t.tradeId })).map((e) => e.type)).toEqual(["REVIEW_STARTED", "TRADE_OPENED"]);
  });

  it("enforces the same rules as the in-memory repository: duplicate ids and illegal transitions are refused", async () => {
    const s = make();
    const t = await review(s);
    await expect(s.repository.createTrade(t, ev(t.tradeId))).rejects.toMatchObject({ code: "TRADE_EXISTS" });
    await expect(s.repository.updateLifecycle(t.tradeId, { updatedAt: "t", state: "PAPER_EXITED" }, { ...ev(t.tradeId), type: "TRADE_EXITED", toState: "PAPER_EXITED" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("exports everything as JSON using its clock", async () => {
    const s = make();
    await review(s);
    const x = await s.repository.exportJournal();
    expect(x).toMatchObject({ exportedAt: "2026-09-28T12:00:00Z", counts: { trades: 1, events: 1 } });
  });
});

describe("FileJournalRepository: persistence and reload", () => {
  it("a NEW repository instance reads back exactly what was stored, including the immutable entry snapshot", async () => {
    const a = make();
    const t = await review(a);
    const opened = await a.service.confirm(t.tradeId, { confirmed: true });
    if (!opened.ok) throw new Error("confirm failed");

    const b = make();
    const reloaded = await b.repository.getTrade(t.tradeId);
    expect(reloaded).toEqual(opened.value);
    expect(reloaded?.entry?.combinedEntryPremium).toBe(192);
    expect(Object.isFrozen(reloaded?.entry)).toBe(true);
    expect((await b.repository.listEvents()).map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("event sequence numbers continue after a reload (no reuse)", async () => {
    const a = make();
    await review(a);
    const b = make();
    const t2 = await review(b);
    expect((await b.repository.listEvents({ tradeId: t2.tradeId }))[0]?.sequence).toBe(2);
  });

  it("after a reload the lifecycle continues: monitor, exit and the final state persist", async () => {
    const a = make();
    const t = await review(a);
    await a.service.confirm(t.tradeId, { confirmed: true });
    const ids = t.candidate.legs.map((l) => l.instrument);
    const b = make();
    const exited = await b.service.exit(t.tradeId, { quotes: [{ instrument: ids[0], bid: 95 }, { instrument: ids[1], bid: 85 }] });
    expect(exited.ok && exited.value.state).toBe("PAPER_EXITED");
    const c = make();
    expect((await c.repository.getTrade(t.tradeId))?.realizedPnl?.grossPnl).toBe(-65 * 12);
  });

  it("a missing file is an empty journal, not an error", async () => {
    expect(await make(join(dir, "does-not-exist.json")).repository.listTrades()).toEqual([]);
  });
});

describe("FileJournalRepository: write safety", () => {
  it("leaves no temporary file behind after writes", async () => {
    const s = make();
    await review(s);
    await review(s);
    expect((await readdir(join(dir, "nested"))).sort()).toEqual(["paper-journal.json"]);
  });

  it("serializes concurrent operations: 25 parallel reviews are all stored with contiguous sequence numbers", async () => {
    const s = make();
    const results = await Promise.all(Array.from({ length: 25 }, () => s.service.beginReview(raw())));
    expect(results.every((r) => r.ok)).toBe(true);
    const events = await s.repository.listEvents();
    expect(events.map((e) => e.sequence)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    const reread = make();
    expect((await reread.repository.listTrades()).length).toBe(25);
  });

  it("a failed write is reported (STORAGE_IO) and does NOT change the in-memory state", async () => {
    const s = make();
    const first = await review(s);
    // Sabotage: replace the journal file by a non-empty directory, so the atomic rename must fail.
    await rm(file);
    await mkdir(join(file, "blocker"), { recursive: true });
    const failed = await s.service.beginReview(raw());
    expect(failed.ok).toBe(false);
    expect(!failed.ok && failed.error.code).toBe("STORAGE_ERROR");
    expect((await s.repository.listTrades()).map((t) => t.tradeId)).toEqual([first.tradeId]); // unchanged
    expect((await s.repository.listEvents()).length).toBe(1);
    // Repair the disk: the next write succeeds and contains exactly the retained state plus the new trade.
    await rm(file, { recursive: true, force: true });
    const ok = await s.service.beginReview(raw());
    expect(ok.ok).toBe(true);
    expect((await make().repository.listTrades()).length).toBe(2);
  });
});

describe("FileJournalRepository: bad files fail closed and are never overwritten", () => {
  const corruptCases: Array<[string, string, string]> = [
    ["not JSON", "this is { not json", "STORAGE_CORRUPT"],
    ["valid JSON but not a journal", JSON.stringify({ hello: "world" }), "STORAGE_CORRUPT"],
    ["an empty file", "", "STORAGE_CORRUPT"],
    ["a future schema version", JSON.stringify({ schemaVersion: 99, nextSequence: 1, trades: {}, events: [] }), "STORAGE_VERSION_UNSUPPORTED"],
  ];
  it.each(corruptCases)("%s -> %s on read, and the file is left byte-for-byte untouched", async (_name, content, code) => {
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(file, content, "utf8");
    const s = make();
    await expect(s.repository.listTrades()).rejects.toMatchObject({ code });
    const created = await s.service.beginReview(raw());
    expect(created.ok).toBe(false); // a write is refused too: the bad file is never replaced
    expect(await readFile(file, "utf8")).toBe(content);
  });
});
