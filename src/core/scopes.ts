/**
 * Permission scopes the CLI needs on the API key it mints.
 *
 * Note: there is NO `logs:ingest` scope in nano — log ingestion is authenticated by the
 * separate VECTOR_AUTH_TOKEN (a Vector sink secret), not by an API key. The API key here is
 * only for talking to the nano API: running the verify search and matching parsers/log sources.
 */
export const REQUIRED_SCOPES = [
  "search:execute", // run the verify-loop search to confirm logs arrived
  "log_sources:view", // list deployed parsers / match a source_type
] as const;

/** Optional scopes that unlock richer onboarding (deploying a parser draft) if granted. */
export const OPTIONAL_SCOPES = [
  "parsers:view",
  "log_sources:create",
  "log_sources:deploy",
] as const;

export type Scope = (typeof REQUIRED_SCOPES)[number] | (typeof OPTIONAL_SCOPES)[number];

/** Human-readable explanation per scope, shown before minting a key. */
export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "search:execute": "run a search to confirm your logs arrived and are queryable",
  "log_sources:view": "list deployed parsers so we can match your log type",
  "parsers:view": "browse the parser library for a matching parser",
  "log_sources:create": "save a draft parser for an unrecognized log type",
  "log_sources:deploy": "deploy that parser so your logs get normalized",
};
