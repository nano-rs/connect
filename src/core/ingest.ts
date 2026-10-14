import { type IngestModel, ingestRejectionMessage } from "./ingestTokens.js";
import { NanoApiError } from "./types.js";

export interface TestEventResult {
  marker: string;
  /** Which candidate endpoint actually accepted the event. */
  endpoint: string;
}

async function postEvent(
  endpoint: string,
  ingestToken: string | undefined,
  sourceType: string,
  body: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    return await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(ingestToken ? { Authorization: `Bearer ${ingestToken}` } : {}),
        // Informational on a nano that binds tokens to sources (kept as claimed_source_type); the
        // routing key on an older one.
        "X-Source-Type": sourceType,
      },
      body,
      // Don't follow redirects — a 301 on /ingest means "wrong endpoint", not success.
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST a marked test event to the first ingest endpoint that accepts it. Probes the candidates in
 * order; a 2xx wins, a 401/403 means the endpoint is right but the token is wrong (surface it), and
 * anything else (redirect / 404 / unreachable) moves to the next candidate.
 *
 * `model` only shapes the 401/403 message: on a nano that binds tokens to log sources it almost
 * always means the token isn't bound to one.
 */
export async function sendTestEvent(
  endpoints: string[],
  ingestToken: string,
  sourceType: string,
  model: IngestModel["kind"] = "legacy",
): Promise<TestEventResult> {
  const marker = `nano-connect-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const body = `${JSON.stringify({
    message: `nano-connect connectivity test ${marker}`,
    source_type: sourceType,
    nano_connect_test: true,
    nano_connect_marker: marker,
  })}\n`;

  const tried: string[] = [];
  for (const endpoint of endpoints) {
    tried.push(endpoint);
    let res: Response;
    try {
      res = await postEvent(endpoint, ingestToken, sourceType, body);
    } catch {
      continue; // unreachable / timeout — try the next candidate
    }
    if (res.ok) return { marker, endpoint };
    if (res.status === 401 || res.status === 403) {
      const detail = await res.text().catch(() => "");
      throw new NanoApiError(ingestRejectionMessage(res.status, model), res.status, detail);
    }
    // 3xx/404/5xx — wrong endpoint shape; keep probing.
  }
  throw new NanoApiError(`No ingest endpoint accepted the event. Tried: ${tried.join(", ")}`);
}

/**
 * Find the ingest endpoint without a token: the right endpoint refuses an unauthenticated POST
 * with 401/403, a wrong one redirects / 404s / doesn't answer. Used against a nano that binds
 * tokens to log sources, where connect has no token to test with until a collector is generated.
 * Nothing is ingested.
 */
export async function probeIngestEndpoint(endpoints: string[]): Promise<string | undefined> {
  for (const endpoint of endpoints) {
    let res: Response;
    try {
      res = await postEvent(endpoint, undefined, "nano_connect_probe", "{}\n");
    } catch {
      continue;
    }
    if (res.status === 401 || res.status === 403) return endpoint;
  }
  return undefined;
}
