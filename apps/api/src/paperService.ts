import { randomUUID } from "node:crypto";
import { createPaperTradingService } from "@nsest/core";
import type { PaperTradingService } from "@nsest/core";
import { FileJournalRepository } from "./persistence/FileJournalRepository.js";
import { defaultJournalPath } from "./persistence/defaultPath.js";

/**
 * The real service: file-backed journal, real clock, random ids. No broker is involved: paper trading runs on
 * prices the caller supplies, so it works with the NullBrokerAdapter and no credentials.
 */
export interface DefaultPaperServiceOptions {
  /**
   * The TRUSTED clock (Phase 1B.1, D3). Defaults to the real system clock. Injected only by tests, so that expiry,
   * safety and quote freshness are deterministic. Client-supplied times never replace it.
   */
  now?: () => string;
}

export function createDefaultPaperService(filePath: string = defaultJournalPath(), options: DefaultPaperServiceOptions = {}): PaperTradingService {
  const now = options.now ?? ((): string => new Date().toISOString());
  return createPaperTradingService({
    repository: new FileJournalRepository({ filePath, now }),
    now,
    newId: () => randomUUID(),
  });
}
