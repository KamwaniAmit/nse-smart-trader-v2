import { describe, expect, it } from "vitest";
import { InMemoryJournalRepository, JournalRepositoryError, JournalState, emptyJournalState, validateJournalState } from "../src/index.js";
import type { JournalStateData, NewJournalEvent, PaperTradeRecord } from "../src/index.js";
import { exitQuotes, longVolRaw, makeService } from "./fixtures.js";

/** A real PAPER_REVIEW record, produced by the service, to feed the journal rules directly. */
async function sampleTrade(over: Record<string, unknown> = {}): Promise<PaperTradeRecord> {
  const svc = makeService();
  const r = await svc.service.beginReview(longVolRaw(over));
  if (!r.ok) throw new Error("sample failed");
  return JSON.parse(JSON.stringify(r.value)) as PaperTradeRecord;
}
const ev = (tradeId: string | null, over: Partial<NewJournalEvent> = {}): NewJournalEvent => ({
  timestamp: "2026-09-28T10:00:00Z", type: "REVIEW_STARTED", tradeId, fromState: "CANDIDATE", toState: "PAPER_REVIEW", ...over,
});
const openedEvent = (id: string): NewJournalEvent => ({ timestamp: "t2", type: "TRADE_OPENED", tradeId: id, fromState: "PAPER_REVIEW", toState: "PAPER_OPEN" });
const raises = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(JournalRepositoryError);
    expect((e as JournalRepositoryError).code).toBe(code);
    return;
  }
  throw new Error(`expected JournalRepositoryError ${code}`);
};

describe("journal: create and retrieve", () => {
  it("creates a trade with its first event and retrieves it", async () => {
    const s = new JournalState();
    const t = await sampleTrade();
    s.createTrade(t, ev(t.tradeId));
    expect(s.getTrade(t.tradeId)).toEqual(t);
    expect(s.listEvents()).toHaveLength(1);
    expect(s.listEvents()[0]).toMatchObject({ sequence: 1, type: "REVIEW_STARTED", tradeId: t.tradeId });
  });
  it("returns null for an unknown trade", () => expect(new JournalState().getTrade("pt_nope")).toBeNull());
  it("rejects a duplicate trade id (TRADE_EXISTS)", async () => {
    const s = new JournalState();
    const t = await sampleTrade();
    s.createTrade(t, ev(t.tradeId));
    raises(() => s.createTrade(t, ev(t.tradeId)), "TRADE_EXISTS");
    expect(s.listEvents()).toHaveLength(1);
  });
  it("a new trade can only start in PAPER_REVIEW or DATA_INSUFFICIENT", async () => {
    const t = { ...(await sampleTrade()), state: "PAPER_OPEN" as const };
    raises(() => new JournalState().createTrade(t, ev(t.tradeId)), "INVALID_TRANSITION");
  });
  it("a new trade cannot already carry an entry snapshot", async () => {
    const svc = makeService();
    const r = await svc.service.beginReview(longVolRaw());
    if (!r.ok) throw new Error("x");
    const c = await svc.service.confirm(r.value.tradeId, { confirmed: true });
    if (!c.ok) throw new Error("y");
    const withEntry = JSON.parse(JSON.stringify({ ...c.value, state: "PAPER_REVIEW" })) as PaperTradeRecord;
    raises(() => new JournalState().createTrade(withEntry, ev(withEntry.tradeId)), "INVALID_RECORD");
  });
  it("the creation event must refer to the new trade", async () => {
    const t = await sampleTrade();
    raises(() => new JournalState().createTrade(t, ev("someone_else")), "INVALID_RECORD");
  });
});

describe("journal: update lifecycle and append events", () => {
  it("applies the patch and appends the event atomically; sequence numbers increase by 1", async () => {
    const s = new JournalState();
    const t = await sampleTrade();
    s.createTrade(t, ev(t.tradeId));
    const svc = makeService();
    const r = await svc.service.beginReview(longVolRaw());
    const c = r.ok ? await svc.service.confirm(r.value.tradeId, { confirmed: true }) : null;
    const entry = c && c.ok ? c.value.entry : null;
    if (!entry) throw new Error("no entry");
    const updated = s.updateLifecycle(t.tradeId, { updatedAt: "t2", state: "PAPER_OPEN", entry }, openedEvent(t.tradeId));
    expect(updated.state).toBe("PAPER_OPEN");
    expect(updated.updatedAt).toBe("t2");
    expect(s.listEvents().map((e) => e.sequence)).toEqual([1, 2]);
  });
  it("rejects an illegal transition (review -> exited) and changes nothing", async () => {
    const s = new JournalState();
    const t = await sampleTrade();
    s.createTrade(t, ev(t.tradeId));
    raises(() => s.updateLifecycle(t.tradeId, { updatedAt: "t2", state: "PAPER_EXITED" }, { ...openedEvent(t.tradeId), toState: "PAPER_EXITED" }), "INVALID_TRANSITION");
    expect(s.getTrade(t.tradeId)?.state).toBe("PAPER_REVIEW");
    expect(s.listEvents()).toHaveLength(1);
  });
  it("an entry snapshot may only be recorded together with PAPER_OPEN", async () => {
    const s = new JournalState();
    const t = await sampleTrade();
    s.createTrade(t, ev(t.tradeId));
    const svc = makeService();
    const r = await svc.service.beginReview(longVolRaw());
    const c = r.ok ? await svc.service.confirm(r.value.tradeId, { confirmed: true }) : null;
    const entry = c && c.ok ? c.value.entry : null;
    if (!entry) throw new Error("no entry");
    raises(() => s.updateLifecycle(t.tradeId, { updatedAt: "t2", entry }, openedEvent(t.tradeId)), "INVALID_RECORD");
  });
  it("a final (terminal) trade cannot change at all", async () => {
    const svc = makeService();
    const r = await svc.service.beginReview(longVolRaw());
    if (!r.ok) throw new Error("x");
    await svc.service.confirm(r.value.tradeId, { confirmed: true });
    await svc.service.exit(r.value.tradeId, exitQuotes());
    await expect(svc.repository.updateLifecycle(r.value.tradeId, { updatedAt: "z" }, { timestamp: "z", type: "MONITOR_SNAPSHOT", tradeId: r.value.tradeId, fromState: "PAPER_EXITED", toState: "PAPER_EXITED" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
  it("updating an unknown trade is TRADE_NOT_FOUND", () => {
    raises(() => new JournalState().updateLifecycle("pt_none", { updatedAt: "t" }, openedEvent("pt_none")), "TRADE_NOT_FOUND");
  });
  it("the update event must refer to the updated trade", async () => {
    const s = new JournalState();
    const t = await sampleTrade();
    s.createTrade(t, ev(t.tradeId));
    raises(() => s.updateLifecycle(t.tradeId, { updatedAt: "t2" }, openedEvent("other")), "INVALID_RECORD");
  });
  it("appendEvent records a standalone event; an unknown trade is refused", async () => {
    const s = new JournalState();
    const t = await sampleTrade();
    s.createTrade(t, ev(t.tradeId));
    const e = s.appendEvent({ timestamp: "t3", type: "EXIT_REJECTED_DATA_INSUFFICIENT", tradeId: t.tradeId, fromState: "PAPER_OPEN", toState: "PAPER_OPEN", payload: { why: "x" } });
    expect(e).toMatchObject({ sequence: 2, payload: { why: "x" } });
    raises(() => s.appendEvent({ ...ev("ghost") }), "TRADE_NOT_FOUND");
  });
});

describe("journal: list and export", () => {
  it("lists trades in creation order and filters by state; lists events per trade", async () => {
    const s = new JournalState();
    const a = { ...(await sampleTrade()), tradeId: "pt_a", createdAt: "2026-09-28T10:00:01Z" };
    const b = { ...(await sampleTrade()), tradeId: "pt_b", createdAt: "2026-09-28T10:00:02Z", state: "DATA_INSUFFICIENT" as const };
    s.createTrade(b, ev("pt_b", { type: "REJECTED_DATA_INSUFFICIENT", toState: "DATA_INSUFFICIENT" }));
    s.createTrade(a, ev("pt_a"));
    expect(s.listTrades().map((t) => t.tradeId)).toEqual(["pt_a", "pt_b"]);
    expect(s.listTrades({ states: ["DATA_INSUFFICIENT"] }).map((t) => t.tradeId)).toEqual(["pt_b"]);
    expect(s.listEvents({ tradeId: "pt_a" })).toHaveLength(1);
    expect(s.listEvents({ tradeId: "none" })).toEqual([]);
  });
  it("exports everything as plain JSON with counts", async () => {
    const s = new JournalState();
    const t = await sampleTrade();
    s.createTrade(t, ev(t.tradeId));
    const x = s.exportJournal("2026-09-28T12:00:00Z");
    expect(x).toMatchObject({ exportVersion: 1, app: "nse-smart-trader-v2", exportedAt: "2026-09-28T12:00:00Z", counts: { trades: 1, events: 1 } });
    expect(JSON.parse(JSON.stringify(x))).toEqual(x);
  });
});

describe("journal: stored data cannot be changed from outside", () => {
  it("returned trades and events are deeply frozen", async () => {
    const s = new JournalState();
    const t = await sampleTrade();
    const stored = s.createTrade(t, ev(t.tradeId));
    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => {
      (stored as { state: string }).state = "PAPER_OPEN";
    }).toThrow(TypeError);
    expect(() => {
      (s.getTrade(t.tradeId)?.review as { combinedEntryPremium: number }).combinedEntryPremium = 1;
    }).toThrow(TypeError);
  });
  it("toData() is an independent copy", async () => {
    const s = new JournalState();
    const t = await sampleTrade();
    s.createTrade(t, ev(t.tradeId));
    const copy = s.toData();
    delete copy.trades[t.tradeId];
    expect(s.getTrade(t.tradeId)).not.toBeNull();
  });
});

describe("journal: loading stored data fails safely", () => {
  const good = (): JournalStateData => emptyJournalState();
  it("accepts an empty journal", () => expect(validateJournalState(good())).toEqual(good()));
  it.each([
    ["not an object", "x", "STORAGE_CORRUPT"],
    ["null", null, "STORAGE_CORRUPT"],
    ["an array", [], "STORAGE_CORRUPT"],
    ["no schemaVersion", { nextSequence: 1, trades: {}, events: [] }, "STORAGE_CORRUPT"],
    ["a future schemaVersion", { schemaVersion: 2, nextSequence: 1, trades: {}, events: [] }, "STORAGE_VERSION_UNSUPPORTED"],
    ["bad nextSequence", { schemaVersion: 1, nextSequence: 0, trades: {}, events: [] }, "STORAGE_CORRUPT"],
    ["trades not an object", { schemaVersion: 1, nextSequence: 1, trades: [], events: [] }, "STORAGE_CORRUPT"],
    ["events not an array", { schemaVersion: 1, nextSequence: 1, trades: {}, events: {} }, "STORAGE_CORRUPT"],
    ["trade id not matching its key", { schemaVersion: 1, nextSequence: 1, trades: { a: { tradeId: "b", schemaVersion: 1, state: "PAPER_REVIEW" } }, events: [] }, "STORAGE_CORRUPT"],
    ["unknown trade state", { schemaVersion: 1, nextSequence: 1, trades: { a: { tradeId: "a", schemaVersion: 1, state: "WHAT" } }, events: [] }, "STORAGE_CORRUPT"],
    ["events out of order", { schemaVersion: 1, nextSequence: 5, trades: {}, events: [{ sequence: 2, tradeId: null }, { sequence: 1, tradeId: null }] }, "STORAGE_CORRUPT"],
    ["an event for an unknown trade", { schemaVersion: 1, nextSequence: 3, trades: {}, events: [{ sequence: 1, tradeId: "ghost" }] }, "STORAGE_CORRUPT"],
    ["nextSequence not ahead of the events", { schemaVersion: 1, nextSequence: 1, trades: {}, events: [{ sequence: 1, tradeId: null }] }, "STORAGE_CORRUPT"],
  ])("rejects: %s", (_name, raw, code) => {
    raises(() => validateJournalState(raw), code);
  });
});

describe("in-memory repository", () => {
  it("implements the repository interface with the same rules, using the injected clock for export", async () => {
    const repo = new InMemoryJournalRepository(() => "2026-01-01T00:00:00Z");
    const t = await sampleTrade();
    await repo.createTrade(t, ev(t.tradeId));
    expect((await repo.getTrade(t.tradeId))?.tradeId).toBe(t.tradeId);
    expect((await repo.exportJournal()).exportedAt).toBe("2026-01-01T00:00:00Z");
    await expect(repo.createTrade(t, ev(t.tradeId))).rejects.toMatchObject({ code: "TRADE_EXISTS" });
  });
});

describe("journal: ids that look like built-in object members are never found (ids come from URLs)", () => {
  const names = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];
  it.each(names)("getTrade(%s) is null", async (name) => {
    const s = new JournalState();
    const t = await sampleTrade();
    s.createTrade(t, ev(t.tradeId));
    expect(s.getTrade(name)).toBeNull();
  });
  it.each(names)("updateLifecycle and appendEvent on %s are TRADE_NOT_FOUND", (name) => {
    const s = new JournalState();
    raises(() => s.updateLifecycle(name, { updatedAt: "t" }, openedEvent(name)), "TRADE_NOT_FOUND");
    raises(() => s.appendEvent({ ...ev(name) }), "TRADE_NOT_FOUND");
  });
  it("stored data whose event refers to 'constructor' is rejected as corrupt", () => {
    raises(() => validateJournalState({ schemaVersion: 1, nextSequence: 3, trades: {}, events: [{ sequence: 1, tradeId: "constructor" }] }), "STORAGE_CORRUPT");
  });
});
