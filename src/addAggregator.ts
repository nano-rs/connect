import { intro, log, multiselect, note, outro, spinner } from "@clack/prompts";
import pc from "picocolors";
import {
  buildAggregatorCompose,
  buildAggregatorReadme,
  buildAggregatorToml,
  type AggregatorPlan,
} from "./core/aggregator.js";
import { writeArtifacts } from "./core/artifacts.js";
import { SYSLOG_CATALOG } from "./core/catalog.js";
import { resolveSavedConnection } from "./core/connection.js";
import { unauthenticatedVectorWarning, validateHost, validatePort } from "./core/target.js";
import { NanoApiError } from "./core/types.js";
import { DEFAULT_IMAGE } from "./core/vector.js";
import { maybeRunHere } from "./runHere.js";
import { orExit } from "./ui/ui.js";

export interface AddAggregatorOptions {
  url?: string;
  apiKey?: string;
  envFile?: string;
  vectorHost?: string;
  vectorPort?: string;
  agentPort?: string;
  devices?: string;
  outDir?: string;
  /** Pull the image and start the aggregator here after generating. */
  run?: boolean;
  nonInteractive?: boolean;
}

const DEFAULT_AGENT_PORT = 9000;
const DEFAULT_NANO_PORT = 6000;
const BUFFER_BYTES = 1_073_741_824; // 1 GB at the aggregator

export async function runAddAggregator(opts: AddAggregatorOptions): Promise<void> {
  if (!process.stdin.isTTY) opts = { ...opts, nonInteractive: true };
  const conn = resolveSavedConnection(opts);

  intro(pc.inverse(" nano connect · add aggregator "));

  // Syslog devices the aggregator should also listen for (optional).
  let selectedIds: string[] = [];
  if (opts.devices !== undefined) {
    selectedIds = opts.devices.split(",").map((s) => s.trim()).filter(Boolean);
    const known = new Set(SYSLOG_CATALOG.map((d) => d.id));
    const unknown = selectedIds.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new NanoApiError(`Unknown device id(s): ${unknown.join(", ")}. Known: ${SYSLOG_CATALOG.map((d) => d.id).join(", ")}`);
    }
  } else if (!opts.nonInteractive) {
    selectedIds = orExit(
      await multiselect({
        message: "Any syslog devices to listen for here too? (optional — the rest ship commented-out)",
        required: false,
        options: SYSLOG_CATALOG.map((d) => ({ value: d.id, label: d.label, hint: `${d.mode} :${d.port}` })),
      }),
    ) as string[];
  }
  const syslogSelected = SYSLOG_CATALOG.filter((d) => selectedIds.includes(d.id));

  if (opts.vectorHost !== undefined) validateHost(opts.vectorHost, "--vector-host");
  const nanoHost = opts.vectorHost ?? new URL(conn.baseUrl).hostname;
  const nanoPort = validatePort(Number(opts.vectorPort ?? DEFAULT_NANO_PORT), "--vector-port");
  const agentPort = validatePort(Number(opts.agentPort ?? DEFAULT_AGENT_PORT), "--agent-port");

  const warning = unauthenticatedVectorWarning(conn.baseUrl, nanoHost, nanoPort);
  if (warning) log.warn(warning);

  const plan: AggregatorPlan = {
    agentPort,
    syslogSelected,
    nanoHost,
    nanoPort,
    bufferBytes: BUFFER_BYTES,
    image: DEFAULT_IMAGE,
  };

  const generatedAt = new Date().toISOString();
  const dir = opts.outDir ?? "./onboarding/aggregator";
  const s = spinner();
  s.start("Generating aggregator config");
  const paths = writeArtifacts(dir, {
    "vector.toml": buildAggregatorToml(plan, generatedAt),
    "docker-compose.yml": buildAggregatorCompose(plan),
    "README.md": buildAggregatorReadme(plan, generatedAt),
  });
  s.stop(pc.green(`Wrote ${paths.length} files to ${dir}`));

  await maybeRunHere({ dir, container: "nano-aggregator", run: opts.run, nonInteractive: opts.nonInteractive });

  note(
    [
      `• Point agents at ${pc.cyan(`<this-host>:${agentPort}`)} (add-agent --target <this-host>:${agentPort})`,
      `• Confirm:        ${pc.cyan("npx @nano-rs/connect verify --source windows_event")}`,
      `• (Re)start/stop: ${pc.cyan("docker compose up -d")} / ${pc.cyan("down")} in ${dir}`,
    ].join("\n"),
    "Next",
  );
  outro(pc.green("Aggregator ready."));
}
