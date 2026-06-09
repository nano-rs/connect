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
import { ingestUrl, isInsecureRemote, normalizeBaseUrl } from "./core/endpoints.js";
import { findEnvFile } from "./core/env.js";
import { sendTestEvent } from "./core/ingest.js";
import { loadProfile, saveProfile } from "./core/profile.js";
import { ELEVATED_SCOPES, REQUIRED_SCOPES, SCOPE_DESCRIPTIONS } from "./core/scopes.js";
import { NanoApiError } from "./core/types.js";
import { verifyMarker } from "./core/verify.js";
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
  /** Provide the ingest token (VECTOR_AUTH_TOKEN) directly instead of via .env/prompt. */
  ingestToken?: string;
}

export async function runConnect(opts: ConnectOptions): Promise<void> {
  // No interactive terminal → never sit on a prompt that would auto-cancel and exit 0; fail
  // loudly on missing values instead. (CI, pipes.)
  if (!process.stdin.isTTY) opts = { ...opts, nonInteractive: true };

  intro(pc.inverse(" nano connect "));

  const profile = loadProfile();
  const env = findEnvFile(opts.envFile);
  if (env) {
    log.info(`Found a nano install config at ${pc.dim(env.path)} — using it for defaults.`);
  }

  // 1. Base URL
  const baseUrl = normalizeBaseUrl(
    opts.url ??
      profile.baseUrl ??
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

  const client = new NanoClient(baseUrl, { searchUrl: opts.searchUrl });

  // 2. Connectivity
  const s = spinner();
  s.start(`Reaching ${baseUrl}`);
  const healthy = await client.health();
  if (!healthy) {
    s.stop(pc.red(`Could not reach ${baseUrl}/health`));
    log.error(
      "nano didn't answer its health check. Check the URL, that the stack is up, and that you can reach it from here.",
    );
    process.exit(1);
  }
  let initialized = true;
  try {
    initialized = (await client.setupStatus()).initialized;
  } catch {
    // setup/status is best-effort; don't block on it.
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

  // 4. Ingest token (separate from the API key)
  const ingestToken =
    opts.ingestToken ??
    env?.ingestToken ??
    profile.ingestToken ??
    (await promptRequired(opts, "Paste your nano ingest token (VECTOR_AUTH_TOKEN)", {
      isSecret: true,
      hint: "Self-hosted: it's in your nano install's .env. SaaS: from your nano admin console.",
    }));

  saveProfile({ baseUrl, apiKey, ingestToken, searchUrl: opts.searchUrl });

  // 5. Prove the full path works end-to-end with a synthetic event.
  const ingestEndpoint = opts.ingestUrl ?? ingestUrl(baseUrl);
  await runConnectivityCheck(client, ingestEndpoint, ingestToken, opts);

  note(
    [
      "Connection verified and saved. Next:",
      `  ${pc.cyan("connect")} will help you set up a collector (syslog / Windows / files) — coming next.`,
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
    [...REQUIRED_SCOPES, ...ELEVATED_SCOPES]
      .map((scope) => `  ${pc.cyan(scope)} — ${SCOPE_DESCRIPTIONS[scope] ?? ""}`)
      .join("\n") + pc.dim("\n  (the last two are best-effort — skipped if your account can't grant them)"),
    "I'll create an API key named 'nano-connect' with these permissions",
  );
  const proceed = orExit(await confirm({ message: "Create this API key?" }));
  if (!proceed) {
    throw new NanoApiError("API key creation declined.");
  }

  s.start("Creating API key");
  // Try for the deploy-capable key; if the account can't grant those, fall back to read-only.
  try {
    const created = await client.createApiKey(accessToken, "nano-connect", [
      ...REQUIRED_SCOPES,
      ...ELEVATED_SCOPES,
    ]);
    s.stop(pc.green(`Created API key ${pc.dim(created.key_prefix + "…")}`));
    log.info(`Stored key ${pc.dim(maskSecret(created.key))} in your local profile.`);
    return created.key;
  } catch (err) {
    if (err instanceof NanoApiError && err.status === 403) {
      try {
        const created = await client.createApiKey(accessToken, "nano-connect", [...REQUIRED_SCOPES]);
        s.stop(pc.green(`Created API key ${pc.dim(created.key_prefix + "…")}`));
        log.info(
          `Stored a read-only key ${pc.dim(maskSecret(created.key))} (your account can't grant parser-deploy permissions, so the CLI will point you to the platform for that).`,
        );
        return created.key;
      } catch {
        // fall through to the error below
      }
    }
    s.stop(pc.red("Could not create API key"));
    if (err instanceof NanoApiError && err.status === 403) {
      log.error(
        "Your account is missing one of the required permissions, so it can't grant them to a key. Ask an admin, or paste a key that already has them.",
      );
    }
    throw err;
  }
}

/** Send a synthetic event and confirm it becomes searchable — the end-to-end smoke test. */
async function runConnectivityCheck(
  client: NanoClient,
  ingestEndpoint: string,
  ingestToken: string,
  opts: ConnectOptions,
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
    ({ marker } = await sendTestEvent(ingestEndpoint, ingestToken, TEST_SOURCE_TYPE));
    s.stop(pc.green("Test event accepted by the ingest endpoint"));
  } catch (err) {
    s.stop(pc.red("Ingest failed"));
    throw err;
  }

  // Best-effort: see if it becomes searchable. A throwaway source_type has no parser, so on
  // OCSF-normalized deployments it won't be — that's expected, not a failure. Real searchability
  // is confirmed per-source once a collector (with a matching parser) is wired up.
  s.start("Checking whether it's already searchable");
  const result = await verifyMarker(client, TEST_SOURCE_TYPE, marker, { timeoutMs: 12_000 });
  if (result.arrived) {
    s.stop(pc.green(`Searchable already (${result.count} match) — ingest + parse + query all work`));
  } else {
    s.stop(pc.green("Ingest path confirmed"));
    log.info(
      `Your event reached ingestion (token + endpoint are correct). It's not searchable yet because ${pc.cyan(
        TEST_SOURCE_TYPE,
      )} has no parser — that's expected. Setting up a collector for a real source normalizes it, and I'll verify searchability then.`,
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
