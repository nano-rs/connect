/** A resolved connection to a nano instance, enough to call the API and ingest logs. */
export interface Connection {
  /** Base URL of the nano instance, no trailing slash (e.g. https://nano.example.com). */
  baseUrl: string;
  /** API key used for authenticated API calls (search, log-source lookup). */
  apiKey?: string;
  /**
   * Shared ingest token (the install's VECTOR_AUTH_TOKEN). Only a nano that predates per-source
   * tokens (NAN-3806) routes with it; a current nano binds each token to one log source.
   */
  ingestToken?: string;
  /** Where this connection's values came from, for honest UX. */
  source: "flag" | "profile" | "env-file" | "prompt";
}

/** Response shape of POST /api/auth/login. */
export interface AuthResponse {
  user: {
    id: string;
    email: string;
    name: string;
    roles: string[];
    permissions: string[];
  };
  tokens: {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
  };
}

/** Response shape of POST /api/api-keys (201). The plaintext `key` is returned only once. */
export interface ApiKeyCreated {
  id: string;
  key: string;
  name: string;
  key_prefix: string;
  created_at: string;
}

/** Response shape of GET /api/setup/status. */
export interface SetupStatus {
  initialized: boolean;
  has_users: boolean;
}

/** Subset of POST /api/search response we care about for verification. */
export interface SearchResponse {
  results: Record<string, unknown>[];
  total_count: number;
  execution_time_ms: number;
}

/** A deployed log source (parser) on the instance. */
export interface LogSource {
  id: string;
  name: string;
  match_values?: string[] | null;
  deployed?: boolean;
  status?: string;
}

/** A configured parser repository (e.g. the official nano-rs/parsers). */
export interface ParserRepository {
  id: string;
  name: string;
  url?: string;
  enabled?: boolean;
  parser_count?: number;
  branch?: string;
  last_synced_at?: string | null;
  last_sync_status?: string | null;
  last_sync_error?: string | null;
}

/** Progress of an in-flight repository sync. */
export interface RepoSyncStatus {
  status?: string;
  parser_count?: number;
  error?: string | null;
  message?: string | null;
}

/**
 * A parser in a repository. The list endpoint returns these flat (not wrapped). `match_values` is
 * null in the list response — aliases live in `raw_content` (YAML) and are resolved at import.
 */
export interface RepositoryParser {
  id: string;
  name?: string;
  display_name?: string;
  match_values?: string[] | null;
  file_path: string;
  /** "parser" or "enrichment" — only "parser" should be offered for log onboarding. */
  kind?: string;
  is_imported?: boolean;
  linked_log_source_id?: string | null;
  /** The parser YAML; the only place alias match_values are available in the list response. */
  raw_content?: string;
}

/** Result of POST /api/log-sources/{id}/deploy (HTTP 200 even when success is false). */
export interface DeploymentResult {
  success: boolean;
  message?: string;
}

/**
 * A log source an ingest token can be bound to (nano NAN-3806, `GET /api/ingest-tokens` →
 * `sources`). Only push-capable sources are listed (HTTP, HEC, Vector); never OTLP or pulled ones.
 */
export interface BindableSource {
  source_id: string;
  name: string;
  /** The source's transport label (`routed`, `splunk_hec`, ...). */
  source_type: string;
  /** The `.source_type` every event sent with a token bound to this source is routed on. */
  route_key: string;
  enabled: boolean;
}

/** One issued ingest token as nano lists it. Never carries the token value. */
export interface IngestTokenInfo {
  credential_id: string;
  name: string;
  /** `nit_` plus the first 8 random characters — the first 12 characters of the token value. */
  token_prefix: string;
  /** `active`, `unbound` (refused with 401 until bound) or `revoked`. */
  state: string;
  source_id?: string | null;
  source_name?: string | null;
  route_key?: string | null;
}

/** The install-wide token's state (`VECTOR_AUTH_TOKEN`). Its value is never returned. */
export interface InstallTokenState {
  enabled: boolean;
  /** `active` (enabled and bound), `unbound`, `disabled` or `not_configured`. */
  state?: string;
  source_id?: string | null;
  route_key?: string | null;
}

/**
 * `GET /api/ingest-tokens`. `sources` is what marks a nano that binds every token to one source
 * (NAN-3806); a nano that predates it returns the list without `sources`.
 */
export interface IngestTokenList {
  tokens: IngestTokenInfo[];
  install_token?: InstallTokenState;
  sources?: BindableSource[];
}

/** `POST /api/ingest-tokens` (201). `token` is shown exactly once. */
export interface IssuedIngestToken {
  credential: IngestTokenInfo;
  token: string;
}

/** A nano API error surfaced to the user. */
export class NanoApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "NanoApiError";
  }
}
