# Historical journal samples (synthetic test data, read-only)

These are journals written by the **real builds** of two earlier commits, using only their public service API and
`FileJournalRepository`, into a temporary folder. Every price, time and id is synthetic. No real user journal was read,
copied or changed. The files are stored **minified**: the exact file each build wrote, re-serialized without whitespace
(`JSON.stringify(JSON.parse(file))` plus a newline). Parsed content and key order are identical to what the build wrote.
They are historical evidence of the shapes older versions produce, so they must never be edited by hand. Tests copy
them to a temporary folder before use.

| File | Written by | Trades | What it covers |
|---|---|---|---|
| `journal-1d21f06.json` | `1d21f06` (Phase 1B, `main`) | 8 | entry snapshot v1; client `asOf` times; a valid monitor snapshot; a rejected exit; a user exit with a non-null `priceAsOf`; an expiry priced from an earlier monitored bid (`LAST_VALID_MONITOR_BID`); an expiry priced from typed bids; a holding-limit closure; a review; a `DATA_INSUFFICIENT` candidate; a trade opened and exited after expiry |
| `journal-b91fa26.json` | `b91fa26` (Phase 1B.1) | 8 | entry snapshot v2 with quote times; server-time events; `EXECUTABLE_QUOTE` exits with `priceAsOf: null`; an unpriced expiry with `staleReference`; an expiry priced from typed bids; a holding-limit closure; a review with a `CONFIRM_REJECTED_QUOTE` event; a `DATA_INSUFFICIENT` candidate; a trade opened and exited after expiry |

Every lifecycle state, exit trigger, exit basis and journal event type that each build can write appears at least once.
Trade ids are named after their scenario (for example `pt_b91fa26-userExit`).

## Size

`journal-1d21f06.json` is 47,245 bytes and `journal-b91fa26.json` is 50,547 bytes (76,346 and 81,181 bytes as the
builds wrote them, with the app's 2-space indentation). Scenarios were merged to the minimum that still covers the
shapes above (9 and 10 trades became 8 and 8). Most of the remaining size is content the old builds write themselves,
chiefly four full risk-assessment records per opened trade (about 19.5 KB per file); it is kept so that the record
shapes stay exactly what those builds produced.

## Reproducing the samples

Build the commit (`npm ci`, `npm run build`), then run the generator against it. Without `--minify` the output is
byte-identical to what that build's own serializer writes; with `--minify` it is byte-identical to the file here.

## Tools (not run by the test suite)

- `tools/generate-journal.mjs` writes a sample with a built copy of a commit:
  `node tools/generate-journal.mjs <repo root built at 1d21f06 or b91fa26> <output file> <1d21f06|b91fa26> [--minify]`.
- `tools/check-rollback.mjs` loads a journal with an OLDER build on a temporary copy and reports what it did. Loading
  success alone is not evidence of safe rollback: an older build can overwrite newer provenance fields and does not
  apply newer safeguards. Older builds must not be run against a journal written by Phase 1B.2; back it up first.
