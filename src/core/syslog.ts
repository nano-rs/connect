import type { DeviceType } from "./catalog.js";
import { SYSLOG_CATALOG } from "./catalog.js";
import { composeUplinkLines, type NanoUplink } from "./uplink.js";
import { commentOut, httpSinks, metricsSection, VECTOR_DATA_DIR, vectorSink } from "./vector.js";

/** Container name for the syslog collector — shared by the compose file and the deploy step. */
export const COLLECTOR_CONTAINER = "nano-collector";

export interface SyslogPlan {
  /** Devices the operator chose to enable now (rendered active). */
  selected: DeviceType[];
  /** How this collector reaches nano (native+TLS or HTTP). */
  uplink: NanoUplink;
  /** Disk buffer size in bytes for the sink. */
  bufferBytes: number;
  /** Container image for the docker-compose artifact. */
  image: string;
}

/** Human-readable description of where a plan ships, for headers and READMEs. */
export function uplinkLabel(u: NanoUplink): string {
  return u.transport === "native"
    ? `${u.target.host}:${u.target.port} (Vector-native, TLS)`
    : `${u.ingestUrl} (HTTPS)`;
}

/** One device's source + source_type-stamping transform. */
function deviceBlock(d: DeviceType): string {
  return `[sources.${d.id}]
# A raw socket, NOT Vector's \`syslog\` source, on purpose. nano's parsers are written against the
# syslog WIRE format: cisco_asa matches "<ts> <host> %ASA-<sev>-<id>: ..." and strips the <PRI>
# itself. Vector's syslog source pre-parses that envelope and hands on only the message body, so
# the "%ASA-…" tag the parser keys on is gone before it ever arrives and every event lands with
# "Could not parse ASA message ID pattern". Reading raw bytes keeps the line intact.
type = "socket"
mode = "${d.mode}"
address = "0.0.0.0:${d.port}"

[sources.${d.id}.decoding]
codec = "bytes"

[transforms.${d.id}_tag]
type = "remap"
inputs = ["${d.id}"]
source = '''
# Stamp nano's source_type; .message stays exactly as it arrived on the wire.
.source_type = "${d.sourceType}"
.src_host = to_string(.host) ?? ""
'''`;
}

/**
 * Render the syslog device catalog: selected devices active, the rest commented-out for later.
 * Shared by the standalone syslog collector and the aggregator (which also listens for syslog).
 */
export function renderSyslogDevices(selected: DeviceType[]): { active: string; commented: string } {
  const selectedIds = new Set(selected.map((d) => d.id));
  const active = SYSLOG_CATALOG.filter((d) => selectedIds.has(d.id))
    .map((d) => `# --- ${d.label} (${d.mode} :${d.port}) ---\n${deviceBlock(d)}`)
    .join("\n\n");
  const commented = SYSLOG_CATALOG.filter((d) => !selectedIds.has(d.id))
    .map((d) => {
      const header = `# --- ${d.label} (${d.mode} :${d.port}) — uncomment to enable ---`;
      const note = d.note ? `# note: ${d.note}\n` : "";
      return `${header}\n${note}${commentOut(deviceBlock(d))}`;
    })
    .join("\n\n");
  return { active, commented };
}

export function buildVectorToml(plan: SyslogPlan, generatedAt: string): string {
  const { active, commented } = renderSyslogDevices(plan.selected);

  // A sink whose input glob matches nothing fails to load, so when no device is enabled we ship
  // the sink commented-out (the metrics chain keeps the file valid) with instructions.
  const sink =
    plan.uplink.transport === "native"
      ? vectorSink({
          name: "nano",
          inputs: ["*_tag"],
          target: plan.uplink.target,
          acknowledgements: false,
          bufferBytes: plan.bufferBytes,
          tls: plan.uplink.tls,
        })
      : httpSinks(
          plan.selected.map((d) => ({ sourceType: d.sourceType, inputs: [`${d.id}_tag`] })),
          plan.uplink.ingestUrl,
          plan.bufferBytes,
        );
  const sinkSection =
    plan.selected.length > 0
      ? sink
      : `# No device enabled yet — uncomment one above, then add a sink for it to start forwarding.\n${commentOut(
          vectorSink({
            name: "nano",
            inputs: ["*_tag"],
            target: plan.uplink.target,
            acknowledgements: false,
            bufferBytes: plan.bufferBytes,
            tls: plan.uplink.tls,
          }),
        )}`;

  const transportNotes =
    plan.uplink.transport === "native"
      ? `# Transport: Vector-native (protobuf + disk buffering) to ${plan.uplink.target.host}:${plan.uplink.target.port}, over TLS.
#
# To enable more device types: uncomment its block below. The sink input glob "*_tag" picks it
# up automatically — no need to edit the sink.`
      : `# Transport: HTTPS to ${plan.uplink.ingestUrl}, authenticated with the ingest token
# (read from \${VECTOR_AUTH_TOKEN} — see the .env beside this file).
#
# IMPORTANT: nano routes on the X-Source-Type REQUEST HEADER, and Vector's http sink headers are
# per-sink and static. So each device type needs ITS OWN sink. When you uncomment a device block
# below, copy one of the [sinks.nano_*] blocks, point its inputs at that device's "_tag"
# transform, and set X-Source-Type to its source_type — otherwise it lands as "unknown".`;

  return `# Vector edge collector for nano — generated by @nano-rs/connect on ${generatedAt}
#
# Collects syslog from your devices and forwards to nano.
${transportNotes}
#
# To add a vendor that isn't listed, copy a block and change the id, port, mode, and source_type.

data_dir = "${VECTOR_DATA_DIR}"

# =============================================================================
# Enabled listeners
# =============================================================================
${active || "# (none selected — uncomment a device below to start collecting)"}

# =============================================================================
# More device types — uncomment what you need (each gets its own port)
# =============================================================================
${commented}

# =============================================================================
# Sink: forward everything tagged above to nano — ${uplinkLabel(plan.uplink)}.
# Acks are off because syslog (UDP) can't honor them; the disk buffer provides durability
# across restarts.
# =============================================================================
${sinkSection}

# =============================================================================
# Local metrics (http://localhost:9598/metrics) — handy to confirm events flow
# =============================================================================
${metricsSection()}
`;
}

export function buildDockerCompose(plan: SyslogPlan): string {
  const selectedIds = new Set(plan.selected.map((d) => d.id));
  // List every catalog port; comment the ones not enabled so uncommenting stays symmetric with
  // vector.toml (enable a device there -> uncomment its port here -> re-run).
  const ports = SYSLOG_CATALOG.map((d) => {
    const line = `"${d.port}:${d.port}/${d.mode}"`;
    return selectedIds.has(d.id)
      ? `      - ${line}`
      : `      # - ${line}   # ${d.id}`;
  }).join("\n");
  // With no device enabled every entry above is a comment, which YAML reads as `ports: null`
  // and compose rejects ("ports must be a list") — so the key itself ships commented out.
  const portsKey =
    plan.selected.length > 0
      ? "    ports:"
      : "    # ports:   # ← uncomment this line together with a device port below";

  const { env, volumes } = composeUplinkLines(plan.uplink);

  return `# Run the nano edge collector as a container.
#   docker compose up -d
# Edit vector.toml to enable more device types, then uncomment their ports below and re-run.
services:
  nano-collector:
    image: ${plan.image}
    container_name: ${COLLECTOR_CONTAINER}
    restart: unless-stopped
    command: ["--config", "/etc/vector/vector.toml"]
${env}    volumes:
      - ./vector.toml:/etc/vector/vector.toml:ro
${volumes}      - nano-collector-data:${VECTOR_DATA_DIR}
${portsKey}
${ports}
      # metrics (9598) stay internal for the healthcheck; uncomment to scrape from the host:
      # - "9598:9598"
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:9598/metrics"]
      interval: 15s
      timeout: 5s
      retries: 3

volumes:
  nano-collector-data:
`;
}

export function buildSystemdUnit(hasMtls = false): string {
  const tlsStep = hasMtls
    ? "#   sudo mkdir -p /etc/vector/tls && sudo cp tls/* /etc/vector/tls/ && sudo chmod 600 /etc/vector/tls/client.key\n"
    : "";
  return `# Install (bare-metal Vector, not Docker):
#   sudo mkdir -p /etc/nano-collector && sudo cp vector.toml /etc/nano-collector/vector.toml
${tlsStep}#   (vector.toml reads certificates from /etc/vector/tls — the same path docker-compose mounts)
#   sudo cp nano-collector.service /etc/systemd/system/
#   sudo systemctl daemon-reload && sudo systemctl enable --now nano-collector
# Requires Vector installed: https://vector.dev/docs/setup/installation/
[Unit]
Description=nano edge collector (Vector)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/vector --config /etc/nano-collector/vector.toml
Restart=on-failure
RestartSec=5
# Lets Vector bind the unprivileged 55xx syslog ports without running as root.
DynamicUser=true
StateDirectory=vector

[Install]
WantedBy=multi-user.target
`;
}

export function buildReadme(plan: SyslogPlan, generatedAt: string): string {
  const rows = plan.selected
    .map((d) => `| ${d.label} | \`${d.sourceType}\` | **${d.port}/${d.mode}** |`)
    .join("\n");

  const transportDoc =
    plan.uplink.transport === "native"
      ? `Forwards to nano at \`${plan.uplink.target.host}:${plan.uplink.target.port}\` over the
Vector-native protocol, **wrapped in TLS**. nano's listener terminates TLS, so a plaintext sink
fails the handshake and silently buffers to disk — the generated \`[sinks.nano.tls]\` block is
what makes this work.${
          plan.uplink.tls.mtls
            ? `\n\nThis config also presents a client certificate from your deployment's mTLS bundle.`
            : ""
        }`
      : `Forwards to nano at \`${plan.uplink.ingestUrl}\` over HTTPS, authenticated with your ingest
token. The token lives in \`.env\` (mode 0600) beside this file — **not** in \`vector.toml\` — and is
read as \`\${VECTOR_AUTH_TOKEN}\`.

> nano routes on the \`X-Source-Type\` request header, so each device type has its **own** sink.
> Adding a device means adding a matching \`[sinks.nano_<source_type>]\` block.`;

  return `# nano edge collector — syslog

Generated by \`@nano-rs/connect\` on ${generatedAt}.

${transportDoc}

## 1. Run the collector

**Docker (simplest):**
\`\`\`bash
docker compose up -d
docker compose logs -f nano-collector
\`\`\`

**systemd (bare metal):** see the header of \`nano-collector.service\`.

## 2. Point your devices at it

Send each device's syslog to **this machine's IP** on its assigned port:

| Device | source_type | Send syslog to |
| --- | --- | --- |
${rows || "| _(none enabled yet)_ | | |"}

Replace "this machine's IP" with the collector host's address reachable from your devices.

## 3. Enable more device types

Uncomment the device's block in \`vector.toml\` (the sink picks it up automatically), then
uncomment its port in \`docker-compose.yml\` — including the \`ports:\` key itself if it's still
commented out — and re-run \`docker compose up -d\`.

## 4. Confirm data is arriving

\`\`\`bash
npx @nano-rs/connect verify --source <source_type>
\`\`\`

Events become fully searchable once nano has a parser for that source_type; until then they're
ingested but parse generically.
`;
}
