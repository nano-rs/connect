import { normalizeBaseUrl } from "./endpoints.js";
import { findEnvFile } from "./env.js";
import { loadProfile } from "./profile.js";
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
}

/**
 * Resolve a saved connection (flags > profile > install .env) without any interactive prompting.
 * Used by sub-commands that assume `connect` already established + saved a connection.
 */
export function resolveSavedConnection(opts: ConnectionInputs): ResolvedConnection {
  const profile = loadProfile();
  const env = findEnvFile(opts.envFile);
  const raw = opts.url ?? profile.baseUrl ?? env?.baseUrl;
  if (!raw) {
    throw new NanoApiError("No saved nano connection. Run `connect` first, or pass --url.");
  }
  return {
    baseUrl: normalizeBaseUrl(raw),
    apiKey: opts.apiKey ?? profile.apiKey,
    searchUrl: opts.searchUrl ?? profile.searchUrl,
    ingestToken: opts.ingestToken ?? env?.ingestToken ?? profile.ingestToken,
  };
}
