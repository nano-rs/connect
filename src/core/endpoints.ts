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

/**
 * Candidate HTTP ingest endpoints to try, in order. Real deployments differ:
 *   - cheaper SaaS: `/ingest/` on the base domain         → baseUrl/ingest/
 *   - dedicated SaaS: a separate Vector host              → https://ingest-<sub>.<domain>
 *   - open-core (docker-compose.opensource.yml): direct  → host:8080
 * An explicit override short-circuits the list; the spine probes the rest and uses the first that
 * accepts an event.
 */
export function ingestCandidates(baseUrl: string, explicit?: string): string[] {
  if (explicit) return [explicit];
  // The trailing slash matters: managed compose boxes serve `location /ingest/` and 301 the bare
  // path, and the spine treats any redirect as "wrong endpoint". Keep the bare path as a fallback
  // for proxies that only match `/ingest` exactly.
  const candidates = [`${baseUrl}/ingest/`, `${baseUrl}/ingest`];
  try {
    const u = new URL(baseUrl);
    const host = u.hostname;
    const isIp = /^\d+(\.\d+){3}$/.test(host) || host.includes(":");
    const labels = host.split(".");
    // Dedicated ingest host: acme.nano.rs -> ingest-acme.nano.rs (only for real subdomains).
    if (!isIp && labels.length >= 3) {
      const dedicated = host.replace(/^[^.]+/, (first) => `ingest-${first}`);
      candidates.push(`${u.protocol}//${dedicated}`);
    }
    // Open-core direct Vector port.
    candidates.push(`${u.protocol}//${host}:8080/`);
  } catch {
    /* baseUrl already normalized; the /ingest candidates stand */
  }
  return candidates;
}
