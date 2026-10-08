import { randomUUID } from "node:crypto";
import { createPaperTradingService } from "@nsest/core";
import type { PaperTradingService } from "@nsest/core";
import { FileJournalRepository } from "./persistence/FileJournalRepository.js";
import { defaultJournalPath } from "./persistence/defaultPath.js";

/**
 * The real service: file-backed journal, real clock, random ids. No broker is involved: paper trading runs on
 * prices the caller supplies, so it works with the NullBrokerAdapter and no credentials.
 */
export function createDefaultPaperService(filePath: string = defaultJournalPath()): PaperTradingService {
  const now = (): string => new Date().toISOString();
  return createPaperTradingService({
    repository: new FileJournalRepository({ filePath, now }),
    now,
    newId: () => randomUUID(),
  });
}
