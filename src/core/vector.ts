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

export interface VectorSinkOpts {
  name: string;
  inputs: string[];
  target: Target;
  /** Only enable when EVERY input source supports acknowledgements (syslog/UDP does not). */
  acknowledgements: boolean;
  bufferBytes: number;
}

/** The Vector-native sink block (protobuf + disk buffer), shared by agents and aggregators. */
export function vectorSink(o: VectorSinkOpts): string {
  const inputs = o.inputs.map((i) => `"${i}"`).join(", ");
  const maxSize = Math.max(o.bufferBytes, MIN_DISK_BUFFER_BYTES);
  return `[sinks.${o.name}]
type = "vector"
inputs = [${inputs}]
address = "${formatAddress(o.target.host, o.target.port)}"
acknowledgements.enabled = ${o.acknowledgements}

[sinks.${o.name}.buffer]
type = "disk"
max_size = ${maxSize}
when_full = "block"`;
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
