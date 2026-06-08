import { NanoApiError } from "./types.js";

/**
 * POST a single test event to nano's ingest endpoint to prove the token + endpoint work
 * end-to-end before we generate any collector config.
 */
export async function sendTestEvent(
  endpoint: string,
  ingestToken: string,
  sourceType: string,
): Promise<{ marker: string }> {
  // Unique marker so the verify search can find exactly this event.
  const marker = `nano-connect-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const event = {
    message: `nano-connect connectivity test ${marker}`,
    source_type: sourceType,
    nano_connect_test: true,
    nano_connect_marker: marker,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ingestToken}`,
        "X-Source-Type": sourceType,
      },
      // newline-delimited framing on the Vector http_server source.
      body: `${JSON.stringify(event)}\n`,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new NanoApiError(`Ingest request to ${endpoint} timed out`);
    }
    throw new NanoApiError(
      `Could not reach ingest endpoint ${endpoint}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new NanoApiError(
        "Ingest token rejected (401/403). Check VECTOR_AUTH_TOKEN matches this instance.",
        res.status,
        body,
      );
    }
    throw new NanoApiError(
      `Ingest endpoint returned ${res.status} ${res.statusText}`,
      res.status,
      body,
    );
  }

  return { marker };
}
