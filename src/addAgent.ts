import { confirm, intro, log, note, outro, select, spinner, text } from "@clack/prompts";
import pc from "picocolors";
import {
  agentDestination,
  buildLinuxAgentSystemd,
  buildLinuxAgentToml,
  buildWindowsAgentToml,
  buildWindowsInstaller,
  DEFAULT_WINDOWS_CHANNELS,
  type LinuxFileGroup,
} from "./core/agent.js";
import { NanoClient } from "./core/api.js";
import { writeArtifacts } from "./core/artifacts.js";
import { resolveSavedConnection } from "./core/connection.js";
import { buildIngestEnvFile, MTLS_SECRET_FILES, mtlsArtifacts, type NanoUplink, resolveUplink } from "./core/uplink.js";
import { ID_RE, parseHostPort } from "./core/target.js";
import { NanoApiError } from "./core/types.js";
import { DEFAULT_IMAGE, type Target } from "./core/vector.js";

/** Short transport description for the generated READMEs. */
function transportDoc(uplink: NanoUplink): string {
  if (uplink.transport === "http") return "HTTPS + ingest token";
  return uplink.tls.enabled
    ? `Vector-native, TLS${uplink.tls.mtls ? " + client certificate" : ""}`
    : "Vector-native, on your network";
}
import { preflightNativeUplink } from "./preflight.js";
import { reviewParsers } from "./reviewParsers.js";
import { orExit } from "./ui/ui.js";

export interface AddAgentOptions {
  url?: string;
  apiKey?: string;
  envFile?: string;
  os?: string;
  /** host or host:port of where the agent ships (an aggregator, usually). */
  target?: string;
  /** Ship straight to nano instead of an aggregator. */
  toNano?: boolean;
  journald?: boolean;
  outDir?: string;
  /** native | http — only meaningful when shipping straight to nano. */
  transport?: string;
  mtlsDir?: string;
  ingestUrl?: string;
  ingestToken?: string;
  /** Auto-deploy available community parsers without prompting. */
  deployParsers?: boolean;
  nonInteractive?: boolean;
}

const DEFAULT_AGGREGATOR_PORT = 9000;
const NANO_VECTOR_PORT = 6000;
const BUFFER_BYTES = 536_870_912; // 512 MB (Vector's disk buffer minimum is just over 256 MiB)

export async function runAddAgent(opts: AddAgentOptions): Promise<void> {
  if (!process.stdin.isTTY) opts = { ...opts, nonInteractive: true };
  const conn = resolveSavedConnection(opts);

  intro(pc.inverse(" nano connect · add endpoint agent "));

  // OS
  let os = opts.os;
  if (!os && !opts.nonInteractive) {
    os = orExit(
      await select({
        message: "What kind of endpoint?",
        options: [
          { value: "windows", label: "Windows (Event Log + Sysmon)" },
          { value: "linux", label: "Linux (journald / log files)" },
        ],
      }),
    ) as string;
  }
  if (os !== "windows" && os !== "linux") {
    throw new NanoApiError("Pass --os windows|linux.");
  }

  // Where it ships (aggregator by default; nano directly if asked).
  const uplink = await resolveAgentUplink(conn, opts);
  if (uplink.transport === "native") {
    log.info(
      uplink.tls.enabled
        ? `Transport: Vector-native + TLS → ${uplink.target.host}:${uplink.target.port}${
            uplink.tls.mtls ? ` (client certificate from ${uplink.mtlsDir})` : ""
          }.`
        : `Transport: Vector-native → ${uplink.target.host}:${uplink.target.port} (your aggregator; the nano uplink is secured on the aggregator itself).`,
    );
    await preflightNativeUplink(uplink, conn.baseUrl);
  } else {
    log.info(`Transport: HTTPS → ${uplink.ingestUrl} (authenticated with your ingest token).`);
  }

  const generatedAt = new Date().toISOString();
  const dir = opts.outDir ?? `./onboarding/agent-${os}`;
  const s = spinner();
  s.start("Generating agent config");

  let paths: string[];
  let sourceTypes: string[] = [];
  if (os === "windows") {
    paths = writeArtifacts(
      dir,
      {
        "vector.toml": buildWindowsAgentToml(
          { uplink, channels: DEFAULT_WINDOWS_CHANNELS, bufferBytes: BUFFER_BYTES },
          generatedAt,
        ),
        "install-agent.ps1": buildWindowsInstaller(),
        "README.md": windowsReadme(uplink, generatedAt),
        ...(uplink.transport === "http" && uplink.ingestToken
          ? { ".env": buildIngestEnvFile(uplink.ingestToken) }
          : {}),
        ...mtlsArtifacts(uplink),
      },
      { secretFiles: [".env", ...MTLS_SECRET_FILES] },
    );
    sourceTypes = ["windows_event", "windows_sysmon"];
    s.stop(pc.green(`Wrote ${paths.length} files to ${dir}`));
    note(
      [
        `1. Copy ${pc.cyan(dir)} to the Windows endpoint`,
        `2. In an elevated PowerShell: ${pc.cyan("powershell -ExecutionPolicy Bypass -File .\\install-agent.ps1")}`,
        `3. Confirm: ${pc.cyan("npx @nano-rs/connect verify --source windows_event")}`,
      ].join("\n"),
      "Next",
    );
  } else {
    const files = await resolveLinuxFiles(opts);
    const journald = opts.journald ?? true;
    if (!journald && files.length === 0) {
      throw new NanoApiError("Nothing to collect: enable journald or add a file group.");
    }
    paths = writeArtifacts(
      dir,
      {
        "vector.toml": buildLinuxAgentToml({ uplink, journald, files, bufferBytes: BUFFER_BYTES, image: DEFAULT_IMAGE }, generatedAt),
        "nano-agent.service": buildLinuxAgentSystemd(Boolean(uplink.tls.mtls)),
        "README.md": linuxReadme(uplink, journald, files, generatedAt),
        ...(uplink.transport === "http" && uplink.ingestToken
          ? { ".env": buildIngestEnvFile(uplink.ingestToken) }
          : {}),
        ...mtlsArtifacts(uplink),
      },
      { secretFiles: [".env", ...MTLS_SECRET_FILES] },
    );
    sourceTypes = [
      ...(journald ? ["linux_journald", "linux_sysmon"] : []),
      ...files.map((f) => f.sourceType),
    ];
    s.stop(pc.green(`Wrote ${paths.length} files to ${dir}`));
    note(
      [
        `1. Copy ${pc.cyan(dir)} to the Linux endpoint`,
        `2. Install via the header of ${pc.cyan("nano-agent.service")} (runs as root for /var/log + journald)`,
        `3. Confirm: ${pc.cyan("npx @nano-rs/connect verify --source linux_journald")}`,
      ].join("\n"),
      "Next",
    );
  }

  if (conn.apiKey) {
    const client = new NanoClient(conn.baseUrl, { apiKey: conn.apiKey });
    await reviewParsers(client, sourceTypes, {
      deployParsers: opts.deployParsers,
      nonInteractive: opts.nonInteractive,
    });
  }

  outro(pc.green("Agent config ready."));
}

/**
 * Where the agent ships. Two distinct hops with different security properties:
 *   • to an aggregator — YOUR infrastructure, on your network. Plain Vector-native; the
 *     generated aggregator's `[sources.agents]` doesn't terminate TLS, so enabling it here
 *     would just fail the handshake.
 *   • to nano — leaves your network. Always TLS on native, or HTTPS + token on http.
 */
async function resolveAgentUplink(
  conn: { baseUrl: string; ingestToken?: string; ingestUrl?: string },
  opts: AddAgentOptions,
): Promise<NanoUplink> {
  const nanoHost = new URL(conn.baseUrl).hostname;
  const toNano = (): NanoUplink =>
    resolveUplink({
      baseUrl: conn.baseUrl,
      target: { host: nanoHost, port: NANO_VECTOR_PORT },
      opts,
      savedIngestUrl: conn.ingestUrl,
      ingestToken: opts.ingestToken ?? conn.ingestToken,
    });
  const toAggregator = (target: Target): NanoUplink => {
    if (opts.transport === "http") {
      throw new NanoApiError(
        "--transport http applies to the nano uplink, not the agent→aggregator hop. Use --to-nano " +
          "with --transport http, or set --transport http on the aggregator instead.",
      );
    }
    return { transport: "native", target, ingestUrl: "", tls: { enabled: false } };
  };

  if (opts.toNano) return toNano();
  if (opts.target) return toAggregator(parseHostPort(opts.target, DEFAULT_AGGREGATOR_PORT));
  if (opts.nonInteractive) {
    throw new NanoApiError("Pass --target <aggregator-host[:port]> or --to-nano.");
  }
  const where = orExit(
    await select({
      message: "Where should this agent ship its logs?",
      options: [
        { value: "agg", label: "To my aggregator (recommended)", hint: "fan endpoints into a pool" },
        { value: "nano", label: "Straight to nano", hint: "small / no aggregator tier" },
      ],
    }),
  ) as string;
  if (where === "nano") return toNano();
  const hp = orExit(
    await text({
      message: "Aggregator address (host or host:port)",
      placeholder: `aggregator.internal:${DEFAULT_AGGREGATOR_PORT}`,
      validate: (v) => (v.trim() ? undefined : "Required."),
    }),
  );
  return toAggregator(parseHostPort(hp, DEFAULT_AGGREGATOR_PORT));
}

async function resolveLinuxFiles(opts: AddAgentOptions): Promise<LinuxFileGroup[]> {
  if (opts.nonInteractive) return [];
  const add = orExit(
    await confirm({ message: "Also tail specific log files (besides journald)?", initialValue: false }),
  );
  if (!add) return [];
  const sourceType = orExit(
    await text({
      message: "source_type for these files",
      placeholder: "linux_auth",
      // It becomes a TOML section name and a VRL string, so constrain it.
      validate: (v) => (ID_RE.test(v.trim()) ? undefined : "Use letters, numbers, and underscores only."),
    }),
  ).trim();
  const paths = orExit(
    await text({ message: "File paths/globs (comma-separated)", placeholder: "/var/log/auth.log,/var/log/secure", validate: (v) => (v.trim() ? undefined : "Required.") }),
  );
  return [{ id: sourceType, paths: paths.split(",").map((p) => p.trim()).filter(Boolean), sourceType }];
}

function windowsReadme(uplink: NanoUplink, generatedAt: string): string {
  return `# nano Windows endpoint agent

Generated ${generatedAt}. Ships to \`${agentDestination(uplink)}\` (${transportDoc(uplink)}).

1. Copy this folder to the Windows endpoint.
2. Elevated PowerShell: \`powershell -ExecutionPolicy Bypass -File .\\install-agent.ps1\`
   (downloads Vector, installs it as a service, applies vector.toml).
3. Verify from anywhere: \`npx @nano-rs/connect verify --source windows_event\` (and \`windows_sysmon\`).

Collects: Application, System, Security, Sysmon, PowerShell, Defender. Edit \`channels\` in
vector.toml to change. Sysmon events are tagged \`windows_sysmon\`; everything else \`windows_event\`.

The installer verifies the MSI's Authenticode signature before installing, and configures the
service to auto-restart on failure (a safety net for the known windows_event_log freeze-on-idle
bug, vectordotdev/vector#25194).
`;
}

function linuxReadme(uplink: NanoUplink, journald: boolean, files: LinuxFileGroup[], generatedAt: string): string {
  const collecting = [journald ? "journald (`linux_journald`)" : null, ...files.map((f) => `\`${f.sourceType}\` (${f.paths.join(", ")})`)]
    .filter(Boolean)
    .join(", ");
  return `# nano Linux endpoint agent

Generated ${generatedAt}. Ships to \`${agentDestination(uplink)}\` (${transportDoc(uplink)}).
Collecting: ${collecting}.

1. Copy this folder to the Linux endpoint.
2. Install per the header of \`nano-agent.service\` (runs as root to read /var/log + journald).
3. Verify: \`npx @nano-rs/connect verify --source linux_journald\`.

If [Sysmon for Linux](https://github.com/microsoft/SysmonForLinux) is installed, its events are
auto-tagged \`linux_sysmon\` (split out from journald by identifier) — verify with
\`npx @nano-rs/connect verify --source linux_sysmon\`.
`;
}
