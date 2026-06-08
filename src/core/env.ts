import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Locate and parse a nano install `.env` (written by install.sh) to pre-fill connection details
 * for self-hosted users. We only read the few keys we need.
 */

const RELEVANT_KEYS = ["BASE_URL", "VECTOR_AUTH_TOKEN"] as const;

export interface EnvFile {
  path: string;
  baseUrl?: string;
  ingestToken?: string;
}

/** Candidate locations for a nano .env, in priority order. */
function candidatePaths(explicit?: string): string[] {
  if (explicit) return [resolve(explicit)];
  return [
    join(process.cwd(), ".env"),
    join(homedir(), "nano", ".env"),
    join(homedir(), ".nano", ".env"),
  ];
}

/** Minimal dotenv parser — handles KEY=value, quotes, comments, blank lines. */
function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function findEnvFile(explicit?: string): EnvFile | undefined {
  for (const path of candidatePaths(explicit)) {
    if (!existsSync(path)) continue;
    let parsed: Record<string, string>;
    try {
      parsed = parseDotenv(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!RELEVANT_KEYS.some((k) => parsed[k])) continue;
    return {
      path,
      baseUrl: parsed.BASE_URL || undefined,
      ingestToken: parsed.VECTOR_AUTH_TOKEN || undefined,
    };
  }
  return undefined;
}
