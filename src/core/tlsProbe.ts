import { isIP } from "node:net";
import { connect, type TLSSocket } from "node:tls";
import type { Target } from "./vector.js";

export type NativeTlsProbeResult =
  | { status: "ok" }
  | { status: "client-cert-required"; detail: string }
  | { status: "unreachable"; detail: string };

const PROBE_TIMEOUT_MS = 5000;
/**
 * A TLS 1.3 server that wants a client certificate can abort AFTER the handshake looks complete
 * from our side (certificate_required arrives as a post-handshake alert), so a successful
 * handshake only counts once this grace window passes without an alert.
 */
const POST_HANDSHAKE_GRACE_MS = 700;

/**
 * Handshake a Vector-native TLS port to learn whether the deployment enforces mTLS. Deployed
 * (managed) tenants reject a certificate-less handshake outright — and a collector generated
 * without the bundle starts cleanly, buffers to disk forever, and never delivers, which operators
 * experience as "no data in the UI" with no error anywhere. Server-certificate validity is
 * deliberately not judged here (self-hosted instances may be self-signed); the probe asks one
 * question: will the handshake we are about to configure ever succeed?
 *
 * Pass `clientCert` (PEM contents) to ask the same question WITH the operator's bundle.
 */
export function probeNativeTls(
  target: Target,
  clientCert?: { cert: string; key: string },
): Promise<NativeTlsProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => done({ status: "unreachable", detail: "timed out" }), PROBE_TIMEOUT_MS);
    function done(result: NativeTlsProbeResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      socket.destroy();
      resolve(result);
    }
    let socket: TLSSocket;
    try {
      socket = connect({
        host: target.host,
        port: target.port,
        // SNI is forbidden for IP literals (node throws on it).
        ...(isIP(target.host) === 0 ? { servername: target.host } : {}),
        rejectUnauthorized: false,
        ...(clientCert ?? {}),
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({ status: "unreachable", detail: err instanceof Error ? err.message : String(err) });
      return;
    }
    socket.on("secureConnect", () => {
      grace = setTimeout(() => done({ status: "ok" }), POST_HANDSHAKE_GRACE_MS);
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      const code = err.code ?? "";
      const raw = (err.message || String(err)).replace(/\s+/g, " ").trim();
      // OpenSSL error chains are long ("805EB…:error:0A000410:SSL routines:…:SSL alert number 40");
      // the last segment is the part a human needs.
      const detail = code.startsWith("ERR_SSL") ? (raw.split(":").pop()?.trim() ?? raw) : raw;
      // SSL alerts (alert 40 / certificate_required) are the mTLS-enforcement signature; some
      // fronts RST mid-handshake instead of alerting, so a reset counts too. Anything else —
      // refused, DNS, timeout — says nothing about certificates.
      if (code.startsWith("ERR_SSL") || code === "ECONNRESET" || /alert|handshake/i.test(detail)) {
        done({ status: "client-cert-required", detail });
      } else {
        done({ status: "unreachable", detail });
      }
    });
    socket.on("close", () => done({ status: "unreachable", detail: "connection closed during handshake" }));
  });
}
