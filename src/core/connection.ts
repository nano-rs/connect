import { normalizeBaseUrl } from "./endpoints.js";
import { findEnvFile } from "./env.js";
import { currentBaseUrl, loadInstance } from "./profile.js";
import { NanoApiError } from "./types.js";

export interface ConnectionInputs {
  url?: string;
  apiKey?: string;
  searchUrl?: string;
  ingestToken?: string;
  envFile?: string;
}

export interface ResolvedConnection {
  baseUrl: string;
  apiKey?: string;
  searchUrl?: string;
  ingestToken?: string;
  /** Ingest endpoint proven by `connect`, used for HTTP-transport uplinks. */
  ingestUrl?: string;
}

/**
 * Resolve a saved connection (flags > profile > install .env) without any interactive prompting.
 * Used by sub-commands that assume `connect` already established + saved a connection.
 */
export function resolveSavedConnection(opts: ConnectionInputs): ResolvedConnection {
  const env = findEnvFile(opts.envFile);
  const raw = opts.url ?? currentBaseUrl() ?? env?.baseUrl;
  if (!raw) {
    throw new NanoApiError("No saved nano connection. Run `connect` first, or pass --url.");
  }
  const baseUrl = normalizeBaseUrl(raw);
  // Secrets come from THIS instance's entry only. Pointing --url at an instance we haven't
  // connected to yields no credentials rather than the previous instance's.
  const saved = loadInstance(baseUrl);
  return {
    baseUrl,
    apiKey: opts.apiKey ?? saved.apiKey,
    searchUrl: opts.searchUrl ?? saved.searchUrl,
    ingestToken: opts.ingestToken ?? env?.ingestToken ?? saved.ingestToken,
    ingestUrl: saved.ingestUrl,
  };
}
