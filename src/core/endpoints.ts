/** Resolve the concrete URLs for a nano instance from its base URL. */

export function normalizeBaseUrl(raw: string): string {
  let input = raw.trim();
  if (!/^https?:\/\//i.test(input)) {
    // Default to https for anything without an explicit scheme.
    input = `https://${input}`;
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`nano URL must be http or https, got "${url.protocol}".`);
  }
  // Reject embedded credentials — we send a Bearer token / API key to this host; userinfo in the
  // URL is both a leak vector and almost always a paste mistake.
  if (url.username || url.password) {
    throw new Error("nano URL must not contain credentials (user:pass@…).");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

/** True if this is plain http to a non-loopback host — sending secrets there is a risk. */
export function isInsecureRemote(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const host = url.hostname;
  const loopback =
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.startsWith("127.") ||
    host.endsWith(".localhost");
  return !loopback;
}

/** Authenticated/REST API base, e.g. https://nano.example.com/api */
export function apiBase(baseUrl: string): string {
  return `${baseUrl}/api`;
}

/** Public health endpoint (no /api prefix), e.g. https://nano.example.com/health */
export function healthUrl(baseUrl: string): string {
  return `${baseUrl}/health`;
}

/**
 * External ingest URL a collector POSTs logs to.
 *
 * Self-hosted (install.sh / docker-compose) fronts Vector with nginx at `/ingest`. SaaS "hobby"
 * tenants use a different host-shaped path; that's handled later when we know the tenant shape.
 */
export function ingestUrl(baseUrl: string): string {
  return `${baseUrl}/ingest`;
}
