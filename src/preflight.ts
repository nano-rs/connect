import { readFileSync } from "node:fs";
import { log } from "@clack/prompts";
import pc from "picocolors";
import { unauthenticatedVectorWarning } from "./core/target.js";
import { probeNativeTls } from "./core/tlsProbe.js";
import { NanoApiError } from "./core/types.js";
import type { NanoUplink } from "./core/uplink.js";

/**
 * Probe a Vector-native uplink before generating anything, so a handshake that can never succeed
 * fails HERE — with instructions — instead of shipping a collector that buffers silently forever.
 * Deployed tenants require the deployment's mTLS client certificate on this port; without
 * --mtls-dir the old behavior was a clean-looking setup and then "no data in the UI".
 */
export async function preflightNativeUplink(uplink: NanoUplink, baseUrl: string): Promise<void> {
  if (uplink.transport !== "native" || !uplink.tls.enabled) return;
  const where = `${uplink.target.host}:${uplink.target.port}`;

  if (uplink.mtlsSource) {
    const probe = await probeNativeTls(uplink.target, {
      cert: readFileSync(uplink.mtlsSource.crt, "utf8"),
      key: readFileSync(uplink.mtlsSource.key, "utf8"),
    });
    if (probe.status === "ok") {
      log.info(`${where} accepted your mTLS client certificate.`);
    } else if (probe.status === "client-cert-required") {
      // The bundle is present but the server still refused the handshake — almost always a
      // bundle from a different deployment. Warn rather than fail: the check happens from THIS
      // machine and generation may be for another.
      log.warn(
        `${where} rejected the handshake even WITH your client certificate (${probe.detail}). ` +
          `Check the bundle is from THIS deployment (app.nano.rs → your deployment → Credentials → Vector mTLS).`,
      );
    } else {
      log.warn(`Couldn't reach ${where} from this machine (${probe.detail}) — skipping the mTLS check. The collector may still reach it.`);
    }
    return;
  }

  const probe = await probeNativeTls(uplink.target);
  if (probe.status === "client-cert-required") {
    throw new NanoApiError(
      `${where} rejected the TLS handshake (${probe.detail}) — this deployment requires an mTLS client ` +
        `certificate, and a collector generated without one would buffer forever and never deliver. ` +
        `Download the bundle (app.nano.rs → your deployment → Credentials → Vector mTLS → Download bundle) ` +
        `and re-run with --mtls-dir <folder>, or use --transport http (token-authenticated HTTPS).`,
    );
  }
  if (probe.status === "unreachable") {
    log.warn(
      `Couldn't reach ${where} from this machine (${probe.detail}) — can't check whether it requires an ` +
        `mTLS client certificate. If this is a deployed tenant it almost certainly does: pass ` +
        `${pc.cyan("--mtls-dir <bundle-folder>")} or use ${pc.cyan("--transport http")}. Continuing.`,
    );
    return;
  }
  // Handshake succeeded with no client certificate — the port is genuinely open to anyone.
  const warning = unauthenticatedVectorWarning(baseUrl, uplink.target.host, uplink.target.port);
  if (warning) log.warn(warning);
}
