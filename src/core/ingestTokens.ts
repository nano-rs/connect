import type { NanoClient } from "./api.js";
import {
  type BindableSource,
  type IngestTokenInfo,
  type IngestTokenList,
  NanoApiError,
} from "./types.js";

/**
 * Per-source ingest tokens (nano NAN-3806).
 *
 * A current nano decides where an HTTP/HEC event lands from the TOKEN alone: every ingest token is
 * bound to exactly one log source, and every event sent with it lands in that source whatever
 * `X-Source-Type` / `sourcetype` it claims (a differing claim is kept only as
 * `claimed_source_type`). An unbound token is refused with 401, and there is no multiplex token.
 * So a collector that forwards several log types needs one sink per type, each with the token
 * bound to that type's source.
 *
 * Older nano (before NAN-3806) routed on `X-Source-Type` with one shared install token. connect
 * keeps working against those the old way (see `detectIngestModel`): the generated config has the
 * same shape either way — one sink per source_type, one token variable per sink — so the only
 * thing that differs is which value each variable holds.
 */

/** Which ingest contract the target nano speaks. */
export type IngestModel =
  /** Every token bound to one log source (NAN-3806+). */
  | { kind: "bound"; list: IngestTokenList & { sources: BindableSource[] } }
  /** A nano that predates per-source tokens: shared token + `X-Source-Type` routing. */
  | { kind: "legacy"; reason: string }
  /** Couldn't tell (no API key, key can't read tokens, unreachable). */
  | { kind: "unknown"; reason: string };

/**
 * Ask the instance which ingest contract it speaks. `GET /api/ingest-tokens` lists `sources` only
 * on a nano that binds tokens to sources; a nano without the endpoint answers 404.
 */
export async function detectIngestModel(client: NanoClient | undefined): Promise<IngestModel> {
  if (!client) return { kind: "unknown", reason: "no API key saved for this instance" };
  let list: IngestTokenList;
  try {
    list = await client.listIngestTokens();
  } catch (err) {
    const status = err instanceof NanoApiError ? err.status : undefined;
    if (status === 404) {
      return {
        kind: "legacy",
        reason: "this nano has no /api/ingest-tokens (it predates per-source ingest tokens, or it is a hosted tenant)",
      };
    }
    if (status === 401 || status === 403) {
      return { kind: "unknown", reason: "your API key can't read ingest tokens (it needs log_sources:view)" };
    }
    return {
      kind: "unknown",
      reason: `couldn't read ingest tokens (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (list && Array.isArray(list.sources)) {
    return {
      kind: "bound",
      list: { ...list, tokens: Array.isArray(list.tokens) ? list.tokens : [], sources: list.sources },
    };
  }
  return {
    kind: "legacy",
    reason: "this nano predates per-source ingest tokens (NAN-3806): it lists no bindable sources",
  };
}

/** Env var a generated config reads a source's token from: `NANO_TOKEN_<SOURCE_TYPE>`. */
export function tokenEnvVar(sourceType: string): string {
  const key = sourceType
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `NANO_TOKEN_${key || "SOURCE"}`;
}

/** Token prefix nano lists for an issued token: `nit_` plus 8 characters. */
const ISSUED_PREFIX_LEN = 12;
export const ISSUED_TOKEN_MARKER = "nit_";

/**
 * Parse `a=b,c=d` (the shape of `--source-token` / `--source-map`). Values may contain `=`;
 * keys are source_types.
 */
export function parsePairs(raw: string | undefined, flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq <= 0 || eq === item.length - 1) {
      throw new NanoApiError(`Invalid ${flag} entry "${item.split("=")[0]}=…" (expected <source_type>=<value>).`);
    }
    out[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
  }
  return out;
}

/**
 * The log source a source_type should land in: an explicit `--source-map` choice (source id,
 * route key or name, case-insensitive), else the source whose route key IS the source_type.
 * Enabled sources win a tie.
 */
export function matchSource(
  sourceType: string,
  sources: BindableSource[],
  override?: string,
): BindableSource | undefined {
  const ordered = [...sources].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  if (override) {
    const want = override.toLowerCase();
    return (
      ordered.find((s) => s.source_id.toLowerCase() === want) ??
      ordered.find((s) => s.route_key.toLowerCase() === want) ??
      ordered.find((s) => s.name.toLowerCase() === want)
    );
  }
  return ordered.find((s) => s.route_key === sourceType);
}

/** A token connect issued earlier for a source_type, as saved in the profile. */
export interface SavedSourceToken {
  credentialId: string;
  sourceId: string;
  token: string;
}

/** What to do to get a token bound to one source. */
export type TokenPlan =
  /** A token connect saved earlier is still active and bound to this source. */
  | { kind: "reuse"; credentialId: string; token: string }
  /** A supplied issued token is unbound: bind it to this source, then use it. */
  | { kind: "bind"; credentialId: string; token: string }
  /** A supplied token already lands in this source. */
  | { kind: "use"; token: string; credentialId?: string }
  /** Issue a new token bound to this source. */
  | { kind: "create"; replaces?: string }
  | { kind: "error"; message: string };

function describe(t: { source_name?: string | null; route_key?: string | null }): string {
  if (t.source_name && t.route_key) return `"${t.source_name}" (${t.route_key})`;
  return t.route_key ?? t.source_name ?? "another source";
}

/**
 * Decide, without side effects, how `sourceType` gets a token bound to `source`.
 *
 * - A supplied issued token (`nit_…`) is matched to its credential by prefix: unbound → bind it,
 *   bound here → use it, bound elsewhere → refuse (a binding never changes).
 * - A supplied non-issued token can only be the install token: usable only if the install token
 *   is bound to this very source.
 * - Otherwise reuse the saved token while it is still active and bound here, else issue one.
 */
export function planToken(args: {
  sourceType: string;
  source: BindableSource;
  list: IngestTokenList;
  supplied?: string;
  saved?: SavedSourceToken;
}): TokenPlan {
  const { sourceType, source, list, supplied, saved } = args;
  const tokens: IngestTokenInfo[] = list.tokens ?? [];

  if (supplied) {
    if (supplied.startsWith(ISSUED_TOKEN_MARKER)) {
      const prefix = supplied.slice(0, ISSUED_PREFIX_LEN);
      const cred = tokens.find((t) => t.token_prefix === prefix);
      if (!cred) {
        return {
          kind: "error",
          message: `The token given for ${sourceType} (${prefix}…) isn't an ingest token on this nano. Check you copied it from this instance, or let connect issue one.`,
        };
      }
      if (cred.state === "revoked") {
        return {
          kind: "error",
          message: `The token given for ${sourceType} ("${cred.name}", ${prefix}…) is revoked. Issue a new one, or let connect issue one.`,
        };
      }
      if (!cred.source_id || cred.state === "unbound") {
        return { kind: "bind", credentialId: cred.credential_id, token: supplied };
      }
      if (cred.source_id === source.source_id) {
        return { kind: "use", token: supplied, credentialId: cred.credential_id };
      }
      return {
        kind: "error",
        message:
          `The token given for ${sourceType} ("${cred.name}", ${prefix}…) is bound to ${describe(cred)}, ` +
          `so its events would land there, not in "${source.name}". A binding never changes: issue a ` +
          `token bound to "${source.name}" (or let connect issue one).`,
      };
    }
    const install = list.install_token;
    if (install?.source_id && install.source_id === source.source_id && install.state !== "disabled") {
      return { kind: "use", token: supplied };
    }
    return {
      kind: "error",
      message:
        `The token given for ${sourceType} isn't an issued ingest token (nit_…). If it is the install ` +
        `token (VECTOR_AUTH_TOKEN), it ${
          install?.route_key ? `lands only in "${install.route_key}"` : "isn't bound to any source, so nano refuses it (401)"
        }. Let connect issue a token bound to "${source.name}", or pass one with --source-token ${sourceType}=<token>.`,
    };
  }

  if (saved) {
    const cred = tokens.find((t) => t.credential_id === saved.credentialId);
    if (cred && cred.state === "active" && cred.source_id === source.source_id && saved.sourceId === source.source_id) {
      return { kind: "reuse", credentialId: saved.credentialId, token: saved.token };
    }
    return { kind: "create", replaces: cred && cred.state !== "revoked" ? saved.credentialId : undefined };
  }
  return { kind: "create" };
}

/** Name for a token connect issues: unique-ish, readable in Ingestion → Credentials, ≤100 chars. */
export function tokenName(sourceType: string, host: string, suffix?: string): string {
  const base = `nano-connect ${sourceType} @ ${host}`;
  const full = suffix ? `${base} ${suffix}` : base;
  return full.slice(0, 100);
}

/**
 * Operator-facing explanation for an ingest rejection. On a nano that binds tokens to sources a
 * 401 almost always means "this token isn't bound" — say how to fix that, not "wrong token".
 */
export function ingestRejectionMessage(status: number, model: IngestModel["kind"]): string {
  if (model === "legacy") {
    return `Ingest token rejected (${status}). Check VECTOR_AUTH_TOKEN matches this instance.`;
  }
  return (
    `nano refused the ingest token (${status}). nano binds every ingest token to exactly one log ` +
    `source and refuses a token that isn't bound to one. Bind it in Ingestion → Credentials → Bind ` +
    `(or POST /api/ingest-tokens/{credential_id}/bind), or let \`connect add-* --transport http\` issue ` +
    `one token per source.` +
    (model === "unknown" ? " On an older nano this means the token is wrong for this instance." : "")
  );
}

/** Ingest tokens go into a dotenv file and an HTTP header: refuse anything that could break out. */
export function assertTokenShape(token: string, label: string): void {
  if (!/^[A-Za-z0-9._~+/=-]{8,512}$/.test(token)) {
    throw new NanoApiError(
      `The ingest token for ${label} has characters a token never has (whitespace, quotes, newlines). Re-copy it.`,
    );
  }
}
