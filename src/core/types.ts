/** A resolved connection to a nano instance, enough to call the API and ingest logs. */
export interface Connection {
  /** Base URL of the nano instance, no trailing slash (e.g. https://nano.example.com). */
  baseUrl: string;
  /** API key used for authenticated API calls (search, log-source lookup). */
  apiKey?: string;
  /** Vector ingest token (Authorization: Bearer ...) for POSTing logs. Separate from apiKey. */
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
