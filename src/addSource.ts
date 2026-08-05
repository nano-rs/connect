import { intro, log, multiselect, note, outro, spinner, text } from "@clack/prompts";
import pc from "picocolors";
import { NanoClient } from "./core/api.js";
import { writeArtifacts } from "./core/artifacts.js";
import { SYSLOG_CATALOG } from "./core/catalog.js";
import { resolveSavedConnection } from "./core/connection.js";
import { buildIngestEnvFile, MTLS_SECRET_FILES, mtlsArtifacts, resolveUplink } from "./core/uplink.js";
import { unauthenticatedVectorWarning, validateHost, validatePort } from "./core/target.js";
import {
  buildDockerCompose,
  buildReadme,
  buildSystemdUnit,
  buildVectorToml,
  COLLECTOR_CONTAINER,
  type SyslogPlan,
} from "./core/syslog.js";
import { NanoApiError } from "./core/types.js";
import { DEFAULT_IMAGE } from "./core/vector.js";
import { maybeRunHere, type RunHereOutcome } from "./runHere.js";
import { reviewParsers } from "./reviewParsers.js";
import { orExit } from "./ui/ui.js";

export interface AddSourceOptions {
  url?: string;
  apiKey?: string;
  searchUrl?: string;
  envFile?: string;
  vectorHost?: string;
  vectorPort?: string;
  outDir?: string;
  /** native | http — how this collector reaches nano. */
  transport?: string;
  /** Directory with ca.crt/client.crt/client.key from the deployment's mTLS bundle. */
  mtlsDir?: string;
  /** Override the ingest endpoint for --transport http. */
  ingestUrl?: string;
  /** Ingest token for --transport http (otherwise from the saved connection). */
  ingestToken?: string;
  /** Comma-separated source_types to collect (lets non-interactive runs be precise). */
  sources?: string;
  /** Pull the image and start the collector here after generating. */
  run?: boolean;
  /** Auto-deploy available community parsers without prompting. */
  deployParsers?: boolean;
  nonInteractive?: boolean;
}

const DEFAULT_VECTOR_PORT = 6000;
const DEFAULT_BUFFER_BYTES = 536_870_912; // 512 MB

export async function runAddSource(opts: AddSourceOptions): Promise<void> {
  if (!process.stdin.isTTY) opts = { ...opts, nonInteractive: true };

  const conn = resolveSavedConnection(opts);

  intro(pc.inverse(" nano connect · add syslog source "));

  // Which devices to enable now (the rest ship commented-out for later).
  let selectedIds: string[];
  if (opts.sources !== undefined) {
    selectedIds = opts.sources.split(",").map((s) => s.trim()).filter(Boolean);
    const known = new Set(SYSLOG_CATALOG.map((d) => d.id));
    const unknown = selectedIds.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new NanoApiError(
        `Unknown source_type(s): ${unknown.join(", ")}. Run \`connect list-sources\` to see the ${SYSLOG_CATALOG.length} built-ins.`,
      );
    }
  } else if (opts.nonInteractive) {
    selectedIds = SYSLOG_CATALOG.map((d) => d.id);
    log.warn(
      `Non-interactive with no --sources: enabling ALL ${SYSLOG_CATALOG.length} source_types and opening their ports. Pass --sources a,b to narrow.`,
    );
  } else {
    selectedIds = orExit(
      await multiselect({
        message: "Which devices will send syslog? (the rest ship commented-out to enable later)",
        required: false,
        options: SYSLOG_CATALOG.map((d) => ({
          value: d.id,
          label: d.label,
          hint: `${d.mode} :${d.port}`,
        })),
      }),
    ) as string[];
  }
  // Preserve catalog order regardless of how ids were supplied.
  const selected = SYSLOG_CATALOG.filter((d) => selectedIds.includes(d.id));

  // nano's Vector-native target. URL-derived hostname is already sanitized; a raw --vector-host
  // is interpolated into the generated TOML, so validate it can't break out of the string.
  if (opts.vectorHost !== undefined) validateHost(opts.vectorHost, "--vector-host");
  const nanoHost = opts.vectorHost ?? new URL(conn.baseUrl).hostname;
  const nanoPort = validatePort(Number(opts.vectorPort ?? DEFAULT_VECTOR_PORT), "--vector-port");

  const uplink = resolveUplink({
    baseUrl: conn.baseUrl,
    target: { host: nanoHost, port: nanoPort },
    opts,
    savedIngestUrl: conn.ingestUrl,
    ingestToken: opts.ingestToken ?? conn.ingestToken,
  });

  if (uplink.transport === "native") {
    // The native port carries no ingest token — TLS protects the data in transit, but anyone who
    // can reach the port can also write to it. Say so plainly.
    const warning = unauthenticatedVectorWarning(conn.baseUrl, nanoHost, nanoPort);
    if (warning) log.warn(warning);
    log.info(
      `Transport: Vector-native + TLS → ${nanoHost}:${nanoPort}${
        uplink.tls.mtls ? ` (client certificate from ${uplink.mtlsDir})` : ""
      }. Use ${pc.cyan("--transport http")} for a token-authenticated uplink.`,
    );
  } else {
    log.info(`Transport: HTTPS → ${uplink.ingestUrl} (authenticated with your ingest token).`);
  }

  const plan: SyslogPlan = {
    selected,
    uplink,
    bufferBytes: DEFAULT_BUFFER_BYTES,
    image: DEFAULT_IMAGE,
  };

  const generatedAt = new Date().toISOString();
  const dir = opts.outDir ?? "./onboarding/syslog";
  const s = spinner();
  s.start("Generating collector config");
  const paths = writeArtifacts(
    dir,
    {
      "vector.toml": buildVectorToml(plan, generatedAt),
      "docker-compose.yml": buildDockerCompose(plan),
      "nano-collector.service": buildSystemdUnit(Boolean(uplink.tls.mtls)),
      "README.md": buildReadme(plan, generatedAt),
      // Keeps the ingest token out of vector.toml and out of the compose file.
      ...(uplink.transport === "http" && uplink.ingestToken
        ? { ".env": buildIngestEnvFile(uplink.ingestToken) }
        : {}),
      ...mtlsArtifacts(uplink),
    },
    { secretFiles: [".env", ...MTLS_SECRET_FILES] },
  );
  s.stop(pc.green(`Wrote ${paths.length} files to ${dir}`));

  // Device-pointing table.
  if (selected.length > 0) {
    const table = selected
      .map((d) => `  ${d.label.padEnd(38)} → ${pc.cyan(`<collector-ip>:${d.port}/${d.mode}`)}  (source_type ${pc.dim(d.sourceType)})`)
      .join("\n");
    note(
      `Point each device's syslog at THIS collector's IP:\n\n${table}`,
      "Where to send logs",
    );
  } else {
    log.warn(
      `No devices enabled — every listener ships commented out. To enable one: uncomment its block in ${dir}/vector.toml AND its port (plus the \`ports:\` key) in docker-compose.yml, then \`docker compose up -d\`.`,
    );
  }

  // Tell them which source_types nano already parses / offer to deploy a community parser.
  if (conn.apiKey) {
    const client = new NanoClient(conn.baseUrl, { apiKey: conn.apiKey, searchUrl: conn.searchUrl });
    await reviewParsers(client, selected.map((d) => d.sourceType), {
      deployParsers: opts.deployParsers,
      nonInteractive: opts.nonInteractive,
    });
  }

  // Offer to pull the image and start it right here — with no listeners enabled there's nothing
  // to run yet, so skip the offer instead of starting a collector that listens on nothing.
  let outcome: RunHereOutcome = "not-started";
  if (selected.length > 0) {
    outcome = await maybeRunHere({ dir, container: COLLECTOR_CONTAINER, run: opts.run, nonInteractive: opts.nonInteractive });
  } else if (opts.run) {
    log.info("Ignoring --run — no listeners are enabled yet (see the warning above).");
  }

  const next =
    selected.length > 0
      ? [
          `• Point devices     (table above) at this machine's IP`,
          `• Confirm flow:      ${pc.cyan("npx @nano-rs/connect verify --source " + selected[0]!.sourceType)}`,
          `• (Re)start/stop:    ${pc.cyan("docker compose up -d")} / ${pc.cyan("down")} in ${dir}`,
        ]
      : [
          `• Enable a device:   uncomment it in ${dir}/vector.toml AND its port in docker-compose.yml`,
          `• Start:             ${pc.cyan("docker compose up -d")} in ${dir}`,
          `• Confirm flow:      ${pc.cyan("npx @nano-rs/connect verify --source <source_type>")}`,
        ];
  note(next.join("\n"), "Next");

  if (outcome === "start-failed") {
    outro(pc.yellow("Config written, but the collector didn't start — see the compose error above."));
  } else if (selected.length === 0) {
    outro(pc.yellow("Config written — enable a device (see Next) to start collecting."));
  } else {
    outro(pc.green("Collector ready."));
  }
}
