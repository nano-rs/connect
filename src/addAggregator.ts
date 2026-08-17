import { intro, log, note, outro, spinner } from "@clack/prompts";
import pc from "picocolors";
import {
  AGENT_SOURCE_TYPES,
  AGGREGATOR_CONTAINER,
  buildAggregatorCompose,
  buildAggregatorReadme,
  buildAggregatorToml,
  type AggregatorPlan,
} from "./core/aggregator.js";
import { NanoClient } from "./core/api.js";
import { writeArtifacts } from "./core/artifacts.js";
import { resolveSavedConnection } from "./core/connection.js";
import { selectSyslogSources } from "./selectSources.js";
import { buildIngestEnvFile, MTLS_SECRET_FILES, mtlsArtifacts, resolveUplink } from "./core/uplink.js";
import { validateHost, validatePort } from "./core/target.js";
import { preflightNativeUplink } from "./preflight.js";
import { DEFAULT_IMAGE } from "./core/vector.js";
import { maybeRunHere } from "./runHere.js";
import { reviewParsers } from "./reviewParsers.js";

export interface AddAggregatorOptions {
  url?: string;
  apiKey?: string;
  envFile?: string;
  vectorHost?: string;
  vectorPort?: string;
  agentPort?: string;
  sources?: string;
  outDir?: string;
  /** native | http — how the aggregator reaches nano. */
  transport?: string;
  mtlsDir?: string;
  ingestUrl?: string;
  ingestToken?: string;
  /** Pull the image and start the aggregator here after generating. */
  run?: boolean;
  /** Auto-deploy available community parsers without prompting. */
  deployParsers?: boolean;
  nonInteractive?: boolean;
}

const DEFAULT_AGENT_PORT = 9000;
const DEFAULT_NANO_PORT = 6000;
const BUFFER_BYTES = 1_073_741_824; // 1 GB at the aggregator

export async function runAddAggregator(opts: AddAggregatorOptions): Promise<void> {
  if (!process.stdin.isTTY) opts = { ...opts, nonInteractive: true };
  const conn = resolveSavedConnection(opts);

  intro(pc.inverse(" nano connect · add aggregator "));

  // Syslog devices the aggregator should also listen for (optional). Built from the instance's
  // parser registry, so an imported source_type is selectable by name.
  const client = conn.apiKey ? new NanoClient(conn.baseUrl, { apiKey: conn.apiKey }) : undefined;
  const {
    catalog: syslogCatalog,
    selected: syslogSelected,
    ctx,
  } = await selectSyslogSources({
    sources: opts.sources,
    nonInteractive: opts.nonInteractive,
    client,
    defaultWhenNonInteractive: "none",
    promptMessage: "Any syslog devices to listen for here too? (optional — the rest ship commented-out)",
  });

  if (opts.vectorHost !== undefined) validateHost(opts.vectorHost, "--vector-host");
  const nanoHost = opts.vectorHost ?? new URL(conn.baseUrl).hostname;
  const nanoPort = validatePort(Number(opts.vectorPort ?? DEFAULT_NANO_PORT), "--vector-port");
  const agentPort = validatePort(Number(opts.agentPort ?? DEFAULT_AGENT_PORT), "--agent-port");

  const uplink = resolveUplink({
    baseUrl: conn.baseUrl,
    target: { host: nanoHost, port: nanoPort },
    opts,
    savedIngestUrl: conn.ingestUrl,
    ingestToken: opts.ingestToken ?? conn.ingestToken,
  });

  if (uplink.transport === "native") {
    log.info(
      `Transport: Vector-native + TLS → ${nanoHost}:${nanoPort}${
        uplink.tls.mtls ? ` (client certificate from ${uplink.mtlsDir})` : ""
      }.`,
    );
    await preflightNativeUplink(uplink, conn.baseUrl);
  } else {
    log.info(`Transport: HTTPS → ${uplink.ingestUrl} (authenticated with your ingest token).`);
    log.warn(
      `HTTP transport fans out per source_type. Agent types beyond ${pc.dim(
        AGENT_SOURCE_TYPES.join(", "),
      )} are DROPPED unless you add a route + sink for them in vector.toml.`,
    );
  }

  const plan: AggregatorPlan = {
    agentPort,
    syslogCatalog,
    syslogSelected,
    uplink,
    bufferBytes: BUFFER_BYTES,
    image: DEFAULT_IMAGE,
  };

  const generatedAt = new Date().toISOString();
  const dir = opts.outDir ?? "./onboarding/aggregator";
  const s = spinner();
  s.start("Generating aggregator config");
  const paths = writeArtifacts(
    dir,
    {
      "vector.toml": buildAggregatorToml(plan, generatedAt),
      "docker-compose.yml": buildAggregatorCompose(plan),
      "README.md": buildAggregatorReadme(plan, generatedAt),
      ...(uplink.transport === "http" && uplink.ingestToken
        ? { ".env": buildIngestEnvFile(uplink.ingestToken) }
        : {}),
      ...mtlsArtifacts(uplink),
    },
    { secretFiles: [".env", ...MTLS_SECRET_FILES] },
  );
  s.stop(pc.green(`Wrote ${paths.length} files to ${dir}`));

  if (client && syslogSelected.length > 0) {
    await reviewParsers(client, syslogSelected.map((d) => d.sourceType), {
      deployParsers: opts.deployParsers,
      nonInteractive: opts.nonInteractive,
      ctx,
    });
  }

  const outcome = await maybeRunHere({ dir, container: AGGREGATOR_CONTAINER, run: opts.run, nonInteractive: opts.nonInteractive });

  note(
    [
      `• Point agents at ${pc.cyan(`<this-host>:${agentPort}`)} (add-agent --target <this-host>:${agentPort})`,
      `• Confirm:        ${pc.cyan("npx @nano-rs/connect verify --source windows_event")}`,
      `• (Re)start/stop: ${pc.cyan("docker compose up -d")} / ${pc.cyan("down")} in ${dir}`,
    ].join("\n"),
    "Next",
  );
  if (outcome === "start-failed") {
    outro(pc.yellow("Config written, but the aggregator didn't start — see the compose error above."));
  } else {
    outro(pc.green("Aggregator ready."));
  }
}
