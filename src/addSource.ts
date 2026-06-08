import { intro, log, multiselect, note, outro, spinner, text } from "@clack/prompts";
import pc from "picocolors";
import { writeArtifacts } from "./core/artifacts.js";
import { SYSLOG_CATALOG } from "./core/catalog.js";
import { resolveSavedConnection } from "./core/connection.js";
import { unauthenticatedVectorWarning, validateHost, validatePort } from "./core/target.js";
import {
  buildDockerCompose,
  buildReadme,
  buildSystemdUnit,
  buildVectorToml,
  type SyslogPlan,
} from "./core/syslog.js";
import { NanoApiError } from "./core/types.js";
import { DEFAULT_IMAGE } from "./core/vector.js";
import { orExit } from "./ui/ui.js";

export interface AddSourceOptions {
  url?: string;
  apiKey?: string;
  searchUrl?: string;
  envFile?: string;
  vectorHost?: string;
  vectorPort?: string;
  outDir?: string;
  /** Comma-separated device ids to enable (lets non-interactive runs be precise). */
  devices?: string;
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
  if (opts.devices !== undefined) {
    selectedIds = opts.devices.split(",").map((s) => s.trim()).filter(Boolean);
    const known = new Set(SYSLOG_CATALOG.map((d) => d.id));
    const unknown = selectedIds.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new NanoApiError(
        `Unknown device id(s): ${unknown.join(", ")}. Known: ${SYSLOG_CATALOG.map((d) => d.id).join(", ")}`,
      );
    }
  } else if (opts.nonInteractive) {
    selectedIds = SYSLOG_CATALOG.map((d) => d.id);
    log.warn(
      `Non-interactive with no --devices: enabling ALL ${SYSLOG_CATALOG.length} device types and opening their ports. Pass --devices a,b to narrow.`,
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

  // Vector-native (:6000) is unauthenticated in nano's config — fine on a trusted network/VPN,
  // risky across the internet. Warn when the target looks like a public/remote host.
  const warning = unauthenticatedVectorWarning(conn.baseUrl, nanoHost, nanoPort);
  if (warning) log.warn(warning);

  const plan: SyslogPlan = {
    selected,
    nanoHost,
    nanoPort,
    bufferBytes: DEFAULT_BUFFER_BYTES,
    image: DEFAULT_IMAGE,
  };

  const generatedAt = new Date().toISOString();
  const dir = opts.outDir ?? "./onboarding/syslog";
  const s = spinner();
  s.start("Generating collector config");
  const paths = writeArtifacts(dir, {
    "vector.toml": buildVectorToml(plan, generatedAt),
    "docker-compose.yml": buildDockerCompose(plan),
    "nano-collector.service": buildSystemdUnit(),
    "README.md": buildReadme(plan, generatedAt),
  });
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
    log.warn("No devices enabled — every listener is commented out. Uncomment what you need in vector.toml.");
  }

  note(
    [
      `1. Start it:        ${pc.cyan("cd " + dir + " && docker compose up -d")}`,
      `2. Point devices    (table above) at this machine's IP`,
      `3. Confirm flow:    ${pc.cyan("npx @nano-rs/connect verify --source " + (selected[0]?.sourceType ?? "<source_type>"))}`,
    ].join("\n"),
    "Next",
  );
  outro(pc.green("Collector config ready."));
}
