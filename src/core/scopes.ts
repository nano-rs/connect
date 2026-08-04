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

/**
 * Elevated scopes that let the CLI one-click deploy a community parser; best-effort.
 *
 * Importing a repo parser is a composite operation, not a single capability:
 * `parser_repositories:import` only authorizes the CATALOG READ. The import then creates a
 * first-class `log_sources` row (`log_sources:create`) and, for `ingestion_method: "routed"`
 * — which is what we send — republishes the routing/source config (`source_configs:edit`).
 * See nanosiem `ParserImportPlan::required_effects` (NAN-2117). Omitting either made
 * `--deploy-parsers` fail 403 on every instance, with a message blaming the operator's account.
 */
export const ELEVATED_SCOPES = [
  "parser_repositories:sync", // refresh the community catalog (`connect sync-parsers`)
  "parser_repositories:manage", // register the official repo when the instance has none
  "parser_repositories:import", // read the community catalog
  "log_sources:create", // the import creates the log_sources row
  "source_configs:edit", // routed imports republish the source/routing config
  "log_sources:deploy", // activate it on the instance
] as const;

export type Scope = (typeof REQUIRED_SCOPES)[number] | (typeof ELEVATED_SCOPES)[number];

/** Human-readable explanation per scope, shown before minting a key. */
export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "search:execute": "run a search to confirm your logs arrived and are queryable",
  "log_sources:view": "list deployed parsers so we can match your log type",
  "parser_repositories:view": "check the community repo for a matching parser",
  "parser_repositories:sync": "refresh the community parser catalog so we can match your sources",
  "parser_repositories:manage": "register the official parser repository if your instance has none",
  "parser_repositories:import": "import a community parser for you (if you have an unrecognized source)",
  "log_sources:create": "create the log source that parser becomes",
  "source_configs:edit": "publish the routing config so your source_type reaches that parser",
  "log_sources:deploy": "activate that parser so your logs get normalized",
};
