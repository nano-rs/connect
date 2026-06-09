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
  "parser_repositories:view", // check the community repo for a matching parser
] as const;

/** Elevated scopes that let the CLI one-click deploy a community parser; best-effort. */
export const ELEVATED_SCOPES = [
  "parser_repositories:import", // import a community parser as a log source
  "log_sources:deploy", // activate it on the instance
] as const;

export type Scope = (typeof REQUIRED_SCOPES)[number] | (typeof ELEVATED_SCOPES)[number];

/** Human-readable explanation per scope, shown before minting a key. */
export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "search:execute": "run a search to confirm your logs arrived and are queryable",
  "log_sources:view": "list deployed parsers so we can match your log type",
  "parser_repositories:view": "check the community repo for a matching parser",
  "parser_repositories:import": "import a community parser for you (if you have an unrecognized source)",
  "log_sources:deploy": "activate that parser so your logs get normalized",
};
