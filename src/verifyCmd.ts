import { intro, log, outro, spinner, text } from "@clack/prompts";
import pc from "picocolors";
import { NanoClient } from "./core/api.js";
import { resolveSavedConnection } from "./core/connection.js";
import { NanoApiError } from "./core/types.js";
import { countRecent } from "./core/verify.js";
import { orExit } from "./ui/ui.js";

export interface VerifyOptions {
  url?: string;
  apiKey?: string;
  searchUrl?: string;
  envFile?: string;
  source?: string;
  window?: string;
  nonInteractive?: boolean;
}

export async function runVerify(opts: VerifyOptions): Promise<void> {
  if (!process.stdin.isTTY) opts = { ...opts, nonInteractive: true };

  const conn = resolveSavedConnection(opts);
  if (!conn.apiKey) {
    throw new NanoApiError("No API key for search. Run `connect` first, or pass --api-key.");
  }

  let source = opts.source;
  if (!source && !opts.nonInteractive) {
    source = orExit(
      await text({
        message: "Which source_type do you want to check for?",
        placeholder: "cisco_asa",
        validate: (v) => (v.trim() ? undefined : "Required."),
      }),
    ).trim();
  }
  if (!source) {
    throw new NanoApiError("Pass --source <source_type> to check for.");
  }

  const windowMin = Number(opts.window ?? 15);
  if (!Number.isFinite(windowMin) || windowMin <= 0) {
    throw new NanoApiError(`Invalid --window: ${opts.window}`);
  }

  const client = new NanoClient(conn.baseUrl, { apiKey: conn.apiKey, searchUrl: conn.searchUrl });

  intro(pc.inverse(" nano connect · verify "));
  const s = spinner();
  s.start(`Searching for ${source} in the last ${windowMin}m`);
  let result: Awaited<ReturnType<typeof countRecent>>;
  try {
    result = await countRecent(client, source, windowMin);
  } catch (err) {
    s.stop(pc.red("Search failed"));
    throw err;
  }

  if (result.count > 0) {
    const shown = result.capped ? `${result.count}+` : `${result.count}`;
    // Arriving != normalized. Only claim normalization when a real parser actually stamped these
    // rows; otherwise say so, because "normalized ✓" on generic-lane data reads as "done".
    if (result.parseFailed > 0 && result.parsed === 0) {
      // A parser IS deployed and running, but can't read what the collector sends. Re-deploying
      // won't help — the format is wrong — so say so instead of pointing at the parser.
      s.stop(
        pc.yellow(
          `${shown} ${source} event(s) searchable in the last ${windowMin}m — parser ran but FAILED`,
        ),
      );
      log.warn(
        `A parser for ${pc.cyan(source)} is deployed and claiming these events, but can't read them` +
          `${result.parseError ? `: ${pc.dim(result.parseError)}` : "."} They're stored as raw logs ` +
          `with no UDM fields. This is a format mismatch, not a missing parser — check the collector ` +
          `is sending the shape the parser expects (for syslog, the raw wire line rather than a ` +
          `pre-parsed or re-encoded event).`,
      );
    } else if (result.generic > 0 && result.parsed === 0) {
      s.stop(
        pc.yellow(`${shown} ${source} event(s) searchable in the last ${windowMin}m — NOT normalized`),
      );
      log.warn(
        `These are landing in the generic lane (no active parser for ${pc.cyan(
          source,
        )}), so they're searchable as raw logs but carry no UDM fields — detections and dashboards ` +
          `that key on UDM won't match. Deploy a parser: Platform → Parser Editor, or re-run ` +
          `${pc.cyan("connect add-source --deploy-parsers")}. If a log source already exists for ` +
          `${pc.cyan(source)}, check it's actually deployed — one can exist without an active parser.`,
      );
      log.info(
        pc.dim(
          "Just deployed a parser? Parsing only applies to newly ingested events, so these may predate it. Send fresh data and re-check.",
        ),
      );
    } else if (result.parsed > 0 && result.generic > 0) {
      // The classic just-deployed-a-parser signature: old rows generic, new rows parsed.
      s.stop(
        pc.green(
          `${shown} ${source} event(s) searchable in the last ${windowMin}m — ${result.parsed} normalized, ${result.generic} generic`,
        ),
      );
      log.info(
        `Mixed results usually mean a parser was deployed part-way through this window — parsing ` +
          `applies to newly ingested events, so the ${result.generic} generic one(s) likely predate it.`,
      );
    } else if (result.parsed > 0) {
      s.stop(
        pc.green(`${shown} ${source} event(s) searchable in the last ${windowMin}m — normalized ✓`),
      );
    } else {
      // Rows came back without a parser_type we recognize (e.g. an OCSF-shaped row).
      s.stop(pc.green(`${shown} ${source} event(s) searchable in the last ${windowMin}m`));
    }
  } else {
    s.stop(pc.yellow(`No searchable ${source} events in the last ${windowMin}m`));
    log.info(
      `Either your devices aren't sending yet, or events are arriving but not yet normalized (no parser for ${pc.cyan(
        source,
      )}). Check the collector is up and devices point at it; deploy a parser to normalize this source into UDM fields.`,
    );
  }
  outro(pc.green("Done."));
}
