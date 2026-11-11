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
 * We query by `metadata.log_source` (the route the event was stored under) and scan returned
 * rows for the unique marker, rather than querying the marker as a field: a test event lands its
 * marker inside the message / raw body, wherever the parser put it.
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
  const query = `metadata.log_source="${sourceType}"`;

  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    const end = new Date(Date.now() + 60_000).toISOString();
    try {
      const res = await client.search(query, start, end, 50);
      // Count matches of OUR marker, not all events from this source in the window.
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

type RowState = "generic" | "failed" | "parsed" | "unknown";

/**
 * Read a field from a search row, whether it came back as a dotted key, a nested object, or a
 * nested object serialized as a JSON string (the generic lane's `metadata`).
 */
function rowField(row: Record<string, unknown>, path: string): unknown {
  if (path in row) return row[path];
  let cur: unknown = row;
  for (const part of path.split(".")) {
    if (typeof cur === "string" && cur.startsWith("{")) {
      try {
        cur = JSON.parse(cur);
      } catch {
        return undefined;
      }
    }
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Which lane handled a row.
 *
 * - Generic: only the catch-all lane stamps `metadata.parser_type = "generic"`.
 * - Failed: an OCSF parser that ran but couldn't read the event reports it in
 *   `unmapped.parse_error` (or, when it only recognized the input as foreign, marks the minimal
 *   record with `unmapped.parse_fallback`). A failure the pipeline caught before the OCSF lane
 *   lands with `metadata.parse_error`. Either way the collector is delivering a format the parser
 *   doesn't expect, which no amount of re-deploying will fix.
 * - Parsed: the row carries a real OCSF class (`class_uid` other than 0).
 * - Unknown: anything else. `class_uid` 0 (Base Event) is a correct parse for some sources
 *   (journald, unmapped Windows event IDs), so it is not reported as a failure either.
 */
export function classifyRow(row: Record<string, unknown>): { state: RowState; error?: string } {
  if (rowField(row, "metadata.parser_type") === "generic") return { state: "generic" };
  const err =
    nonEmptyString(rowField(row, "unmapped.parse_error")) ??
    nonEmptyString(rowField(row, "metadata.parse_error"));
  if (err) return { state: "failed", error: err };
  const fallback = rowField(row, "unmapped.parse_fallback");
  if (fallback !== undefined && fallback !== null && fallback !== false && fallback !== "") {
    return {
      state: "failed",
      error: "the parser didn't recognize the input and kept only a minimal record",
    };
  }
  const cls = Number(rowField(row, "class_uid"));
  if (Number.isFinite(cls) && cls !== 0) return { state: "parsed" };
  return { state: "unknown" };
}

const COUNT_SAMPLE_LIMIT = 100;

/**
 * Sample events stored under a given source (`metadata.log_source`) in the recent window — used to report on a real collector
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
  const res = await client.search(`metadata.log_source="${sourceType}"`, start, end, COUNT_SAMPLE_LIMIT);
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
