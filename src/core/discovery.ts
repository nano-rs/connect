/**
 * Turn the connected instance's parser registry into offerable syslog source types.
 *
 * The curated SYSLOG_CATALOG can only ever know the vendors we shipped it with. But nano already
 * has the real list: every deployed log source carries the `match_values` its parser routes on.
 * Importing the community MikroTik parser registers `routeros` centrally — this module is what
 * makes `connect` see it, instead of the operator reading the parser YAML and hand-editing
 * `.source_type` on their aggregator.
 *
 * The registry carries no transport detail, so we synthesize the two missing fields: a port (from
 * a dedicated range, see assignPort) and a mode (udp, overridable per-source on --sources).
 */
import { type DeviceType, SYSLOG_CATALOG } from "./catalog.js";
import { type ParserContext, repoMatchValues } from "./parsers.js";
import type { LogSource, RepositoryParser } from "./types.js";

/**
 * Discovered ports live above the curated block (5514-5522) with room to grow, so adding a
 * builtin later can never land on a port an operator already pointed devices at.
 */
export const DISCOVERED_PORT_MIN = 5600;
export const DISCOVERED_PORT_MAX = 5699;

/**
 * A source_type is interpolated straight into generated TOML keys (`[sources.<id>]`) and VRL
 * string literals (`.source_type = "<x>"`). It arrives from the instance's API, so it is not
 * ours to trust: anything outside this shape could break out of the string or the table header.
 */
const SAFE_SOURCE_TYPE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

function isSafe(v: string): boolean {
  return SAFE_SOURCE_TYPE.test(v);
}

/**
 * Labels are free text from the instance and land in generated TOML *comments* — which a newline
 * escapes. An unsanitized log source named "x\n[sinks.exfil]\ntype = \"http\"\n…" would append a
 * live sink to the operator's collector config. Collapse to one printable line and cap it.
 */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]+", "g");

function safeLabel(raw: string | undefined, fallback: string): string {
  const flat = (raw ?? "").replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return flat || fallback;
}

/** FNV-1a. Small, dependency-free, and stable across Node versions — all we need for port choice. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Assign a port by hashing the source_type, then linear-probing on collision.
 *
 * Hashing (rather than "next free from the top") is what makes the port STABLE: it depends only
 * on the name, so importing an unrelated parser tomorrow doesn't renumber a listener that devices
 * are already pointed at. A port only moves if two names genuinely hash to the same slot and the
 * other one claims it first.
 */
export function assignPort(sourceType: string, taken: Set<number>): number | undefined {
  const span = DISCOVERED_PORT_MAX - DISCOVERED_PORT_MIN + 1;
  const start = fnv1a(sourceType) % span;
  for (let i = 0; i < span; i++) {
    const port = DISCOVERED_PORT_MIN + ((start + i) % span);
    if (!taken.has(port)) return port;
  }
  return undefined; // range exhausted — caller reports it rather than colliding
}

/** All identifiers a deployed log source routes on: its name plus its match_values aliases. */
function logSourceValues(s: LogSource): string[] {
  return [s.name, ...(s.match_values ?? [])].filter((v): v is string => Boolean(v));
}

/**
 * Pick the value to stamp onto `.source_type`. Every alias routes to the same parser, so any of
 * them works — we prefer the log source's own name for a canonical, unambiguous config, and fall
 * back to the first alias that's safe to interpolate if the name isn't (e.g. a display name with
 * spaces).
 */
function canonicalOf(values: string[]): string | undefined {
  return values.map((v) => v.toLowerCase()).find(isSafe);
}

/**
 * Categories whose parsers plausibly arrive over syslog, used only when a parser doesn't declare
 * `transports:` itself. It's a coarse fallback: `category` says what KIND of thing a source is,
 * not how it reaches you, and it's genuinely mixed for `security` (suricata is syslog, okta is
 * API-polled). Annotating the parser repo with `transports:` is what makes this exact — see
 * parserTransports() below.
 */
const SYSLOG_CATEGORIES = new Set(["network", "security", "generic"]);

/** A community parser that isn't imported yet — offerable, but it has no listener until selected. */
export interface CommunitySource {
  /** The source_type to route on (the parser's canonical name). */
  id: string;
  label: string;
  category?: string;
  /** Declared collection transports, when the parser says. */
  transports?: string[];
  filePath: string;
}

export interface DiscoveryResult {
  /** Curated entries plus everything found on the instance, curated winning on overlap. */
  catalog: DeviceType[];
  /** Just the synthesized entries, for "N more from your instance" messaging. */
  discovered: DeviceType[];
  /** Community parsers not imported yet, filtered to the ones collectable over syslog. */
  available: CommunitySource[];
  /** Community parsers withheld because they don't arrive over syslog, by id — for messaging. */
  omitted: string[];
  /** True when the registry was actually readable (a 403/offline run yields curated only). */
  fromInstance: boolean;
}

/** Read a parser's declared `transports:` — flow (`[syslog, api]`) or block (`- syslog`) form. */
export function parserTransports(p: RepositoryParser): string[] | undefined {
  const raw = p.raw_content ?? "";
  const flow = raw.match(/^transports:[ \t]*\[([^\]]*)\]/m);
  if (flow) {
    const vals = flow[1]!.split(",").map((v) => v.trim().replace(/^["']|["']$/g, "").toLowerCase()).filter(Boolean);
    return vals.length ? vals : undefined;
  }
  const block = raw.match(/^transports:[ \t]*\n((?:[ \t]*-[ \t]*[^\n]+\n?)+)/m);
  if (block) {
    const vals = block[1]!
      .split("\n")
      .map((l) => l.replace(/^[ \t]*-[ \t]*/, "").trim().replace(/^["']|["']$/g, "").toLowerCase())
      .filter(Boolean);
    return vals.length ? vals : undefined;
  }
  return undefined;
}

export function parserCategory(p: RepositoryParser): string | undefined {
  return p.raw_content?.match(/^category:[ \t]*["']?([a-z_]+)["']?/m)?.[1]?.toLowerCase();
}

/**
 * Can this parser's source realistically be collected by pointing a device at a syslog port?
 *
 * A declared `transports:` is authoritative. Otherwise fall back to category, and treat an
 * unknown/absent category as "yes" — being permissive keeps a new parser usable instead of
 * silently unofferable.
 */
export function isSyslogCollectable(p: RepositoryParser): boolean {
  const declared = parserTransports(p);
  if (declared) return declared.includes("syslog");
  const category = parserCategory(p);
  return category === undefined || SYSLOG_CATEGORIES.has(category);
}

/** Community parsers this instance could import, split into syslog-collectable and the rest. */
function communitySources(ctx: ParserContext, claimed: Set<string>): { available: CommunitySource[]; omitted: string[] } {
  const available: CommunitySource[] = [];
  const omitted: string[] = [];
  for (const p of ctx.repoParsers) {
    if (p.kind === "enrichment" || p.is_imported) continue;
    const id = canonicalOf([p.name, ...(p.match_values ?? [])].filter((v): v is string => Boolean(v)));
    if (!id || claimed.has(id)) continue;
    if (!isSyslogCollectable(p)) {
      omitted.push(id);
      continue;
    }
    available.push({
      id,
      label: safeLabel(p.display_name ?? p.name, id),
      category: parserCategory(p),
      transports: parserTransports(p),
      filePath: p.file_path,
    });
  }
  available.sort((a, b) => a.id.localeCompare(b.id));
  omitted.sort((a, b) => a.localeCompare(b));
  return { available, omitted };
}

/**
 * Build the effective catalog for this run: curated builtins ∪ deployed parsers on the instance,
 * plus the community parsers that could be imported to collect something new.
 *
 * Only deployed sources become `catalog` entries with a listener port — a community parser has to
 * be asked for by name (or picked interactively), at which point resolveRequested() synthesizes
 * one and reviewParsers() offers the import.
 */
export function buildCatalog(ctx?: ParserContext): DiscoveryResult {
  const curated = SYSLOG_CATALOG;
  if (!ctx?.ok) {
    return { catalog: curated, discovered: [], available: [], omitted: [], fromInstance: false };
  }

  // Curated entries own their ids/source_types and every alias pointing at them, so a discovered
  // entry never shadows a vetted port or mode.
  const claimed = new Set<string>();
  for (const d of curated) {
    claimed.add(d.id);
    claimed.add(d.sourceType);
  }
  const takenPorts = new Set(curated.map((d) => d.port));

  const discovered: DeviceType[] = [];
  // Sort by name so a run is reproducible regardless of the API's ordering; ports are hashed and
  // therefore order-independent anyway, but collision probing is not.
  const deployed = ctx.deployed
    .filter((s) => s.deployed !== false)
    .slice()
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

  for (const src of deployed) {
    const values = logSourceValues(src);
    const canonical = canonicalOf(values);
    if (!canonical || claimed.has(canonical)) continue;

    const port = assignPort(canonical, takenPorts);
    if (port === undefined) continue; // range full; nothing sane to do but skip

    claimed.add(canonical);
    takenPorts.add(port);
    const aliases = [...new Set(values.map((v) => v.toLowerCase()).filter((v) => v !== canonical && isSafe(v)))];
    for (const a of aliases) claimed.add(a);

    discovered.push({
      id: canonical,
      label: safeLabel(src.name !== canonical ? src.name : undefined, canonical),
      sourceType: canonical,
      port,
      mode: "udp",
      origin: "discovered",
      ...(aliases.length ? { aliases } : {}),
    });
  }

  const { available, omitted } = communitySources(ctx, claimed);
  return { catalog: [...curated, ...discovered], discovered, available, omitted, fromInstance: true };
}

/** Match an id the operator typed against an entry's canonical value or any of its aliases. */
export function findDevice(catalog: DeviceType[], id: string): DeviceType | undefined {
  const want = id.toLowerCase();
  return catalog.find((d) => d.id.toLowerCase() === want || d.sourceType.toLowerCase() === want || (d.aliases ?? []).includes(want));
}

/**
 * A `--sources` entry: an id, optionally pinned to a transport with `id:tcp` / `id:udp`.
 *
 * The suffix exists because a discovered source_type has no vetted mode (we default to udp), and
 * because some curated vendors are genuinely deployment-dependent — pfSense and PAN-OS both carry
 * a note saying "switch if yours uses the other one", which previously meant editing the output.
 */
export interface SourceSelector {
  id: string;
  mode?: "udp" | "tcp";
}

export function parseSourceSelectors(raw: string): SourceSelector[] {
  const out: SourceSelector[] = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [id, suffix, ...rest] = part.split(":");
    if (rest.length > 0 || !id) {
      throw new Error(`Malformed --sources entry "${part}". Use "<source_type>" or "<source_type>:tcp".`);
    }
    if (suffix === undefined) {
      out.push({ id });
      continue;
    }
    const mode = suffix.toLowerCase();
    if (mode !== "udp" && mode !== "tcp") {
      throw new Error(`Unknown transport ":${suffix}" on "${part}". Use ":udp" or ":tcp".`);
    }
    out.push({ id, mode });
  }
  return out;
}

export interface ResolveResult {
  /** Entries to enable, in catalog order, with any :mode override applied. */
  selected: DeviceType[];
  /** Ids that matched nothing — neither catalog nor the community repo. */
  unknown: string[];
  /**
   * Entries synthesized from a repo parser the instance has NOT imported yet. They collect a real
   * listener now; reviewParsers() offers to deploy the parser right after.
   */
  fromRepo: DeviceType[];
  /**
   * Ids that name a real parser whose source doesn't arrive over syslog (CloudTrail, Okta, Sysmon
   * …). Generating a listener for these produces a port nothing ever connects to, so the caller
   * refuses rather than handing over a config that looks right and silently collects nothing.
   */
  notSyslog: { id: string; category?: string; transports?: string[] }[];
}

/**
 * Resolve typed ids against the catalog, then — for anything still unmatched — against the
 * community repo, so `--sources routeros` works the moment a parser for it exists anywhere nano
 * can see, not only once it's already deployed.
 */
export function resolveRequested(
  selectors: SourceSelector[],
  catalog: DeviceType[],
  ctx?: ParserContext,
): ResolveResult {
  const selected: DeviceType[] = [];
  const unknown: string[] = [];
  const fromRepo: DeviceType[] = [];
  const notSyslog: ResolveResult["notSyslog"] = [];
  const takenPorts = new Set(catalog.map((d) => d.port));

  // Two aliases of the same parser (or a plain repeat) must not emit two [sources.x] blocks —
  // Vector refuses to load a config with a duplicate component id.
  const seen = new Set<string>();

  for (const sel of selectors) {
    const hit = findDevice(catalog, sel.id);
    if (hit) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      selected.push(sel.mode ? { ...hit, mode: sel.mode } : hit);
      continue;
    }

    const want = sel.id.toLowerCase();
    if (seen.has(want)) continue;
    const repoHit = ctx?.ok
      ? ctx.repoParsers.find(
          (p) => p.kind !== "enrichment" && repoMatchValues(p).some((v) => v.toLowerCase() === want),
        )
      : undefined;
    if (!repoHit || !isSafe(want)) {
      unknown.push(sel.id);
      continue;
    }
    // A parser exists, but its source doesn't speak syslog — refuse instead of generating a
    // listener that will sit idle forever.
    if (!isSyslogCollectable(repoHit)) {
      notSyslog.push({ id: sel.id, category: parserCategory(repoHit), transports: parserTransports(repoHit) });
      continue;
    }

    const port = assignPort(want, takenPorts);
    if (port === undefined) {
      unknown.push(sel.id);
      continue;
    }
    takenPorts.add(port);
    seen.add(want);
    const device: DeviceType = {
      id: want,
      label: safeLabel(repoHit.display_name ?? repoHit.name, want),
      sourceType: want,
      port,
      mode: sel.mode ?? "udp",
      origin: "discovered",
    };
    selected.push(device);
    fromRepo.push(device);
  }

  return { selected, unknown, fromRepo, notSyslog };
}
