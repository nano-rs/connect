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
