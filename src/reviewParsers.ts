import { confirm, log, note } from "@clack/prompts";
import pc from "picocolors";
import type { NanoClient } from "./core/api.js";
import { classify, deployParser, loadParserContext, type ParserStatus } from "./core/parsers.js";
import { NanoApiError } from "./core/types.js";
import { orExit } from "./ui/ui.js";

export interface ReviewParsersOptions {
  /** Deploy available community parsers without prompting. */
  deployParsers?: boolean;
  nonInteractive?: boolean;
}

/**
 * After generating a collector, tell the user which of their source_types nano already parses,
 * which have a community parser available (and offer to deploy it), and which have none — with
 * the (non-blocking) ways to add one. Degrades quietly if the key can't read parser coverage.
 */
export async function reviewParsers(
  client: NanoClient,
  sourceTypes: string[],
  opts: ReviewParsersOptions,
): Promise<void> {
  const unique = [...new Set(sourceTypes.filter(Boolean))];
  if (unique.length === 0) return;

  const ctx = await loadParserContext(client);
  if (!ctx.ok) {
    log.info(
      pc.dim("Skipped parser coverage check (your API key can't read parsers). Data still flows; re-run `connect` to mint a key with parser scopes."),
    );
    return;
  }

  const statuses = unique.map((st) => classify(st, ctx));
  const deployed = statuses.filter((s) => s.state === "deployed");
  const available = statuses.filter((s) => s.state === "available");
  const none = statuses.filter((s) => s.state === "none");

  if (deployed.length > 0) {
    log.success(pc.green(`nano already parses: ${deployed.map((s) => s.sourceType).join(", ")}`));
  }

  if (available.length > 0) {
    await handleAvailable(client, available, opts);
  }

  if (none.length > 0) {
    note(
      [
        `No parser yet for: ${none.map((s) => pc.cyan(s.sourceType)).join(", ")}`,
        "",
        "Data still flows and is searchable as generic logs — a parser just normalizes it into",
        "UDM fields for better detection & dashboards. To add one:",
        `  • Platform → Parser Editor (create/test/deploy)`,
        `  • nano-investigator MCP → ${pc.dim("build_parser")}`,
        `  • Contribute to ${pc.dim("github.com/nano-rs/parsers")}`,
        `  • Enterprise: AI parser generation (Settings → AI)`,
      ].join("\n"),
      "Parsers",
    );
  }
}

async function handleAvailable(
  client: NanoClient,
  available: ParserStatus[],
  opts: ReviewParsersOptions,
): Promise<void> {
  const names = available.map((s) => s.sourceType).join(", ");
  let go = opts.deployParsers ?? false;
  if (!opts.deployParsers && !opts.nonInteractive) {
    go = orExit(
      await confirm({
        message: `A community parser exists for: ${names}. Deploy ${available.length > 1 ? "them" : "it"} now? (imports + activates on your instance)`,
        initialValue: true,
      }),
    );
  }
  if (!go) {
    log.info(`Available community parser(s) for ${names} — deploy later in the platform or with the MCP.`);
    return;
  }

  for (const s of available) {
    if (!s.repoId || !s.filePath) continue;
    try {
      const outcome = await deployParser(client, s.repoId, s.filePath);
      if (outcome.activated) {
        log.success(pc.green(`Deployed parser for ${s.sourceType}.`));
      } else {
        log.warn(
          `Imported the parser for ${s.sourceType}, but activation failed${outcome.message ? `: ${outcome.message}` : ""}. Activate it in the platform (Log Sources).`,
        );
      }
    } catch (err) {
      if (err instanceof NanoApiError && err.status === 403) {
        log.warn(
          `Your API key can't deploy parsers (needs parser_repositories:import + log_sources:deploy). Import ${s.sourceType} in the platform instead.`,
        );
        return; // no point retrying the rest with the same key
      }
      log.warn(`Couldn't deploy ${s.sourceType}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
