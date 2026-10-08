import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { JournalRepositoryError, JournalState, emptyJournalState, validateJournalState } from "@nsest/core";
import type {
  JournalEventRecord,
  JournalExport,
  JournalRepository,
  LifecyclePatch,
  NewJournalEvent,
  PaperTradeRecord,
  TradeListFilter,
} from "@nsest/core";

export interface FileJournalOptions {
  /** Where the single JSON journal file lives. */
  filePath: string;
  now?: () => string;
}

/**
 * Backend-only journal stored in ONE JSON file.
 *
 *  - The rules live in core's JournalState (the same engine the in-memory repository uses).
 *  - Every change is applied to a COPY, written to a temporary file, then renamed over the real file. A failed
 *    write therefore leaves both the file and the in-memory state exactly as they were.
 *  - Operations run one at a time (a queue), so concurrent requests cannot interleave.
 *  - Corrupt or unsupported data is an ERROR. It is never overwritten or "repaired"; the file is left for inspection.
 *
 * DURABILITY: this is suitable for controlled development and paper-trading use on a machine with a normal disk.
 * It is NOT guaranteed durable storage, and must not be relied on on serverless or ephemeral hosting, where the
 * filesystem can be discarded between requests. Use the JSON export to keep backups.
 */
export class FileJournalRepository implements JournalRepository {
  private state: JournalState | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly filePath: string;
  private readonly now: () => string;

  constructor(options: FileJournalOptions) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<JournalState> {
    if (this.state !== null) return this.state;
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = new JournalState(emptyJournalState());
        return this.state;
      }
      throw new JournalRepositoryError("STORAGE_IO", `Could not read the journal file: ${(e as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new JournalRepositoryError("STORAGE_CORRUPT", "The journal file is not valid JSON. It was left untouched; restore it from a backup or move it aside.");
    }
    this.state = new JournalState(validateJournalState(parsed));
    return this.state;
  }

  private async persist(next: JournalState): Promise<void> {
    const temp = `${this.filePath}.tmp-${process.pid}`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temp, `${JSON.stringify(next.toData(), null, 2)}\n`, "utf8");
      await rename(temp, this.filePath);
    } catch (e) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw new JournalRepositoryError("STORAGE_IO", `Could not write the journal file: ${(e as Error).message}`);
    }
  }

  /** Applies a change to a copy, saves it, and only then adopts it. */
  private async mutate<T>(change: (draft: JournalState) => T): Promise<T> {
    const current = await this.load();
    const draft = new JournalState(current.toData());
    const result = change(draft);
    await this.persist(draft);
    this.state = draft;
    return result;
  }

  createTrade(trade: PaperTradeRecord, event: NewJournalEvent): Promise<PaperTradeRecord> {
    return this.run(() => this.mutate((s) => s.createTrade(trade, event)));
  }
  getTrade(tradeId: string): Promise<PaperTradeRecord | null> {
    return this.run(async () => (await this.load()).getTrade(tradeId));
  }
  updateLifecycle(tradeId: string, patch: LifecyclePatch, event: NewJournalEvent): Promise<PaperTradeRecord> {
    return this.run(() => this.mutate((s) => s.updateLifecycle(tradeId, patch, event)));
  }
  appendEvent(event: NewJournalEvent): Promise<JournalEventRecord> {
    return this.run(() => this.mutate((s) => s.appendEvent(event)));
  }
  listTrades(filter?: TradeListFilter): Promise<PaperTradeRecord[]> {
    return this.run(async () => (await this.load()).listTrades(filter));
  }
  listEvents(filter?: { tradeId?: string }): Promise<JournalEventRecord[]> {
    return this.run(async () => (await this.load()).listEvents(filter));
  }
  exportJournal(): Promise<JournalExport> {
    return this.run(async () => (await this.load()).exportJournal(this.now()));
  }
}
