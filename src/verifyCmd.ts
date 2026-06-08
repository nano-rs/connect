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
    s.stop(pc.green(`${shown} ${source} event(s) searchable in the last ${windowMin}m — parsed into OCSF ✓`));
  } else {
    s.stop(pc.yellow(`No searchable ${source} events in the last ${windowMin}m`));
    log.info(
      `Either your devices aren't sending yet, or events are arriving but not parsed into OCSF (nano has no parser for ${pc.cyan(
        source,
      )} yet). Check the collector is up and devices point at it; build a parser to normalize this source.`,
    );
  }
  outro(pc.green("Done."));
}
