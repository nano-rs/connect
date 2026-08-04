import { existsSync, readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { ingestCandidates } from "./endpoints.js";
import { NanoApiError } from "./types.js";
import { INGEST_TOKEN_ENV, type MtlsPaths, type SinkTls, type Target, type Transport } from "./vector.js";

/**
 * How a generated collector reaches nano.
 *
 * Two transports, both first-class:
 *   • `native` — Vector-to-Vector protobuf on :6000. Acks + backpressure + disk buffer.
 *     ALWAYS TLS-wrapped: nano's managed listeners terminate TLS there, so a plaintext sink
 *     fails the handshake ("broken pipe") and quietly buffers forever.
 *   • `http`   — NDJSON to nano's `/ingest/`. Authenticated with the ingest token, and the only
 *     transport that works when :6000 isn't reachable from the collector.
 */
export interface NanoUplink {
  transport: Transport;
  /** native only — nano's Vector-native listener. */
  target: Target;
  /** http only — the resolved ingest endpoint. */
  ingestUrl: string;
  /** native only. */
  tls: SinkTls;
  /** http only — written to a 0600 .env beside the config, never inlined into vector.toml. */
  ingestToken?: string;
  /**
   * Where the operator's cert files live right now, so the generator can COPY them into the
   * artifact directory. We never reference the source location from the config: the realistic
   * --mtls-dir is a download folder, and mounting that into a container would expose everything
   * else in it.
   */
  mtlsSource?: { ca: string; crt: string; key: string };
  /** Where the bundle was found, so the CLI can say so (it may have been auto-detected). */
  mtlsDir?: string;
}

/**
 * Path the generated configs read certificates from. Fixed and absolute so ONE config works
 * both in the container (bind-mounted there by docker-compose) and on bare metal (the systemd
 * instructions copy the `tls/` folder to this path).
 */
export const MTLS_CONFIG_DIR = "/etc/vector/tls";

export interface UplinkInputs {
  transport?: string;
  /**
   * Where to look for the mTLS bundle. Defaults to the working directory — the console's
   * "Download bundle" saves ca.crt / client.crt / client.key, so dropping those three next to
   * where you run `connect` is all it takes.
   */
  mtlsDir?: string;
  /** Explicit ingest endpoint, when the saved/probed one isn't right. */
  ingestUrl?: string;
}

export function parseTransport(raw: string | undefined, fallback: Transport = "native"): Transport {
  if (raw === undefined) return fallback;
  const t = raw.trim().toLowerCase();
  if (t === "native" || t === "http") return t;
  throw new NanoApiError(`Invalid --transport "${raw}" (expected: native | http).`);
}

/** The three files the console's "Download bundle" saves. */
const BUNDLE_FILES = { ca: "ca.crt", crt: "client.crt", key: "client.key" } as const;

/** Subject CN of a PEM certificate, e.g. "vector-client@org.nano.rs". */
function certCommonName(pem: string): string | undefined {
  try {
    const subject = new X509Certificate(pem).subject;
    return /CN=([^\n,]+)/.exec(subject)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the mTLS bundle from a directory — by default the one you're running in.
 *
 * Exact filenames only, and deliberately so. A download folder routinely holds bundles from
 * SEVERAL deployments (`client.crt`, `client (1).crt`, `client (2).crt` — each a different
 * tenant), and any "pick the newest match" heuristic can pair one tenant's key with another's
 * certificate. So: drop the three files where you're working, or point --mtls-dir at a directory
 * holding exactly one bundle.
 *
 * Returns both the SOURCE paths (to copy into the artifact dir) and the CONFIG paths the
 * generated vector.toml will reference. They differ on purpose — see `mtlsSource`.
 */
export function resolveMtls(
  explicitDir: string | undefined,
  expectedHost?: string,
): { source: { ca: string; crt: string; key: string }; config: MtlsPaths; dir: string } | undefined {
  const dir = resolve(explicitDir ?? process.cwd());
  if (!existsSync(dir)) {
    throw new NanoApiError(`--mtls-dir "${dir}" does not exist.`);
  }
  const ca = join(dir, BUNDLE_FILES.ca);
  const crt = join(dir, BUNDLE_FILES.crt);
  const key = join(dir, BUNDLE_FILES.key);
  const present = [ca, crt, key].filter((p) => existsSync(p));

  const hint =
    `Download it from app.nano.rs → your deployment → Credentials → Vector mTLS → Download ` +
    `bundle, then put ${BUNDLE_FILES.ca}, ${BUNDLE_FILES.crt} and ${BUNDLE_FILES.key} in "${dir}". ` +
    `Browsers rename repeat downloads ("client (1).crt") — rename them back, and make sure all ` +
    `three come from the SAME deployment.`;

  if (present.length === 0) {
    if (explicitDir) throw new NanoApiError(`No mTLS bundle in "${dir}". ${hint}`);
    return undefined; // no bundle, no client certs — the normal case
  }
  if (present.length < 3) {
    // A partial bundle is always a mistake; never silently fall back to no client certificate.
    const missing = [ca, crt, key].filter((p) => !existsSync(p)).map((p) => basename(p));
    throw new NanoApiError(`Incomplete mTLS bundle in "${dir}" — missing ${missing.join(", ")}. ${hint}`);
  }

  // Guard against a bundle from a DIFFERENT deployment: the client cert's CN carries the tenant
  // hostname, so a mismatch here means these certs would authenticate us as somebody else.
  const cn = certCommonName(readFileSync(crt, "utf8"));
  if (expectedHost && cn && !cn.endsWith(`@${expectedHost}`)) {
    throw new NanoApiError(
      `The mTLS bundle in "${dir}" belongs to a different deployment: ${BUNDLE_FILES.crt} is ` +
        `"${cn}", but this collector ships to ${expectedHost}. Use that deployment's bundle.`,
    );
  }

  return {
    dir,
    source: { ca, crt, key },
    config: {
      // Deliberately NO ca_file. On a sink, `ca_file` is the trust anchor for verifying the
      // SERVER's certificate — and nano's listener presents a public (Let's Encrypt) cert, so
      // pinning the nano mTLS CA here fails the handshake with "unable to get local issuer
      // certificate". The bundle's ca.crt is the SERVER's anchor for verifying clients; we only
      // ever present client.crt/client.key. Verified against a live tenant.
      crtFile: `${MTLS_CONFIG_DIR}/${BUNDLE_FILES.crt}`,
      keyFile: `${MTLS_CONFIG_DIR}/${BUNDLE_FILES.key}`,
    },
  };
}

export interface ResolveUplinkArgs {
  baseUrl: string;
  /** native target — already validated by the caller. */
  target: Target;
  opts: UplinkInputs;
  /** Saved ingest endpoint from the profile (the one `connect` proved), if any. */
  savedIngestUrl?: string;
  ingestToken?: string;
  /** Default transport when --transport isn't passed. */
  fallback?: Transport;
}

export function resolveUplink(args: ResolveUplinkArgs): NanoUplink {
  const transport = parseTransport(args.opts.transport, args.fallback ?? "native");
  // Client certificates only mean something on the native uplink. Resolving them for HTTP would
  // copy a private key into an artifact that never reads it — and auto-detection means a bundle
  // simply sitting in the working directory would trigger that.
  const mtls = transport === "native" ? resolveMtls(args.opts.mtlsDir, args.target.host) : undefined;
  if (transport === "http" && args.opts.mtlsDir) {
    throw new NanoApiError(
      "--mtls-dir applies to --transport native. The HTTP uplink authenticates with the ingest " +
        "token instead, so drop --mtls-dir (or switch to --transport native).",
    );
  }

  // Prefer the endpoint `connect` actually proved, then an explicit override, then the first probe
  // candidate. Guessing here is the difference between "logs flow" and a silent 301 into nothing.
  // ingestCandidates always yields at least the `${baseUrl}/ingest/` entry, but keep the fallback
  // explicit rather than asserting non-null on an array index.
  const ingestUrl =
    args.opts.ingestUrl ??
    args.savedIngestUrl ??
    ingestCandidates(args.baseUrl)[0] ??
    `${args.baseUrl}/ingest/`;

  if (transport === "http" && !args.ingestToken) {
    throw new NanoApiError(
      `--transport http needs the ingest token (${INGEST_TOKEN_ENV}) to authenticate. Run \`connect\` ` +
        `first so it's saved, or pass --ingest-token.`,
    );
  }

  return {
    transport,
    target: args.target,
    ingestUrl,
    // Every uplink to nano is TLS. There is no opt-out flag on purpose.
    tls: { enabled: true, mtls: mtls?.config },
    ingestToken: args.ingestToken,
    mtlsSource: mtls?.source,
    mtlsDir: mtls?.dir,
  };
}

/** The `.env` written beside an HTTP-transport config so the token stays out of vector.toml. */
export function buildIngestEnvFile(token: string): string {
  return `# Ingest token for nano — read by vector.toml as \${${INGEST_TOKEN_ENV}}.
# Keep this file 0600 and out of version control.
${INGEST_TOKEN_ENV}=${token}
`;
}

/** Extra docker-compose service lines an uplink needs (env file, cert mount). */
export function composeUplinkLines(uplink: NanoUplink): { env: string; volumes: string } {
  const env = uplink.transport === "http" ? "    env_file:\n      - ./.env\n" : "";
  // Mounts the copied bundle, never the operator's download folder.
  const volumes = uplink.tls.mtls ? `      - ./tls:${MTLS_CONFIG_DIR}:ro\n` : "";
  return { env, volumes };
}

/** The bundle files to write into the artifact dir, keyed by their path within it. */
export function mtlsArtifacts(uplink: NanoUplink): Record<string, string> {
  if (!uplink.mtlsSource) return {};
  return {
    "tls/ca.crt": readFileSync(uplink.mtlsSource.ca, "utf8"),
    "tls/client.crt": readFileSync(uplink.mtlsSource.crt, "utf8"),
    "tls/client.key": readFileSync(uplink.mtlsSource.key, "utf8"),
  };
}

/** Bundle files that must land 0600 (the private key). */
export const MTLS_SECRET_FILES = ["tls/client.key"];
