import { NanoApiError } from "./types.js";

export interface TestEventResult {
  marker: string;
  /** Which candidate endpoint actually accepted the event. */
  endpoint: string;
}

async function postEvent(endpoint: string, ingestToken: string, sourceType: string, body: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    return await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ingestToken}`,
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
 */
export async function sendTestEvent(
  endpoints: string[],
  ingestToken: string,
  sourceType: string,
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
      throw new NanoApiError(
        "Ingest token rejected (401/403). Check VECTOR_AUTH_TOKEN matches this instance.",
        res.status,
        detail,
      );
    }
    // 3xx/404/5xx — wrong endpoint shape; keep probing.
  }
  throw new NanoApiError(`No ingest endpoint accepted the event. Tried: ${tried.join(", ")}`);
}
