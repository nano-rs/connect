import type { NanoClient } from "./api.js";
import {
  type LogSource,
  NanoApiError,
  type ParserRepository,
  type RepositoryParser,
} from "./types.js";

export type ParserState = "deployed" | "available" | "none";

export interface ParserStatus {
  sourceType: string;
  state: ParserState;
  /** For "available": where to import it from. */
  repoId?: string;
  filePath?: string;
  parserName?: string;
}

/** Parser coverage snapshot fetched once, then classified locally per source_type. */
export interface ParserContext {
  /** False when the API key lacks the parser scopes (we can't tell coverage). */
  ok: boolean;
  deployed: LogSource[];
  repoId?: string;
  repoParsers: RepositoryParser[];
}

function matches(sourceType: string, name?: string, matchValues?: string[] | null): boolean {
  const st = sourceType.toLowerCase();
  if (name && name.toLowerCase() === st) return true;
  return (matchValues ?? []).some((m) => m.toLowerCase() === st);
}

/**
 * All identifiers a repo parser routes on: its name plus the match_values aliases. The list
 * endpoint leaves match_values null, so aliases are parsed out of the raw_content YAML
 * (e.g. "match_values:\n  - cisco_asa\n  - asa").
 */
function repoMatchValues(p: RepositoryParser): string[] {
  const vals: string[] = [];
  if (p.name) vals.push(p.name);
  if (p.match_values) vals.push(...p.match_values);
  const block = p.raw_content?.match(/match_values:\s*\n((?:[ \t]*-[ \t]*[^\n]+\n?)+)/);
  if (block?.[1]) {
    for (const line of block[1].split("\n")) {
      const v = line.replace(/^[ \t]*-[ \t]*/, "").trim().replace(/^["']|["']$/g, "");
      if (v) vals.push(v);
    }
  }
  return vals;
}

/** The official community repo (nano-rs/parsers) among configured repos, else the first enabled. */
export function pickOfficialRepo(repos: ParserRepository[]): ParserRepository | undefined {
  return (
    repos.find((r) => (r.url ?? "").toLowerCase().includes("nano-rs/parsers")) ??
    repos.find((r) => r.enabled !== false) ??
    repos[0]
  );
}

/**
 * Fetch parser coverage once (deployed log sources + the community repo's parsers). Returns
 * ok=false if the key can't read them (403) so callers can degrade gracefully.
 */
export async function loadParserContext(client: NanoClient): Promise<ParserContext> {
  try {
    const deployed = await client.listLogSources();
    const repos = await client.listParserRepositories();
    const repo = pickOfficialRepo(repos);
    const repoParsers = repo ? await client.listRepositoryParsers(repo.id) : [];
    return { ok: true, deployed, repoId: repo?.id, repoParsers };
  } catch (err) {
    if (err instanceof NanoApiError && err.status === 403) {
      return { ok: false, deployed: [], repoParsers: [] };
    }
    // Network/other error — treat as "can't tell" rather than failing onboarding.
    return { ok: false, deployed: [], repoParsers: [] };
  }
}

/** Classify a source_type against pre-fetched coverage. */
export function classify(sourceType: string, ctx: ParserContext): ParserStatus {
  // Deployed log sources carry match_values, so match on name OR alias.
  if (ctx.deployed.some((s) => s.deployed !== false && matches(sourceType, s.name, s.match_values))) {
    return { sourceType, state: "deployed" };
  }
  // Match against the repo parser's name + raw_content aliases (exact, no substring — that
  // false-positives e.g. "linux" onto "linux_audit"). Parsers only, not enrichment normalizers.
  const st = sourceType.toLowerCase();
  const hit = ctx.repoParsers.find(
    (r) => r.kind !== "enrichment" && repoMatchValues(r).some((v) => v.toLowerCase() === st),
  );
  if (hit) {
    if (hit.is_imported) return { sourceType, state: "deployed" };
    return { sourceType, state: "available", repoId: ctx.repoId, filePath: hit.file_path, parserName: hit.name };
  }
  return { sourceType, state: "none" };
}

export interface DeployOutcome {
  logSourceId: string;
  /** Whether the deploy step actually activated it (the API returns 200 even when it didn't). */
  activated: boolean;
  message?: string;
}

/** Import a repository parser, then deploy it. Throws if the IMPORT fails (e.g. 403). */
export async function deployParser(client: NanoClient, repoId: string, filePath: string): Promise<DeployOutcome> {
  const logSourceId = await client.importParser(repoId, filePath);
  // Publish (not just deploy): the import creates a working copy, and only publishing validates
  // its VRL, promotes it to an active version, and pushes it into the ingest pipeline. Deploying
  // alone leaves the parser inert — the log source exists and reports deployed, but events keep
  // falling through to the generic lane.
  try {
    const published = await client.publishLogSource(logSourceId);
    return { logSourceId, activated: published.success, message: published.message };
  } catch (err) {
    // Older instances may not expose /publish — fall back so onboarding still works there.
    if (err instanceof NanoApiError && err.status === 404) {
      const result = await client.deployLogSource(logSourceId);
      return { logSourceId, activated: result.success, message: result.message };
    }
    throw err;
  }
}
