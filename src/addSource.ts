import { intro, log, multiselect, note, outro, spinner, text } from "@clack/prompts";
import pc from "picocolors";
import { writeArtifacts } from "./core/artifacts.js";
import { SYSLOG_CATALOG } from "./core/catalog.js";
import { resolveSavedConnection } from "./core/connection.js";
import { isInsecureRemote } from "./core/endpoints.js";
import {
  buildDockerCompose,
  buildReadme,
  buildSystemdUnit,
  buildVectorToml,
  type SyslogPlan,
} from "./core/syslog.js";
import { NanoApiError } from "./core/types.js";
import { orExit } from "./ui/ui.js";

export interface AddSourceOptions {
  url?: string;
  apiKey?: string;
  searchUrl?: string;
  envFile?: string;
  vectorHost?: string;
  vectorPort?: string;
  outDir?: string;
  nonInteractive?: boolean;
}

const DEFAULT_VECTOR_PORT = 6000;
const DEFAULT_BUFFER_BYTES = 536_870_912; // 512 MB
const DEFAULT_IMAGE = "timberio/vector:latest-alpine";

export async function runAddSource(opts: AddSourceOptions): Promise<void> {
  if (!process.stdin.isTTY) opts = { ...opts, nonInteractive: true };

  const conn = resolveSavedConnection(opts);

  intro(pc.inverse(" nano connect · add syslog source "));

  // Which devices to enable now (the rest ship commented-out for later).
  let selectedIds: string[];
  if (opts.nonInteractive) {
    selectedIds = SYSLOG_CATALOG.map((d) => d.id); // can't prompt — enable all, operator prunes
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
  const selected = SYSLOG_CATALOG.filter((d) => selectedIds.includes(d.id));

  // nano's Vector-native target.
  const nanoHost =
    opts.vectorHost ?? new URL(conn.baseUrl).hostname;
  const nanoPort = Number(opts.vectorPort ?? DEFAULT_VECTOR_PORT);
  if (!Number.isInteger(nanoPort) || nanoPort <= 0 || nanoPort > 65535) {
    throw new NanoApiError(`Invalid Vector port: ${opts.vectorPort}`);
  }

  // Vector-native (:6000) is unauthenticated in nano's config — fine on a trusted network/VPN,
  // risky across the internet. Warn when the target looks like a public/remote host.
  if (new URL(conn.baseUrl).protocol === "https:" || isInsecureRemote(conn.baseUrl)) {
    log.warn(
      `nano's Vector-native port (${nanoHost}:${nanoPort}) has no auth — only forward to it over a trusted network or VPN. If nano is remote/SaaS, that port may not be reachable; use the HTTPS path instead (coming soon) or a private link.`,
    );
  }

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
