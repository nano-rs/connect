import { log, note, select } from "@clack/prompts";
import { hostname } from "node:os";
import pc from "picocolors";
import type { NanoClient } from "./core/api.js";
import {
  assertTokenShape,
  detectIngestModel,
  type IngestModel,
  matchSource,
  parsePairs,
  planToken,
  tokenName,
} from "./core/ingestTokens.js";
import { loadInstance, saveSourceToken } from "./core/profile.js";
import { type BindableSource, type IngestTokenInfo, NanoApiError } from "./core/types.js";
import type { NanoUplink } from "./core/uplink.js";
import { orExit } from "./ui/ui.js";

/** CLI options every HTTP-capable generator takes for per-source tokens. */
export interface SourceTokenOptions {
  /** `--source-token st=token,...`: tokens you already have, one per source_type. */
  sourceToken?: string;
  /** `--source-map st=<log source>,...`: which nano log source each source_type lands in. */
  sourceMap?: string;
  /** `--ingest-token`, when passed explicitly on this run. */
  ingestToken?: string;
  nonInteractive?: boolean;
}

export interface AttachSourceTokensArgs {
  baseUrl: string;
  client?: NanoClient;
  /** The source_types this config forwards, one sink each. */
  sourceTypes: string[];
  /**
   * source_types a missing log source should SKIP (sink commented out) instead of failing a
   * non-interactive run — e.g. the aggregator's speculative agent types.
   */
  optional?: string[];
  opts: SourceTokenOptions;
}

const SKIP = "__skip__";

function sourceList(sources: BindableSource[]): string {
  return sources.length
    ? sources.map((s) => `${s.route_key} ("${s.name}")`).join(", ")
    : "none — import a parser (--deploy-parsers) or create a log source first";
}

/** Turn an API failure while issuing/binding into something an operator can act on. */
function tokenApiError(err: unknown, action: string, sourceType: string): Error {
  if (err instanceof NanoApiError && (err.status === 401 || err.status === 403)) {
    return new NanoApiError(
      `Your API key can't ${action} ingest tokens (it needs settings:system, an admin's permission). ` +
        `Re-run \`connect\` as an admin to mint a key that can, or issue a token bound to the ` +
        `${sourceType} log source in Ingestion → Credentials and pass --source-token ${sourceType}=<token>.`,
      err.status,
    );
  }
  if (err instanceof NanoApiError && err.status === 409 && action === "bind") {
    return new NanoApiError(
      `That token is already bound to a log source, and a binding never changes. Issue a new token ` +
        `for ${sourceType}, or let connect issue one.`,
      409,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Give every HTTP sink its own token. Against a nano that binds tokens to sources (NAN-3806) that
 * means: pick the log source each source_type lands in (asking per device/feed when interactive),
 * then reuse, bind or issue a token bound to it. Against an older nano, every sink gets the shared
 * ingest token and nano keeps routing on `X-Source-Type`. Native uplinks are returned unchanged.
 */
export async function attachSourceTokens(
  uplink: NanoUplink,
  args: AttachSourceTokensArgs,
): Promise<NanoUplink> {
  if (uplink.transport !== "http") return uplink;
  const types = [...new Set(args.sourceTypes.filter(Boolean))];
  if (types.length === 0) return { ...uplink, sourceTokens: {}, skipped: {} };

  const supplied = parsePairs(args.opts.sourceToken, "--source-token");
  for (const [st, token] of Object.entries(supplied)) assertTokenShape(token, st);
  const model = await detectIngestModel(args.client);

  if (model.kind !== "bound") return sharedTokens(uplink, types, supplied, model);

  // One explicit --ingest-token can only ever be one source's token.
  if (args.opts.ingestToken && types.length === 1 && !supplied[types[0]!]) {
    supplied[types[0]!] = args.opts.ingestToken;
  } else if (args.opts.ingestToken && types.length > 1) {
    log.warn(
      `Ignoring --ingest-token: nano binds each ingest token to one log source, and this config ` +
        `forwards ${types.length} source types. Pass ${pc.cyan("--source-token <source_type>=<token>")} ` +
        `per type, or let connect issue them.`,
    );
  }

  const client = args.client!;
  const { sources } = model.list;
  let tokenList = model.list;
  const sourceMap = parsePairs(args.opts.sourceMap, "--source-map");
  const saved = loadInstance(args.baseUrl).sourceTokens ?? {};
  const optional = new Set(args.optional ?? []);
  const host = hostname();

  const tokens: Record<string, string> = {};
  const skipped: Record<string, string> = {};
  const summary: string[] = [];

  log.info(
    "This nano binds every ingest token to exactly one log source: the token alone decides where " +
      "events land. Each source type below gets its own sink and its own token.",
  );

  for (const st of types) {
    const override = sourceMap[st];
    const matched = matchSource(st, sources, override);
    if (override && !matched) {
      throw new NanoApiError(
        `--source-map ${st}=${override}: no log source has that id, route key or name. Sources: ${sourceList(sources)}.`,
      );
    }

    let source: BindableSource | undefined = matched;
    if (!args.opts.nonInteractive && !override && sources.length > 0) {
      const choice = orExit(
        await select({
          message: `Which nano log source should ${pc.cyan(st)} land in?`,
          options: [
            ...sources.map((s) => ({
              value: s.source_id,
              label: s.name,
              hint: `route key ${s.route_key}${s.enabled ? "" : " · disabled"}`,
            })),
            { value: SKIP, label: "Skip for now", hint: "the sink ships commented out" },
          ],
          initialValue: matched?.source_id ?? SKIP,
        }),
      ) as string;
      source = choice === SKIP ? undefined : sources.find((s) => s.source_id === choice);
    }

    if (!source) {
      if (args.opts.nonInteractive && !optional.has(st)) {
        throw new NanoApiError(
          `No nano log source for ${st}, so there's no token to send it with. Deploy its parser ` +
            `(--deploy-parsers), or pick one with --source-map ${st}=<log source>. Sources: ${sourceList(sources)}.`,
        );
      }
      skipped[st] = matched || sources.length === 0 ? "no nano log source for it yet" : "skipped when asked for its log source";
      continue;
    }

    const plan = planToken({ sourceType: st, source, list: tokenList, supplied: supplied[st], saved: saved[st] });
    switch (plan.kind) {
      case "error":
        throw new NanoApiError(plan.message);
      case "reuse":
      case "use":
        tokens[st] = plan.token;
        summary.push(`${st} → ${source.name}: ${plan.kind === "reuse" ? "reusing the token connect issued earlier" : "using the token you gave"}`);
        break;
      case "bind": {
        let bound: IngestTokenInfo;
        try {
          bound = await client.bindIngestToken(plan.credentialId, source.source_id);
        } catch (err) {
          throw tokenApiError(err, "bind", st);
        }
        tokens[st] = plan.token;
        saveSourceToken(args.baseUrl, st, {
          credentialId: plan.credentialId,
          sourceId: source.source_id,
          token: plan.token,
        });
        summary.push(`${st} → ${source.name}: bound your token "${bound.name}" (${bound.token_prefix}…)`);
        break;
      }
      case "create": {
        let issued;
        try {
          issued = await client.createIngestToken(tokenName(st, host), source.source_id);
        } catch (err) {
          // Names are unique among active tokens; a second collector on this host needs another.
          if (err instanceof NanoApiError && err.status === 409) {
            try {
              issued = await client.createIngestToken(tokenName(st, host, Date.now().toString(36)), source.source_id);
            } catch (retryErr) {
              throw tokenApiError(retryErr, "issue", st);
            }
          } else {
            throw tokenApiError(err, "issue", st);
          }
        }
        assertTokenShape(issued.token, st);
        tokens[st] = issued.token;
        saveSourceToken(args.baseUrl, st, {
          credentialId: issued.credential.credential_id,
          sourceId: source.source_id,
          token: issued.token,
        });
        tokenList = { ...tokenList, tokens: [...tokenList.tokens, issued.credential] };
        summary.push(
          `${st} → ${source.name}: issued "${issued.credential.name}" (${issued.credential.token_prefix}…)` +
            (plan.replaces ? pc.dim(` — the one issued earlier no longer lands here; revoke it in Ingestion → Credentials if nothing uses it`) : ""),
        );
        break;
      }
    }
  }

  if (summary.length > 0) note(summary.join("\n"), "Ingest tokens (one per log source)");
  const skippedTypes = Object.keys(skipped);
  if (skippedTypes.length > 0) {
    log.warn(
      `Not forwarded yet (sink commented out, no token): ${skippedTypes.map((s) => pc.cyan(s)).join(", ")}. ` +
        `Deploy a parser / create a log source for them, then re-run this command.`,
    );
  }
  return { ...uplink, sourceTokens: tokens, skipped };
}

/** An older nano (or one we can't read): every sink gets the shared token, routing on the header. */
function sharedTokens(
  uplink: NanoUplink,
  types: string[],
  supplied: Record<string, string>,
  model: Exclude<IngestModel, { kind: "bound" }>,
): NanoUplink {
  const shared = uplink.ingestToken;
  const missing = types.filter((st) => !supplied[st]);
  if (missing.length > 0 && !shared) {
    throw new NanoApiError(
      `--transport http needs an ingest token for ${missing.join(", ")}. Run \`connect\` first so the ` +
        `install token is saved, pass --ingest-token, or pass --source-token <source_type>=<token>.`,
    );
  }
  if (shared) assertTokenShape(shared, "the shared ingest token");
  if (model.kind === "legacy") {
    log.info(
      `${model.reason[0]!.toUpperCase()}${model.reason.slice(1)}: every sink uses the shared ingest token ` +
        `and nano routes on X-Source-Type. After upgrading nano, re-run this command to give each ` +
        `source its own bound token.`,
    );
  } else {
    log.warn(
      `Couldn't tell whether this nano binds ingest tokens to log sources (${model.reason}). Using ` +
        `the shared ingest token for every sink. A nano with per-source tokens refuses it (401) ` +
        `unless it is bound, and then lands every type in that one source. Re-run \`connect\` to ` +
        `mint a key that can read ingest tokens.`,
    );
  }
  const tokens: Record<string, string> = {};
  for (const st of types) tokens[st] = supplied[st] ?? shared!;
  return { ...uplink, sourceTokens: tokens, skipped: {} };
}
