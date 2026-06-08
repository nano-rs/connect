import type { NanoClient } from "./api.js";

export interface VerifyResult {
  arrived: boolean;
  count: number;
  sample?: Record<string, unknown>;
  attempts: number;
}

const POLL_INTERVAL_MS = 2_000;

/**
 * Poll search until our test event shows up (or we give up). Ingestion → parse → searchable
 * has a few seconds of latency, so we retry rather than checking once.
 *
 * We query by source_type (always a real column) and scan returned rows for the unique marker,
 * rather than querying the marker as an `ext` field — ext-field query semantics are fiddly and a
 * generic-parsed test event lands its marker inside the message / ext blob.
 */
export async function verifyMarker(
  client: NanoClient,
  sourceType: string,
  marker: string,
  opts: { timeoutMs?: number } = {},
): Promise<VerifyResult> {
  const timeoutMs = opts.timeoutMs ?? 40_000;
  const deadline = Date.now() + timeoutMs;
  // Look back a generous window to absorb clock skew between client and server.
  const start = new Date(Date.now() - 15 * 60_000).toISOString();
  const query = `source_type="${sourceType}"`;

  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    const end = new Date(Date.now() + 60_000).toISOString();
    try {
      const res = await client.search(query, start, end, 50);
      // Count matches of OUR marker, not all events of this source_type in the window.
      const matches = res.results.filter((row) => JSON.stringify(row).includes(marker));
      if (matches.length > 0) {
        return { arrived: true, count: matches.length, sample: matches[0], attempts };
      }
    } catch {
      // Transient — keep polling until the deadline.
    }
    if (Date.now() + POLL_INTERVAL_MS >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }
  return { arrived: false, count: 0, attempts };
}

/**
 * Count events of a given source_type in the recent window — used to report on a real
 * collector after it's wired up (not just the synthetic test event).
 */
export async function countRecent(
  client: NanoClient,
  sourceType: string,
  windowMinutes = 10,
): Promise<number> {
  const start = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const end = new Date(Date.now() + 60_000).toISOString();
  const res = await client.search(`source_type="${sourceType}"`, start, end, 0);
  return res.total_count;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
