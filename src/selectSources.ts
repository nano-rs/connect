import { log, multiselect, spinner } from "@clack/prompts";
import pc from "picocolors";
import type { NanoClient } from "./core/api.js";
import type { DeviceType } from "./core/catalog.js";
import { buildCatalog, parseSourceSelectors, resolveRequested } from "./core/discovery.js";
import { loadParserContext, type ParserContext } from "./core/parsers.js";
import { NanoApiError } from "./core/types.js";
import { orExit } from "./ui/ui.js";

export interface SelectSourcesOptions {
  /** Raw --sources value: "cisco_asa,routeros:tcp". */
  sources?: string;
  nonInteractive?: boolean;
  /** Absent (or unauthorized) means curated-only — generation still works offline. */
  client?: NanoClient;
  /**
   * What an unattended run with no --sources means. add-source exists to collect syslog, so it
   * enables the curated set; the aggregator's syslog listeners are optional extras, so it enables
   * nothing.
   */
  defaultWhenNonInteractive: "curated" | "none";
  promptMessage: string;
}

export interface SelectSourcesResult {
  /**
   * The catalog to render: curated entries plus only the discovered ones actually selected, with
   * any `:mode` override already applied. Unselected discovered types are left out so vector.toml
   * doesn't grow a commented-out block for every parser on the instance.
   */
  catalog: DeviceType[];
  selected: DeviceType[];
  /** Reused by reviewParsers so coverage isn't fetched twice. */
  ctx?: ParserContext;
}

/**
 * Pick which syslog listeners to generate — shared by `add-source` and `add-aggregator`.
 *
 * The catalog is built per-run from the connected instance (see core/discovery.ts), so a parser
 * you imported is selectable by name here instead of requiring a hand-edited collector config.
 */
export async function selectSyslogSources(opts: SelectSourcesOptions): Promise<SelectSourcesResult> {
  let ctx: ParserContext | undefined;
  const s = opts.client ? spinner() : undefined;
  if (opts.client && s) {
    s.start("Reading source types from your instance");
    ctx = await loadParserContext(opts.client);
  }

  const { catalog: full, discovered, available, fromInstance } = buildCatalog(ctx);

  if (s) {
    if (!fromInstance) {
      s.stop(pc.yellow("Couldn't read the parser registry — offering the built-in source types only."));
    } else if (discovered.length > 0 || available.length > 0) {
      s.stop(
        pc.green(
          `Found ${discovered.length} source type(s) your instance parses + ${available.length} available to import`,
        ),
      );
    } else {
      s.stop("Using the built-in source types");
    }
  }

  const raw = opts.sources;
  let selected: DeviceType[];
  if (raw !== undefined) {
    const selectors = (() => {
      try {
        return parseSourceSelectors(raw);
      } catch (err) {
        throw new NanoApiError(err instanceof Error ? err.message : String(err));
      }
    })();
    const resolved = resolveRequested(selectors, full, ctx);
    if (resolved.notSyslog.length) throw notSyslogError(resolved.notSyslog);
    if (resolved.unknown.length) throw unknownSourcesError(resolved.unknown, full, fromInstance);
    if (resolved.fromRepo.length) {
      log.info(
        `${resolved.fromRepo.map((d) => pc.cyan(d.sourceType)).join(", ")} — a community parser exists but isn't deployed yet. ` +
          `Generating the listener now; you'll be offered the parser below.`,
      );
    }
    // Preserve catalog order so the generated file reads the same however ids were supplied.
    const wanted = new Map(resolved.selected.map((d) => [d.id, d]));
    selected = [
      ...full.filter((d) => wanted.has(d.id)).map((d) => wanted.get(d.id)!),
      ...resolved.selected.filter((d) => !full.some((f) => f.id === d.id)),
    ];
  } else if (opts.nonInteractive) {
    if (opts.defaultWhenNonInteractive === "none") {
      selected = [];
    } else {
      selected = full.filter((d) => d.origin !== "discovered");
      log.warn(
        `Non-interactive with no --sources: enabling the ${selected.length} built-in source_types and opening their ports. Pass --sources a,b to narrow.`,
      );
      if (discovered.length > 0) {
        // Opening a port for every parser on the instance is not something to do unasked.
        log.info(
          `Not enabled automatically: ${discovered.map((d) => pc.cyan(d.sourceType)).join(", ")} (from your instance). Add them with ${pc.cyan("--sources")}.`,
        );
      }
    }
  } else {
    // Three tiers in one picker: curated, already-deployed, and community parsers that would be
    // imported on selection. Hiding the last tier would recreate the original complaint — you
    // can't pick a source type you have no way to discover.
    const options = [
      ...full.map((d) => ({
        value: d.id,
        label: d.origin === "discovered" ? `${d.label} ${pc.dim("(your instance)")}` : d.label,
        hint: `${d.mode} :${d.port}`,
      })),
      ...available.map((c) => ({
        value: c.id,
        label: `${c.label} ${pc.dim("(community parser — imported on selection)")}`,
        hint: c.category ?? "community",
      })),
    ];
    const ids = orExit(
      await multiselect({ message: opts.promptMessage, required: false, options }),
    ) as string[];
    const picked = new Set(ids);
    const resolved = resolveRequested(
      [...picked].map((id) => ({ id })),
      full,
      ctx,
    );
    selected = [
      ...full.filter((d) => picked.has(d.id)),
      ...resolved.selected.filter((d) => !full.some((f) => f.id === d.id)),
    ];
  }

  // Drop discovered entries nobody picked, and substitute selected entries so a `:mode` override
  // reaches the generated config (and its compose port) rather than the catalog default.
  const selectedById = new Map(selected.map((d) => [d.id, d]));
  const catalog = [
    ...full
      .filter((d) => d.origin !== "discovered" || selectedById.has(d.id))
      .map((d) => selectedById.get(d.id) ?? d),
    ...selected.filter((d) => !full.some((f) => f.id === d.id)),
  ];

  return { catalog, selected, ctx };
}

/** How a non-syslog source actually gets collected, so the refusal points somewhere useful. */
const COLLECTION_HINTS: Record<string, string> = {
  cloud: "pull it with the provider's integration (or push to nano's HTTP ingest) rather than a syslog port",
  endpoint: "collect it with `connect add-agent` on the endpoint",
  application: "tail its log files with `connect add-agent --files`",
};

function notSyslogError(rejected: { id: string; category?: string; transports?: string[] }[]): NanoApiError {
  const lines = rejected.map((r) => {
    const what = r.transports?.length
      ? `arrives over ${r.transports.join(" / ")}`
      : r.category
        ? `is ${/^[aeiou]/.test(r.category) ? "an" : "a"} \`${r.category}\` source`
        : "doesn't arrive over syslog";
    const hint = (r.category && COLLECTION_HINTS[r.category]) ?? "collect it through its native integration";
    return `  ${pc.cyan(r.id)} ${what} — ${hint}.`;
  });
  return new NanoApiError(
    `Can't collect over syslog:\n${lines.join("\n")}\n` +
      `nano parses these fine; they just don't reach it through a syslog listener, and generating ` +
      `one would leave you with a port nothing ever connects to.`,
  );
}

function unknownSourcesError(unknown: string[], catalog: DeviceType[], fromInstance: boolean): NanoApiError {
  const builtins = catalog.filter((d) => d.origin !== "discovered").length;
  const discovered = catalog.length - builtins;
  // "Unknown" means different things depending on whether we could see the registry at all —
  // saying "not a built-in" when we never asked the instance sends people down the wrong path.
  const scope = fromInstance
    ? `Checked the ${builtins} built-ins, the ${discovered} source type(s) your instance parses, and the community parser catalog.`
    : `Checked the ${builtins} built-ins only — your instance's parser registry wasn't readable, so a source_type you imported won't be found here. Re-run \`connect\` to refresh credentials.`;
  return new NanoApiError(
    `Unknown source_type(s): ${unknown.join(", ")}. ${scope} Run \`connect list-sources\` to see what's available.`,
  );
}
