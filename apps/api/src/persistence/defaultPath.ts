import { fileURLToPath } from "node:url";

/**
 * Default journal location: <repository root>/data/paper-journal.json.
 * The same depth works from apps/api/src (dev) and apps/api/dist (built). The data/ folder is git-ignored:
 * paper-trade records are local data and are never committed.
 */
export const defaultJournalPath = (): string => fileURLToPath(new URL("../../../../data/paper-journal.json", import.meta.url));
