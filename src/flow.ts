import {
  cancel,
  confirm,
  intro,
  log,
  note,
  outro,
  password,
  select,
  spinner,
  text,
} from "@clack/prompts";
import pc from "picocolors";
import { NanoClient } from "./core/api.js";
import { ingestCandidates, isInsecureRemote, normalizeBaseUrl } from "./core/endpoints.js";
import { findEnvFile } from "./core/env.js";
import { probeIngestEndpoint, sendTestEvent } from "./core/ingest.js";
import { detectIngestModel, type IngestModel, ingestRejectionMessage } from "./core/ingestTokens.js";
import { currentBaseUrl, knownInstances, loadInstance, saveInstance } from "./core/profile.js";
import { ELEVATED_SCOPES, REQUIRED_SCOPES, SCOPE_DESCRIPTIONS, TOKEN_SCOPES } from "./core/scopes.js";
import { NanoApiError } from "./core/types.js";
import { hasRecentEvents, verifyMarker } from "./core/verify.js";
import { maskSecret, orExit } from "./ui/ui.js";

/** source_type used for the synthetic connectivity-check event. */
const TEST_SOURCE_TYPE = "nano_connect_test";

export interface ConnectOptions {
  url?: string;
  apiKey?: string;
  envFile?: string;
  nonInteractive?: boolean;
  /** Override the search endpoint (split deployments serve it on a different host/port). */
  searchUrl?: string;
  /** Override the ingest endpoint (split deployments hit Vector directly, e.g. :8080). */
  ingestUrl?: string;
  /**
   * An ingest token to test with. On a nano that binds tokens to log sources: a token bound to
   * one (optional). On an older nano: VECTOR_AUTH_TOKEN, otherwise read from .env or prompted.
   */
  ingestToken?: string;
}

export async function runConnect(opts: ConnectOptions): Promise<void> {
  // No interactive terminal → never sit on a prompt that would auto-cancel and exit 0; fail
  // loudly on missing values instead. (CI, pipes.)
  if (!process.stdin.isTTY) opts = { ...opts, nonInteractive: true };

  intro(pc.inverse(" nano connect "));

  const env = findEnvFile(opts.envFile);
  if (env) {
    log.info(`Found a nano install config at ${pc.dim(env.path)} — using it for defaults.`);
  }

  // 1. Base URL
  const baseUrl = normalizeBaseUrl(
    opts.url ??
      currentBaseUrl() ??
      env?.baseUrl ??
      (await promptRequired(opts, "What's your nano URL?", {
        placeholder: "https://nano.example.com",
      })),
  );

  if (isInsecureRemote(baseUrl)) {
    log.warn(
      `${baseUrl} is plain http to a remote host — your API key and ingest token would be sent in the clear. Use https unless this is a trusted private network.`,
    );
    if (!opts.nonInteractive) {
      const go = orExit(await confirm({ message: "Continue over http anyway?", initialValue: false }));
      if (!go) {
        cancel("Stopped. Re-run with an https URL.");
        process.exit(0);
      }
    }
  }

  // Everything saved for THIS instance. A different instance's secrets are never in scope.
  const profile = loadInstance(baseUrl);
  const client = new NanoClient(baseUrl, { searchUrl: opts.searchUrl });

  // 2. Connectivity — probe /api/setup/status: it's a stable JSON endpoint under /api on BOTH
  // the nginx-fronted layout (where /health serves the SPA) and the split-port dev layout.
  const s = spinner();
  s.start(`Reaching ${baseUrl}`);
  let initialized = true;
  try {
    initialized = (await client.setupStatus()).initialized;
  } catch {
    s.stop(pc.red(`Could not reach ${baseUrl}`));
    log.error(
      "nano didn't respond at /api. Check the URL, that the stack is up, and that you can reach it from here.",
    );
    process.exit(1);
  }
  s.stop(pc.green(`Connected to ${baseUrl}`));
  if (!initialized) {
    log.warn(
      `This nano instance hasn't been set up yet. Finish setup at ${baseUrl} (create the first admin), then re-run.`,
    );
  }

  // 3. API key (for the verify search + later parser matching)
  const apiKey = await resolveApiKey(client, opts, profile.apiKey);
  client.setApiKey(apiKey);

  // 4. Which ingest contract does this nano speak? A current nano binds every ingest token to one
  // log source (NAN-3806): there is no shared token to ask for, and `add-*` issues one per source.
  const model = await detectIngestModel(client);
  const ingestEndpoints = ingestCandidates(baseUrl, opts.ingestUrl);
  if (model.kind === "bound") {
    saveInstance(baseUrl, { apiKey, searchUrl: opts.searchUrl });
    log.info(
      "This nano binds every ingest token to exactly one log source: the token alone decides where " +
        `events land, and an unbound token is refused (401). No shared token needed — ${pc.cyan(
          "add-* --transport http",
        )} issues one token per source.`,
    );
    await runBoundIngestCheck(client, baseUrl, ingestEndpoints, model, opts);
  } else {
    // 4b. Older nano: one shared ingest token (separate from the API key), routed by X-Source-Type.
    if (model.kind === "unknown") {
      log.warn(`Couldn't tell whether this nano binds ingest tokens to log sources (${model.reason}).`);
    }
    const ingestToken =
      opts.ingestToken ??
      env?.ingestToken ??
      profile.ingestToken ??
      (await promptRequired(opts, "Paste your nano ingest token (VECTOR_AUTH_TOKEN)", {
        isSecret: true,
        hint: "Self-hosted: it's in your nano install's .env. SaaS: from your nano admin console.",
      }));

    saveInstance(baseUrl, { apiKey, ingestToken, searchUrl: opts.searchUrl });

    // 5. Prove the full path works end-to-end with a synthetic event.
    await runConnectivityCheck(client, baseUrl, ingestEndpoints, ingestToken, opts, TEST_SOURCE_TYPE, model.kind);
  }

  note(
    [
      "Connection verified and saved. Next — set up a collector:",
      `  ${pc.cyan("connect add-source")}      syslog from network devices`,
      `  ${pc.cyan("connect add-agent")}       Windows Event Log / Linux journald + files`,
      `  ${pc.cyan("connect add-aggregator")}  a pool that fans endpoints into nano`,
    ].join("\n"),
    "What's next",
  );
  outro(pc.green("Ready to bring data in."));
}

/** Resolve an API key: reuse a saved/flagged one (validated), else paste, else log in + mint. */
async function resolveApiKey(
  client: NanoClient,
  opts: ConnectOptions,
  saved?: string,
): Promise<string> {
  const candidate = opts.apiKey ?? saved;
  if (candidate) {
    client.setApiKey(candidate);
    const s = spinner();
    s.start("Checking your API key");
    const state = await client.validateApiKey();
    if (state === "ok") {
      s.stop(pc.green("API key works — API and search are reachable"));
      return candidate;
    }
    s.stop(
      state === "unauthorized"
        ? pc.yellow("Saved API key was rejected")
        : pc.yellow("Couldn't verify the saved API key (search unreachable)"),
    );
    client.setApiKey("");
  }

  if (opts.nonInteractive) {
    throw new NanoApiError("No valid API key available and running non-interactively.");
  }

  const method = orExit(
    await select({
      message: "How should I authenticate to the nano API?",
      options: [
        { value: "login", label: "Log in and create an API key for me (recommended)" },
        { value: "paste", label: "I'll paste an existing API key" },
      ],
    }),
  );

  if (method === "paste") {
    const key = orExit(
      await password({
        message: "Paste your nano API key",
        validate: (v) => (v.trim().length < 8 ? "That doesn't look like a key." : undefined),
      }),
    );
    client.setApiKey(key.trim());
    const s = spinner();
    s.start("Checking your API key");
    const state = await client.validateApiKey();
    if (state === "ok") {
      s.stop(pc.green("API key works"));
      return key.trim();
    }
    s.stop(state === "unauthorized" ? pc.red("That key was rejected") : pc.red("Couldn't reach search to verify the key"));
    throw new NanoApiError(
      state === "unauthorized"
        ? "The pasted API key was rejected by nano."
        : "Couldn't verify the API key — search wasn't reachable.",
    );
  }

  return await loginAndMint(client);
}

/** Email/password login, then mint a scoped API key — showing exactly what we'll request. */
async function loginAndMint(client: NanoClient): Promise<string> {
  const email = orExit(
    await text({ message: "nano email", validate: (v) => (v.includes("@") ? undefined : "Enter a valid email.") }),
  );
  const pass = orExit(await password({ message: "nano password" }));

  const s = spinner();
  s.start("Logging in");
  let accessToken: string;
  try {
    const auth = await client.login(email.trim(), pass);
    accessToken = auth.tokens.access_token;
    s.stop(pc.green(`Logged in as ${auth.user.email}`));
  } catch (err) {
    s.stop(pc.red("Login failed"));
    throw err;
  }

  note(
    [...REQUIRED_SCOPES, ...ELEVATED_SCOPES, ...TOKEN_SCOPES]
      .map((scope) => `  ${pc.cyan(scope)} — ${SCOPE_DESCRIPTIONS[scope] ?? ""}`)
      .join("\n") + pc.dim(
        `\n  (the last ${ELEVATED_SCOPES.length + TOKEN_SCOPES.length} are best-effort — skipped if your account can't grant them)`,
      ),
    "I'll create an API key named 'nano-connect' with these permissions",
  );
  const proceed = orExit(await confirm({ message: "Create this API key?" }));
  if (!proceed) {
    throw new NanoApiError("API key creation declined.");
  }

  s.start("Creating API key");
  // Ask for the most capable key first and step down when the account can't grant it: token
  // issuing (admins only) → parser deploy → read-only.
  const tiers: { scopes: string[]; note?: string }[] = [
    { scopes: [...REQUIRED_SCOPES, ...ELEVATED_SCOPES, ...TOKEN_SCOPES] },
    {
      scopes: [...REQUIRED_SCOPES, ...ELEVATED_SCOPES],
      note: "your account can't issue ingest tokens, so for --transport http pass tokens bound to your log sources with --source-token",
    },
    {
      scopes: [...REQUIRED_SCOPES],
      note: "your account can't grant parser-deploy or token permissions, so the CLI will point you to the platform for those",
    },
  ];
  let lastErr: unknown;
  for (const tier of tiers) {
    try {
      const created = await client.createApiKey(accessToken, "nano-connect", tier.scopes);
      s.stop(pc.green(`Created API key ${pc.dim(created.key_prefix + "…")}`));
      log.info(
        `Stored key ${pc.dim(maskSecret(created.key))} in your local profile${tier.note ? ` (${tier.note})` : ""}.`,
      );
      return created.key;
    } catch (err) {
      lastErr = err;
      if (!(err instanceof NanoApiError && err.status === 403)) break;
    }
  }
  s.stop(pc.red("Could not create API key"));
  if (lastErr instanceof NanoApiError && lastErr.status === 403) {
    log.error(
      "Your account is missing one of the required permissions, so it can't grant them to a key. Ask an admin, or paste a key that already has them.",
    );
  }
  throw lastErr;
}

/** Send a synthetic event and confirm it becomes searchable — the end-to-end smoke test. */
async function runConnectivityCheck(
  client: NanoClient,
  baseUrl: string,
  ingestEndpoints: string[],
  ingestToken: string,
  opts: ConnectOptions,
  sourceType: string = TEST_SOURCE_TYPE,
  model: IngestModel["kind"] = "legacy",
): Promise<void> {
  if (!opts.nonInteractive) {
    const run = orExit(
      await confirm({
        message: "Send a test event now to confirm ingestion works end-to-end?",
        initialValue: true,
      }),
    );
    if (!run) return;
  }

  const s = spinner();
  s.start("Sending a test event");
  let marker: string;
  try {
    const sent = await sendTestEvent(ingestEndpoints, ingestToken, sourceType, model);
    marker = sent.marker;
    // Remember which candidate won so `add-* --transport http` targets a proven URL.
    saveInstance(baseUrl, { ingestUrl: sent.endpoint });
    s.stop(pc.green(`Test event accepted by ${sent.endpoint}`));
  } catch (err) {
    s.stop(pc.red("Ingest failed"));
    throw err;
  }

  // See if it becomes searchable. Budget this generously: a single event waits out Vector's
  // sink batch timer (10s by default) AND ClickHouse's async-insert window (adaptive, up to 10s,
  // and it sits at the high end on a quiet instance) before it can be selected. A 12s budget —
  // what this used to be — expires below that floor, so a healthy instance reported "accepted but
  // not searchable" on essentially every first run. Measured 12–35s on managed tenants.
  s.start("Checking whether it's already searchable");
  const result = await verifyMarker(client, sourceType, marker, { timeoutMs: 45_000 });
  if (result.arrived) {
    s.stop(pc.green(`Searchable already (${result.count} match) — ingest + query both work`));
  } else {
    s.stop(pc.green("Ingest endpoint accepted the event"));
    // Two very different causes look identical from here, so ask the instance which one it is
    // rather than asserting. A wrong token loses only OUR event (nano answers 200 and drops it
    // downstream); a stalled pipeline loses everyone's.
    const others = await hasRecentEvents(client);
    if (others === true) {
      log.warn(
        `The endpoint accepted the event, but it never became searchable — while other events ARE arriving on this instance. That points at the ingest token: nano returns 200 and drops events with a wrong token, so a successful POST doesn't prove the credential. Re-check ${pc.cyan(
          "VECTOR_AUTH_TOKEN",
        )} against this instance.`,
      );
    } else if (others === false) {
      log.warn(
        `The endpoint accepted the event, but it never became searchable — and no events at all are arriving on this instance right now. That looks like the instance isn't delivering to storage, rather than anything wrong with your token or this collector. Check the nano deployment's health, then re-check with ${pc.cyan(
          `connect verify --source ${sourceType}`,
        )}. (On a brand-new instance with no other sources yet, this is also just what "no data" looks like.)`,
      );
    } else {
      log.warn(
        `The endpoint accepted the event, but it isn't searchable yet and I couldn't check whether other events are arriving. Two usual causes: a wrong ${pc.cyan(
          "VECTOR_AUTH_TOKEN",
        )} (nano returns 200 and drops it), or a slow flush. Re-check with ${pc.cyan(
          `connect verify --source ${sourceType}`,
        )}.`,
      );
    }
  }
}

/**
 * The ingest check against a nano that binds tokens to log sources. With a token (--ingest-token)
 * it sends the marked test event, which lands in that token's source — so that is where it is
 * looked for. Without one, it only locates the ingest endpoint (an unauthenticated POST is
 * refused there, nothing is ingested) so `add-* --transport http` targets a proven URL.
 */
async function runBoundIngestCheck(
  client: NanoClient,
  baseUrl: string,
  ingestEndpoints: string[],
  model: Extract<IngestModel, { kind: "bound" }>,
  opts: ConnectOptions,
): Promise<void> {
  const token = opts.ingestToken;
  if (token) {
    const cred = model.list.tokens.find((t) => t.token_prefix === token.slice(0, 12));
    const route = cred ? (cred.state === "active" ? cred.route_key : undefined) : model.list.install_token?.state === "active"
        ? model.list.install_token.route_key
        : undefined;
    if (!route) {
      throw new NanoApiError(
        cred?.state === "revoked"
          ? `The --ingest-token "${cred.name}" is revoked.`
          : ingestRejectionMessage(401, "bound"),
      );
    }
    await runConnectivityCheck(client, baseUrl, ingestEndpoints, token, opts, route, "bound");
    return;
  }
  const s = spinner();
  s.start("Locating the ingest endpoint");
  const endpoint = await probeIngestEndpoint(ingestEndpoints);
  if (endpoint) {
    saveInstance(baseUrl, { ingestUrl: endpoint });
    s.stop(pc.green(`Ingest endpoint: ${endpoint} (it requires a source-bound token, as it should)`));
  } else {
    s.stop(pc.yellow("Couldn't locate the HTTP ingest endpoint"));
    log.warn(
      `None of ${ingestEndpoints.join(", ")} answered like nano's ingest endpoint. The native uplink ` +
        `is unaffected; for --transport http pass ${pc.cyan("--ingest-url")}.`,
    );
  }
}

/** Prompt for a required string, or throw in non-interactive mode. */
async function promptRequired(
  opts: ConnectOptions,
  message: string,
  o: { placeholder?: string; hint?: string; isSecret?: boolean } = {},
): Promise<string> {
  if (opts.nonInteractive) {
    throw new NanoApiError(`Missing required value (${message}) in non-interactive mode.`);
  }
  if (o.hint) log.info(pc.dim(o.hint));
  const value = o.isSecret
    ? orExit(await password({ message }))
    : orExit(
        await text({
          message,
          placeholder: o.placeholder,
          validate: (v) => (v.trim().length === 0 ? "Required." : undefined),
        }),
      );
  return value.trim();
}
