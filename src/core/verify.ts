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
 * Is ANY event arriving on this instance right now, from any source?
 *
 * Discriminates the two reasons a test event never becomes searchable, which otherwise look
 * identical: a rejected ingest token (nano answers 200 and drops it, so only OUR event is
 * missing) versus an instance that isn't delivering anything at all. Guessing between them is
 * how you send someone to re-check a credential that was fine.
 */
export async function hasRecentEvents(
  client: NanoClient,
  windowMinutes = 15,
): Promise<boolean | undefined> {
  const start = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const end = new Date(Date.now() + 60_000).toISOString();
  try {
    const res = await client.search("*", start, end, 1);
    return res.results.length > 0;
  } catch {
    return undefined; // couldn't tell — say so rather than picking a story
  }
}

/** A sampled count of events for a source_type — `capped` means there were at least `count`. */
export interface RecentCount {
  count: number;
  capped: boolean;
  /**
   * How many sampled rows a real parser normalized, vs. fell through to the generic lane, vs.
   * reached a parser that then failed on them. Arriving, being PARSED, and being NORMALIZED are
   * three different things and each needs a different fix.
   */
  parsed: number;
  generic: number;
  /** A parser claimed these but couldn't read them — usually a collector/format mismatch. */
  parseFailed: number;
  /** An example failure message, to save a round-trip into the platform. */
  parseError?: string;
}

/** UDM columns a normalized event populates. Enough coverage to catch any parser family. */
const UDM_SIGNALS = [
  "src_ip",
  "dest_ip",
  "src_port",
  "dest_port",
  "protocol",
  "action",
  "user",
  "src_user",
  "dest_user",
  "process_name",
  "file_path",
  "file_name",
  "url",
  "query",
] as const;

function hasUdmFields(row: Record<string, unknown>): boolean {
  return UDM_SIGNALS.some((k) => {
    const v = row[k];
    if (typeof v === "string") return v !== "";
    if (typeof v === "number") return v !== 0;
    return false;
  });
}

type RowState = "generic" | "failed" | "parsed" | "unknown";

/**
 * Which lane handled a row.
 *
 * Only the catch-all lane stamps `metadata.parser_type = "generic"` — a real parser stamps
 * nothing there, so its absence says nothing on its own. Normalization is therefore detected by
 * the UDM columns actually being populated, and a parser that ran but couldn't read the event
 * leaves `ext.parse_error` behind. That third state matters: it means the collector is delivering
 * a format the parser doesn't expect, which no amount of re-deploying will fix.
 */
function classifyRow(row: Record<string, unknown>): { state: RowState; error?: string } {
  const meta = (typeof row.metadata === "object" && row.metadata ? row.metadata : {}) as Record<
    string,
    unknown
  >;
  if (meta.parser_type === "generic") return { state: "generic" };
  const err = row["ext.parse_error"] ?? meta.parse_error;
  if (typeof err === "string" && err !== "") return { state: "failed", error: err };
  if (hasUdmFields(row)) return { state: "parsed" };
  return { state: "unknown" };
}

const COUNT_SAMPLE_LIMIT = 100;

/**
 * Sample events of a given source_type in the recent window — used to report on a real collector
 * after it's wired up. Note: nano's search `total_count` tracks the returned page size, not the
 * true match total, and `limit: 0` reports zero — so we page a sample and report "N+" when full
 * rather than trusting total_count or asking for zero rows.
 */
export async function countRecent(
  client: NanoClient,
  sourceType: string,
  windowMinutes = 10,
): Promise<RecentCount> {
  const start = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const end = new Date(Date.now() + 60_000).toISOString();
  const res = await client.search(`source_type="${sourceType}"`, start, end, COUNT_SAMPLE_LIMIT);
  const count = res.results.length;
  let parsed = 0;
  let generic = 0;
  let parseFailed = 0;
  let parseError: string | undefined;
  for (const row of res.results) {
    const { state, error } = classifyRow(row);
    if (state === "generic") generic++;
    else if (state === "failed") {
      parseFailed++;
      parseError ??= error;
    } else if (state === "parsed") parsed++;
  }
  return { count, capped: count >= COUNT_SAMPLE_LIMIT, parsed, generic, parseFailed, parseError };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
