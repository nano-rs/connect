/** Shared Vector config primitives reused across collector/agent/aggregator generators. */

import { tokenEnvVar } from "./ingestTokens.js";

/** Pinned stable Vector (0.55.0 first shipped windows_event_log in stable; 0.56.0 is current). */
export const VECTOR_VERSION = "0.56.0";
export const DEFAULT_IMAGE = `timberio/vector:${VECTOR_VERSION}-alpine`;
export const VECTOR_DATA_DIR = "/var/lib/vector";
/** Vector rejects disk buffers below this (just over 256 MiB). */
export const MIN_DISK_BUFFER_BYTES = 268_435_488;

export interface Target {
  host: string;
  port: number;
}

/** Bracket a bare IPv6 host so `host:port` stays unambiguous in a Vector address. */
export function formatAddress(host: string, port: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${h}:${port}`;
}

/** Prefix every line with "# " so a whole block can be shipped commented-out. */
export function commentOut(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length ? `# ${line}` : "#"))
    .join("\n");
}

/** How a collector reaches nano. */
export type Transport = "native" | "http";

/** Optional client-certificate material for the native uplink (mTLS deployments). */
export interface MtlsPaths {
  /**
   * Trust anchor for verifying the SERVER's certificate. Normally unset: nano's listeners
   * present a publicly-trusted cert, so the system store is correct. Only set this for a
   * deployment fronted by a private CA — pointing it at the mTLS bundle's ca.crt breaks the
   * handshake, because that CA signs CLIENTS, not the server.
   */
  caFile?: string;
  /** Client certificate + key, when the listener requires mTLS. */
  crtFile?: string;
  keyFile?: string;
}

/**
 * TLS settings for the native uplink.
 *
 * `enabled` is NOT optional at the call site by design: every uplink that leaves the host must
 * make an explicit choice. nano's managed listeners terminate TLS on :6000, so a plaintext
 * `vector` sink there dies with "connection error: broken pipe" and silently buffers to disk.
 */
export interface SinkTls {
  enabled: boolean;
  mtls?: MtlsPaths;
}

function tlsSection(sinkName: string, tls: SinkTls): string {
  if (!tls.enabled) return "";
  const lines = [
    `[sinks.${sinkName}.tls]`,
    "enabled = true",
    "verify_certificate = true",
    "verify_hostname = true",
  ];
  // Only emitted when the operator supplied a bundle — nano's managed compose listeners present
  // a public (Let's Encrypt) cert and do not request a client cert, so these stay absent there.
  if (tls.mtls?.caFile) lines.push(`ca_file = "${tls.mtls.caFile}"`);
  if (tls.mtls?.crtFile) lines.push(`crt_file = "${tls.mtls.crtFile}"`);
  if (tls.mtls?.keyFile) lines.push(`key_file = "${tls.mtls.keyFile}"`);
  return `\n\n${lines.join("\n")}`;
}

export interface VectorSinkOpts {
  name: string;
  inputs: string[];
  target: Target;
  /** Only enable when EVERY input source supports acknowledgements (syslog/UDP does not). */
  acknowledgements: boolean;
  bufferBytes: number;
  /** TLS for this hop. Uplinks to nano must set `enabled: true`; local agent→aggregator hops don't. */
  tls: SinkTls;
}

/** The Vector-native sink block (protobuf + disk buffer), shared by agents and aggregators. */
export function vectorSink(o: VectorSinkOpts): string {
  const inputs = o.inputs.map((i) => `"${i}"`).join(", ");
  const maxSize = Math.max(o.bufferBytes, MIN_DISK_BUFFER_BYTES);
  return `[sinks.${o.name}]
type = "vector"
inputs = [${inputs}]
address = "${formatAddress(o.target.host, o.target.port)}"
acknowledgements.enabled = ${o.acknowledgements}${tlsSection(o.name, o.tls)}

[sinks.${o.name}.buffer]
type = "disk"
max_size = ${maxSize}
when_full = "block"`;
}

/** One HTTP sink: a source_type and the transform ids that feed it. */
export interface HttpSinkSpec {
  sourceType: string;
  inputs: string[];
  /**
   * Why this sink ships commented out (no log source / token for it yet). Its events are dropped
   * at the route rather than sent with a token that would land them in the wrong source.
   */
  skipped?: string;
}

/**
 * The shared install token's env var. Only an older nano (before per-source tokens, NAN-3806)
 * routes with it; generated configs read one `NANO_TOKEN_<SOURCE_TYPE>` per sink instead.
 */
export const INGEST_TOKEN_ENV = "VECTOR_AUTH_TOKEN";

/**
 * HTTP sinks for nano's `/ingest/` endpoint — one per source_type, deliberately.
 *
 * nano decides where an event lands from the sink's TOKEN: every ingest token is bound to exactly
 * one log source (NAN-3806), so each source_type gets its own sink authenticating with its own
 * token, read from `${NANO_TOKEN_<SOURCE_TYPE>}` at load time so it never lands in the config.
 * The `X-Source-Type` header is still sent: a current nano ignores it for routing (it keeps a
 * differing value as `claimed_source_type`), and an older nano routes on it.
 */
export function httpSinks(specs: HttpSinkSpec[], ingestUrl: string, bufferBytes: number): string {
  const maxSize = Math.max(bufferBytes, MIN_DISK_BUFFER_BYTES);
  return specs
    .map((s) => {
      const name = `nano_${s.sourceType}`;
      const inputs = s.inputs.map((i) => `"${i}"`).join(", ");
      const block = `[sinks.${name}]
type = "http"
inputs = [${inputs}]
uri = "${ingestUrl}"
method = "post"

# codec = "text" sends the .message field as a raw line — NOT "json", which would send the whole
# Vector event as a JSON object. nano's HTTP ingest decodes the request body as bytes, so whatever
# is on the wire becomes .message verbatim; a JSON envelope therefore lands as .message and every
# parser that regexes a raw log line fails. One line per event.
[sinks.${name}.encoding]
codec = "text"

[sinks.${name}.framing]
method = "newline_delimited"

# This token is bound to the nano log source for ${s.sourceType}: it alone decides where these
# events land. One token per sink — never reuse it for another source_type.
[sinks.${name}.auth]
strategy = "bearer"
token = "\${${tokenEnvVar(s.sourceType)}}"

# X-Source-Type is informational on a current nano (the token decides; a differing value is kept
# as claimed_source_type) and the routing key on an older one. Content-Type must say text/plain
# so nano treats the body as a raw log line rather than trying to unwrap it as JSON.
[sinks.${name}.request.headers]
X-Source-Type = "${s.sourceType}"
Content-Type = "text/plain"

[sinks.${name}.buffer]
type = "disk"
max_size = ${maxSize}
when_full = "block"`;
      if (!s.skipped) return block;
      return `# --- ${s.sourceType}: not forwarded yet — ${s.skipped}
# Re-run connect once it has a log source (or set ${tokenEnvVar(s.sourceType)} in .env to a token
# bound to it), then uncomment this sink.
${commentOut(block)}`;
    })
    .join("\n\n");
}

/** Local Prometheus metrics endpoint — handy to confirm a collector is alive and moving events. */
export function metricsSection(): string {
  return `[sources.internal_metrics]
type = "internal_metrics"

[sinks.metrics]
type = "prometheus_exporter"
inputs = ["internal_metrics"]
address = "0.0.0.0:9598"`;
}
