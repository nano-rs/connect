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
    // "No parser" and "no catalog to look in" are different problems with identical symptoms.
    // An instance with no repository configured reports nothing available for EVERY source_type,
    // which reads as "nano doesn't support this" when it just hasn't pulled the catalog.
    const noCatalog = ctx.repoParsers.length === 0;
    note(
      [
        `No parser yet for: ${none.map((s) => pc.cyan(s.sourceType)).join(", ")}`,
        "",
        "Data still flows and is searchable as generic logs — a parser just normalizes it into",
        "UDM fields for better detection & dashboards. To add one:",
        ...(noCatalog
          ? [
              `  • ${pc.cyan("connect sync-parsers")} — this instance has no parser catalog to match`,
              `    against yet, so nothing will ever look "available" until you pull it`,
            ]
          : []),
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

  const activated: string[] = [];
  for (const s of available) {
    if (!s.repoId || !s.filePath) continue;
    try {
      const outcome = await deployParser(client, s.repoId, s.filePath);
      if (outcome.activated) {
        log.success(pc.green(`Deployed parser for ${s.sourceType}.`));
        activated.push(s.sourceType);
      } else {
        // Importing and activating are two steps. The import already created a log_sources row,
        // so nano's UI will list this source and it LOOKS onboarded — but until it's deployed no
        // parser runs and events keep landing unnormalized. Say that, or the half-state reads as
        // success.
        note(
          [
            `A log source was created for ${pc.cyan(s.sourceType)}, but the parser is ${pc.yellow("not active")}${
              outcome.message ? `: ${outcome.message}` : "."
            }`,
            "",
            "It will show up in nano under Log Sources, but nothing is parsing yet — events keep",
            "landing as generic logs with no UDM fields, and detections keyed on UDM won't match.",
            "",
            `Finish it in the platform: ${pc.cyan("Log Sources")} → ${pc.cyan(s.sourceType)} → Deploy.`,
            `Then confirm with ${pc.cyan(`connect verify --source ${s.sourceType}`)}.`,
          ].join("\n"),
          "Created, not yet parsing",
        );
      }
    } catch (err) {
      if (err instanceof NanoApiError && err.status === 403) {
        log.warn(
          `Your API key can't deploy parsers — importing one creates a log source and republishes ` +
            `the routing config, which needs ${pc.dim(
              "log_sources:create + source_configs:edit + log_sources:deploy",
            )} on top of ${pc.dim("parser_repositories:import")}. Re-run \`connect\` to mint a key ` +
            `with those, or import ${s.sourceType} in the platform instead.`,
        );
        return; // no point retrying the rest with the same key
      }
      log.warn(`Couldn't deploy ${s.sourceType}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (activated.length > 0) {
    // Parsers run in the ingest pipeline, so they apply to events arriving from now on. Events
    // already stored stay in whatever shape they landed in — which matters because `verify`
    // samples recent events and would otherwise report "NOT normalized" off pre-deploy rows.
    log.info(
      `Parsing applies to ${pc.bold("newly ingested")} events — anything already stored keeps the ` +
        `shape it arrived in. Send fresh data before checking with ${pc.cyan(
          `connect verify --source ${activated[0]}`,
        )}.`,
    );
  }
}
