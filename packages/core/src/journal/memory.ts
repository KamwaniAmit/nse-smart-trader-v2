import type { JournalEventRecord, JournalExport, PaperTradeRecord } from "../contracts/index.js";
import { JournalState } from "./state.js";
import type { JournalRepository, LifecyclePatch, NewJournalEvent, TradeListFilter } from "./repository.js";

/** Non-persistent repository: for tests and for running without a disk. Same rules as the file repository. */
export class InMemoryJournalRepository implements JournalRepository {
  private readonly state = new JournalState();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async createTrade(trade: PaperTradeRecord, event: NewJournalEvent): Promise<PaperTradeRecord> {
    return this.state.createTrade(trade, event);
  }
  async getTrade(tradeId: string): Promise<PaperTradeRecord | null> {
    return this.state.getTrade(tradeId);
  }
  async updateLifecycle(tradeId: string, patch: LifecyclePatch, event: NewJournalEvent): Promise<PaperTradeRecord> {
    return this.state.updateLifecycle(tradeId, patch, event);
  }
  async appendEvent(event: NewJournalEvent): Promise<JournalEventRecord> {
    return this.state.appendEvent(event);
  }
  async listTrades(filter?: TradeListFilter): Promise<PaperTradeRecord[]> {
    return this.state.listTrades(filter);
  }
  async listEvents(filter?: { tradeId?: string }): Promise<JournalEventRecord[]> {
    return this.state.listEvents(filter);
  }
  async exportJournal(): Promise<JournalExport> {
    return this.state.exportJournal(this.now());
  }
}
