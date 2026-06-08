import { isInsecureRemote } from "./endpoints.js";
import { NanoApiError } from "./types.js";
import type { Target } from "./vector.js";

/** Permitted characters for a hostname/IP that gets interpolated into a generated config. */
export const HOST_RE = /^[A-Za-z0-9._\-:[\]]+$/;
/** Permitted characters for a Vector component id / source_type we interpolate into TOML + VRL. */
export const ID_RE = /^[A-Za-z0-9_]+$/;

export function validatePort(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new NanoApiError(`Invalid ${label}: ${value}`);
  }
  return value;
}

export function validateHost(host: string, flag: string): void {
  if (!HOST_RE.test(host)) {
    throw new NanoApiError(`Invalid ${flag} "${host}" (expected a hostname or IP).`);
  }
}

/**
 * Parse "host" or "host:port" into a validated Target. Handles [ipv6] and [ipv6]:port, and treats
 * a bare (unbracketed) IPv6 literal as a whole host rather than splitting it at its last colon.
 */
export function parseHostPort(input: string, defaultPort: number): Target {
  const s = input.trim();
  let host: string;
  let port: number;
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end === -1) throw new NanoApiError(`Invalid target "${input}" (unbalanced brackets).`);
    host = s.slice(1, end);
    const rest = s.slice(end + 1);
    port = rest.startsWith(":") ? Number(rest.slice(1)) : defaultPort;
  } else {
    const idx = s.lastIndexOf(":");
    // No colon, or more than one (a bare IPv6) → the whole string is the host.
    if (idx === -1 || s.indexOf(":") !== idx) {
      host = s;
      port = defaultPort;
    } else {
      host = s.slice(0, idx);
      port = Number(s.slice(idx + 1));
    }
  }
  if (!host) throw new NanoApiError(`Invalid target "${input}" (missing host).`);
  validatePort(port, `port in "${input}"`);
  return { host, port };
}

/**
 * Returns a warning if forwarding to nano's unauthenticated Vector-native port would cross an
 * untrusted boundary (https/SaaS or plain-http remote), else null.
 */
export function unauthenticatedVectorWarning(baseUrl: string, host: string, port: number): string | null {
  let isHttps = false;
  try {
    isHttps = new URL(baseUrl).protocol === "https:";
  } catch {
    /* ignore */
  }
  if (isHttps || isInsecureRemote(baseUrl)) {
    return `nano's Vector-native port (${host}:${port}) has no auth — only forward to it over a trusted network or VPN. If nano is remote/SaaS, that port may not be reachable; use the HTTPS path or a private link.`;
  }
  return null;
}
