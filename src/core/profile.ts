import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Persisted connection profile so repeat runs don't re-prompt. Stored at
 * $XDG_CONFIG_HOME/nano-connect/profile.json (default ~/.config/...), file mode 0600
 * because it can hold an API key and ingest token.
 */

export interface Profile {
  baseUrl?: string;
  apiKey?: string;
  ingestToken?: string;
  /** Saved search-endpoint override for split deployments. */
  searchUrl?: string;
}

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "nano-connect");
}

function profilePath(): string {
  return join(configDir(), "profile.json");
}

export function loadProfile(): Profile {
  const path = profilePath();
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Profile;
  } catch {
    // Don't silently drop a corrupt profile — tell the user before we overwrite it.
    process.stderr.write(`warning: ${path} is not valid JSON; ignoring it.\n`);
    return {};
  }
}

export function saveProfile(update: Profile): void {
  const path = profilePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const merged = { ...loadProfile(), ...update };
  // Atomic write (tmp + rename) so a crash mid-write can't truncate the secrets file, and an
  // explicit chmod because writeFileSync's mode only applies when the file is first created.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export { profilePath };
