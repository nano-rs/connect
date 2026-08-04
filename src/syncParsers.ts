import { confirm, intro, log, note, outro, spinner } from "@clack/prompts";
import pc from "picocolors";
import { NanoClient } from "./core/api.js";
import { resolveSavedConnection } from "./core/connection.js";
import { NanoApiError, type ParserRepository } from "./core/types.js";
import { orExit } from "./ui/ui.js";

export interface SyncParsersOptions {
  url?: string;
  apiKey?: string;
  envFile?: string;
  searchUrl?: string;
  /** Register the official community repository if no repository is configured. */
  addOfficial?: boolean;
  nonInteractive?: boolean;
}

/**
 * The official community parser repository, as nano configures it out of the box. A fresh
 * instance sometimes has no repository at all — parser matching then reports "no parser yet" for
 * everything, which reads like a missing parser rather than a missing catalog.
 */
const OFFICIAL_REPO = {
  name: "nano parsers",
  slug: "nano-rs/parsers",
  description: "Official nano parsers for common log sources",
  url: "https://github.com/nano-rs/parsers",
  branch: "main",
  parsers_path: "parsers/",
  auto_sync_enabled: false,
  sync_interval_hours: 24,
  enabled: true,
};

const POLL_INTERVAL_MS = 2_000;
const SYNC_TIMEOUT_MS = 120_000;

export async function runSyncParsers(opts: SyncParsersOptions): Promise<void> {
  if (!process.stdin.isTTY) opts = { ...opts, nonInteractive: true };

  const conn = resolveSavedConnection(opts);
  if (!conn.apiKey) {
    throw new NanoApiError("No API key. Run `connect` first, or pass --api-key.");
  }
  const client = new NanoClient(conn.baseUrl, { apiKey: conn.apiKey, searchUrl: conn.searchUrl });

  intro(pc.inverse(" nano connect · sync parsers "));

  const s = spinner();
  s.start("Looking for parser repositories");
  let repos: ParserRepository[];
  try {
    repos = await client.listParserRepositories();
  } catch (err) {
    s.stop(pc.red("Couldn't list parser repositories"));
    throw err;
  }
  s.stop(`${repos.length} ${repos.length === 1 ? "repository" : "repositories"} configured`);

  if (repos.length === 0) {
    repos = await addOfficialRepo(client, opts);
    if (repos.length === 0) return;
  }

  const enabled = repos.filter((r) => r.enabled !== false);
  if (enabled.length === 0) {
    log.warn("Every configured repository is disabled. Enable one in the platform, then re-run.");
    outro(pc.yellow("Nothing to sync."));
    return;
  }

  let synced = 0;
  for (const repo of enabled) {
    const before = repo.parser_count ?? 0;
    const s2 = spinner();
    s2.start(`Syncing ${repo.name}${repo.url ? pc.dim(` (${repo.url})`) : ""}`);
    try {
      await client.syncParserRepository(repo.id);
    } catch (err) {
      if (err instanceof NanoApiError && err.status === 403) {
        s2.stop(pc.red(`Can't sync ${repo.name}`));
        log.warn(
          `Your API key is missing ${pc.dim("parser_repositories:sync")}. Re-run ${pc.cyan(
            "connect",
          )} to mint a key with it, or sync from the platform (Settings → Parser Repositories).`,
        );
        outro(pc.yellow("Sync skipped."));
        return;
      }
      s2.stop(pc.red(`Sync failed for ${repo.name}`));
      log.warn(err instanceof Error ? err.message : String(err));
      continue;
    }

    // The sync runs server-side; poll rather than assuming it finished on return.
    const final = await pollSync(client, repo.id);
    const after = final.parser_count;
    if (final.status && /fail|error/i.test(final.status)) {
      s2.stop(pc.red(`${repo.name}: sync ${final.status}`));
      if (final.error) log.warn(final.error);
      continue;
    }
    const count = typeof after === "number" ? after : before;
    s2.stop(pc.green(`${repo.name}: ${count} parser${count === 1 ? "" : "s"} available`));
    synced++;
  }

  if (synced > 0) {
    note(
      [
        "Parser catalog refreshed. Next time you onboard a source, `connect` can match it:",
        `  ${pc.cyan("connect add-source --sources cisco_asa --deploy-parsers")}`,
        "",
        `Already onboarded? Re-run ${pc.cyan("add-source")} for that source_type — it re-checks`,
        "coverage and offers to deploy anything newly available.",
      ].join("\n"),
      "What's next",
    );
  }
  outro(pc.green(synced > 0 ? "Parsers synced." : "Done."));
}

/** Offer to register the official community repository when the instance has none. */
async function addOfficialRepo(
  client: NanoClient,
  opts: SyncParsersOptions,
): Promise<ParserRepository[]> {
  note(
    [
      "This instance has no parser repository configured, so there's no catalog to match against —",
      `every source_type reports ${pc.dim("no parser yet")} regardless of what exists upstream.`,
      "",
      `Official repository: ${pc.cyan(OFFICIAL_REPO.url)} (branch ${OFFICIAL_REPO.branch})`,
    ].join("\n"),
    "No parser repository",
  );

  let go = opts.addOfficial ?? false;
  if (!go && !opts.nonInteractive) {
    go = orExit(
      await confirm({ message: "Register the official nano parsers repository?", initialValue: true }),
    );
  }
  if (!go) {
    log.info(
      `Skipped. Add one in the platform (Settings → Parser Repositories), or re-run with ${pc.cyan(
        "--add-official",
      )}.`,
    );
    return [];
  }

  const s = spinner();
  s.start("Registering the official repository");
  try {
    const created = await client.createParserRepository(OFFICIAL_REPO);
    s.stop(pc.green(`Registered ${created.name}`));
    return [created];
  } catch (err) {
    s.stop(pc.red("Couldn't register the repository"));
    if (err instanceof NanoApiError && err.status === 403) {
      log.warn(
        `Your API key is missing ${pc.dim(
          "parser_repositories:manage",
        )} — registering a repository points your instance at a git source, so it's a separate ` +
          `permission. Re-run ${pc.cyan("connect")} to mint a key with it, or add the repository ` +
          `in the platform (Settings → Parser Repositories).`,
      );
      return [];
    }
    throw err;
  }
}

/** Poll sync status to completion. Treats an unreadable status as "finished" rather than hanging. */
async function pollSync(
  client: NanoClient,
  repoId: string,
): Promise<{ status?: string; parser_count?: number; error?: string | null }> {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let last: { status?: string; parser_count?: number; error?: string | null } = {};
  while (Date.now() < deadline) {
    try {
      const st = await client.parserRepositorySyncStatus(repoId);
      last = { status: st.status, parser_count: st.parser_count, error: st.error ?? st.message };
      if (st.status && !/pending|running|in_?progress|syncing/i.test(st.status)) return last;
    } catch {
      // Status endpoint unavailable — fall back to the repo listing for a final count.
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  try {
    const repos = await client.listParserRepositories();
    const repo = repos.find((r) => r.id === repoId);
    if (repo) {
      return {
        status: repo.last_sync_status ?? last.status,
        parser_count: repo.parser_count,
        error: repo.last_sync_error ?? last.error,
      };
    }
  } catch {
    /* keep whatever we have */
  }
  return last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
