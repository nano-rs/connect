import pc from "picocolors";
import { NanoClient } from "./core/api.js";
import type { DeviceType } from "./core/catalog.js";
import { resolveSavedConnection } from "./core/connection.js";
import { buildCatalog } from "./core/discovery.js";
import { loadParserContext, type ParserContext } from "./core/parsers.js";

export interface ListSourcesOptions {
  url?: string;
  apiKey?: string;
  envFile?: string;
  /** Don't contact the instance — useful offline, or to see the curated list on its own. */
  builtinOnly?: boolean;
}

/**
 * Show what `--sources` accepts: the curated built-ins, plus every source_type the connected
 * instance already has a parser deployed for. The second half is the point — importing a parser
 * (say MikroTik) registers its match_values in nano, and this is where you find out that
 * `routeros` is now a name you can hand to `add-source`.
 */
export async function runListSources(opts: ListSourcesOptions): Promise<void> {
  let ctx: ParserContext | undefined;
  let lookupNote: string | undefined;

  if (!opts.builtinOnly) {
    try {
      const conn = resolveSavedConnection(opts);
      if (conn.apiKey) {
        ctx = await loadParserContext(new NanoClient(conn.baseUrl, { apiKey: conn.apiKey }));
        if (!ctx.ok) {
          lookupNote = `Couldn't read ${conn.baseUrl}'s parser registry (key may lack parser scopes) — built-ins only.`;
        }
      } else {
        lookupNote = `No API key saved for ${conn.baseUrl} — built-ins only. Run \`connect\` to mint one.`;
      }
    } catch {
      // No saved connection at all. Listing the built-ins is still useful, so don't hard-fail.
      lookupNote = "No saved nano connection — built-ins only. Run `connect` to see your instance's source types too.";
    }
  }

  const { catalog, discovered, available, omitted } = buildCatalog(ctx);
  const builtins = catalog.filter((d) => d.origin !== "discovered");

  console.log(
    `\n${pc.bold("Syslog source_types")} — pass these to ${pc.cyan("--sources")} on add-source / add-aggregator.\n` +
      `Each gets its own listener port so nano can tell the vendors apart. Append ${pc.cyan(":tcp")} or ` +
      `${pc.cyan(":udp")} to override a transport.\n`,
  );

  const width = Math.max(...catalog.map((d) => d.id.length), ...available.map((c) => c.id.length));
  console.log(pc.bold("  Built-in"));
  for (const d of builtins) print(d, width);

  if (discovered.length > 0) {
    console.log(`\n${pc.bold("  From your instance")} ${pc.dim("(parsers you have deployed; ports assigned by connect)")}`);
    for (const d of discovered) print(d, width);
  }

  if (available.length > 0) {
    console.log(
      `\n${pc.bold("  Available in the community catalog")} ${pc.dim("(not imported yet — selecting one imports its parser)")}`,
    );
    for (const c of available) {
      console.log(
        `  ${pc.cyan(c.id.padEnd(width))}  ${pc.dim("  —  ")}  ${c.label}${c.category ? pc.dim(`  [${c.category}]`) : ""}`,
      );
    }
  }

  if (omitted.length > 0) {
    // Say what was withheld and why, so "my source isn't listed" doesn't read as "unsupported".
    // Name real examples from THIS instance rather than hardcoded ones, which drift out of sync
    // as parsers start declaring `transports:`.
    const sample = omitted.slice(0, 3).join(", ") + (omitted.length > 3 ? ", …" : "");
    console.log(
      `\n  ${pc.dim(`${omitted.length} more parser(s) exist for sources that don't arrive over syslog (${sample}).`)}\n` +
        `  ${pc.dim("nano parses those fine — collect them with `connect add-agent` or their native integration.")}`,
    );
  }

  if (lookupNote) console.log(`\n  ${pc.yellow(lookupNote)}`);

  const example = discovered[0]?.id ?? available[0]?.id ?? builtins.slice(0, 2).map((d) => d.id).join(",");
  console.log(`\n${pc.dim("e.g.")}  connect add-source --sources ${example}\n`);
}

function print(d: DeviceType, width: number): void {
  const alsoKnownAs = d.aliases?.length ? pc.dim(`  (also: ${d.aliases.join(", ")})`) : "";
  const stamped = d.sourceType !== d.id ? pc.dim(`  (source_type ${d.sourceType})`) : "";
  console.log(
    `  ${pc.cyan(d.id.padEnd(width))}  ${String(d.port).padStart(5)}/${d.mode.padEnd(3)}  ${d.label}${stamped}${alsoKnownAs}`,
  );
  if (d.note) console.log(`  ${" ".repeat(width)}  ${pc.dim(d.note)}`);
}
