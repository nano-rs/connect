import { apiBase, healthUrl } from "./endpoints.js";
import {
  type ApiKeyCreated,
  type AuthResponse,
  NanoApiError,
  type SearchResponse,
  type SetupStatus,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 20_000;

async function request<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new NanoApiError(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new NanoApiError(
      `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new NanoApiError(
      `${init.method ?? "GET"} ${url} failed: ${res.status} ${res.statusText}`,
      res.status,
      text,
    );
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new NanoApiError(`Unexpected non-JSON response from ${url}`, res.status, text);
  }
}

/** A thin client over the nano API for the onboarding flow. */
export class NanoClient {
  private apiKey?: string;
  /** Override for the search endpoint (split deployments serve it on a different host/port). */
  private readonly searchUrl: string;

  constructor(
    private readonly baseUrl: string,
    init: { apiKey?: string; searchUrl?: string } = {},
  ) {
    this.apiKey = init.apiKey;
    this.searchUrl = init.searchUrl ?? `${apiBase(baseUrl)}/search`;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  private authHeaders(): Record<string, string> {
    if (!this.apiKey) return {};
    // The API accepts the key via X-API-Key (see api_key security scheme).
    return { "X-API-Key": this.apiKey };
  }

  /** Public liveness check. Returns true if the instance answers with status "ok". */
  async health(): Promise<boolean> {
    try {
      const res = await request<{ status: string }>(healthUrl(this.baseUrl), {
        timeoutMs: 8_000,
      });
      return res.status === "ok";
    } catch {
      return false;
    }
  }

  async setupStatus(): Promise<SetupStatus> {
    return request<SetupStatus>(`${apiBase(this.baseUrl)}/setup/status`, {
      timeoutMs: 8_000,
    });
  }

  /** Exchange email + password for a JWT access token. */
  async login(email: string, password: string): Promise<AuthResponse> {
    return request<AuthResponse>(`${apiBase(this.baseUrl)}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  }

  /** Mint an API key with the given scopes, authenticated by a JWT access token. */
  async createApiKey(
    accessToken: string,
    name: string,
    permissions: string[],
  ): Promise<ApiKeyCreated> {
    return request<ApiKeyCreated>(`${apiBase(this.baseUrl)}/api-keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ name, permissions }),
    });
  }

  /** Run a search. Used by the verify loop to confirm logs arrived. */
  async search(query: string, startIso: string, endIso: string, limit = 5): Promise<SearchResponse> {
    return request<SearchResponse>(this.searchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.authHeaders(),
      },
      body: JSON.stringify({
        query,
        time_range: { start: startIso, end: endIso },
        limit,
        offset: 0,
        skip_histogram: true,
        skip_field_stats: true,
        async_mode: false,
      }),
    });
  }

  /**
   * Validate the current API key by issuing a cheap authenticated search.
   * - "ok": the key works and search is reachable.
   * - "unauthorized": the key was rejected (401/403).
   * - "error": couldn't tell (timeout, 5xx, unreachable) — don't claim the key is good or bad.
   */
  async validateApiKey(): Promise<"ok" | "unauthorized" | "error"> {
    if (!this.apiKey) return "unauthorized";
    const now = Date.now();
    const start = new Date(now - 60_000).toISOString();
    const end = new Date(now).toISOString();
    try {
      await this.search("*", start, end, 1);
      return "ok";
    } catch (err) {
      if (err instanceof NanoApiError && (err.status === 401 || err.status === 403)) {
        return "unauthorized";
      }
      return "error";
    }
  }
}
