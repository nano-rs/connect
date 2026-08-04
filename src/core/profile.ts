import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Persisted connection profile so repeat runs don't re-prompt. Stored at
 * $XDG_CONFIG_HOME/nano-connect/profile.json (default ~/.config/...), file mode 0600
 * because it holds API keys and ingest tokens.
 *
 * Secrets are keyed BY INSTANCE, deliberately. The previous format was one flat record
 * (baseUrl + apiKey + ingestToken), so pointing the CLI at a different instance kept the old
 * secrets in place. The API key survived that because it gets validated on use and replaced when
 * rejected — but the ingest token has no validation path, so it was silently carried across and
 * sent to the new instance. nano answers a wrong ingest token with 200 and drops the event, which
 * makes the failure invisible: onboarding "succeeds" and no data ever arrives. Per-instance
 * storage removes the possibility rather than trying to detect it afterwards.
 */

/** Everything saved for one nano instance. */
export interface InstanceProfile {
  apiKey?: string;
  ingestToken?: string;
  /** Saved search-endpoint override for split deployments. */
  searchUrl?: string;
  /**
   * The ingest endpoint that actually accepted a test event. Saved so `add-*` generate an HTTP
   * uplink against the proven URL instead of re-guessing the candidate list.
   */
  ingestUrl?: string;
}

interface ProfileFile {
  version: number;
  /** Last instance connected to — the default when no --url is given. */
  current?: string;
  instances: Record<string, InstanceProfile>;
}

const CURRENT_VERSION = 2;

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "nano-connect");
}

function profilePath(): string {
  return join(configDir(), "profile.json");
}

/** Legacy (v1) flat shape, migrated on read. */
interface LegacyProfile {
  baseUrl?: string;
  apiKey?: string;
  ingestToken?: string;
  searchUrl?: string;
  ingestUrl?: string;
}

function migrate(raw: unknown): ProfileFile {
  const obj = (raw ?? {}) as Record<string, unknown>;
  if (obj.version === CURRENT_VERSION && obj.instances && typeof obj.instances === "object") {
    return {
      version: CURRENT_VERSION,
      current: typeof obj.current === "string" ? obj.current : undefined,
      instances: obj.instances as Record<string, InstanceProfile>,
    };
  }
  // v1 -> v2: the flat record becomes the entry for whatever instance it named. If it named none,
  // the secrets can't be attributed to an instance, so they're dropped rather than reused blindly.
  const legacy = obj as LegacyProfile;
  const out: ProfileFile = { version: CURRENT_VERSION, instances: {} };
  if (legacy.baseUrl) {
    out.current = legacy.baseUrl;
    out.instances[legacy.baseUrl] = {
      apiKey: legacy.apiKey,
      ingestToken: legacy.ingestToken,
      searchUrl: legacy.searchUrl,
      ingestUrl: legacy.ingestUrl,
    };
  }
  return out;
}

function readFile(): ProfileFile {
  const path = profilePath();
  if (!existsSync(path)) return { version: CURRENT_VERSION, instances: {} };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { version: CURRENT_VERSION, instances: {} };
  }
  if (!raw.trim()) return { version: CURRENT_VERSION, instances: {} };
  try {
    return migrate(JSON.parse(raw));
  } catch {
    // Don't silently drop a corrupt profile — tell the user before we overwrite it.
    process.stderr.write(`warning: ${path} is not valid JSON; ignoring it.\n`);
    return { version: CURRENT_VERSION, instances: {} };
  }
}

function writeFile(data: ProfileFile): void {
  const path = profilePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Atomic write (tmp + rename) so a crash mid-write can't truncate the secrets file, and an
  // explicit chmod because writeFileSync's mode only applies when the file is first created.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** The instance to use when the caller didn't name one. */
export function currentBaseUrl(): string | undefined {
  return readFile().current;
}

/**
 * Saved settings for ONE instance. Returns empty for an instance we haven't connected to —
 * never another instance's secrets.
 */
export function loadInstance(baseUrl: string): InstanceProfile {
  return readFile().instances[baseUrl] ?? {};
}

/** Merge settings for one instance and mark it current. */
export function saveInstance(baseUrl: string, update: InstanceProfile): void {
  const data = readFile();
  data.instances[baseUrl] = { ...(data.instances[baseUrl] ?? {}), ...update };
  data.current = baseUrl;
  writeFile(data);
}

/** Instances with saved settings — for diagnostics and `connect` messaging. */
export function knownInstances(): string[] {
  return Object.keys(readFile().instances);
}

export { profilePath };
