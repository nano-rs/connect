/** Shared Vector config primitives reused across collector/agent/aggregator generators. */

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
}

/** Env var the generated configs read the ingest token from (never inlined into vector.toml). */
export const INGEST_TOKEN_ENV = "VECTOR_AUTH_TOKEN";

/**
 * HTTP sinks for nano's `/ingest/` endpoint — one per source_type, deliberately.
 *
 * nano's managed ingest reads the routing key from the `X-Source-Type` REQUEST HEADER only; a
 * `source_type` field in the event body is ignored and the event lands as `unknown` (verified
 * against a live tenant). Vector's http sink headers are per-sink and static, so one shared sink
 * cannot carry per-event source types — hence the fan-out.
 *
 * Unlike the native uplink, this path IS authenticated: the ingest token goes out as a bearer
 * token, read from ${INGEST_TOKEN_ENV} at load time so it never lands in the config file.
 */
export function httpSinks(specs: HttpSinkSpec[], ingestUrl: string, bufferBytes: number): string {
  const maxSize = Math.max(bufferBytes, MIN_DISK_BUFFER_BYTES);
  return specs
    .map((s) => {
      const name = `nano_${s.sourceType}`;
      const inputs = s.inputs.map((i) => `"${i}"`).join(", ");
      return `[sinks.${name}]
type = "http"
inputs = [${inputs}]
uri = "${ingestUrl}"
method = "post"

# codec = "text" sends the .message field as a raw line — NOT "json", which would send the whole
# Vector event as a JSON object. nano's HTTP ingest decodes the request body as bytes, so whatever
# is on the wire becomes .message verbatim; a JSON envelope therefore lands as .message and every
# parser that regexes a raw log line fails. One line per event, source_type via the header below.
[sinks.${name}.encoding]
codec = "text"

[sinks.${name}.framing]
method = "newline_delimited"

[sinks.${name}.auth]
strategy = "bearer"
token = "\${${INGEST_TOKEN_ENV}}"

# nano routes on X-Source-Type — NOT on any source_type field in the body. Content-Type must say
# text/plain so nano treats the body as a raw log line rather than trying to unwrap it as JSON.
[sinks.${name}.request.headers]
X-Source-Type = "${s.sourceType}"
Content-Type = "text/plain"

[sinks.${name}.buffer]
type = "disk"
max_size = ${maxSize}
when_full = "block"`;
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
