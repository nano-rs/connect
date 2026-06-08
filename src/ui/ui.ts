import { cancel, isCancel } from "@clack/prompts";

/**
 * Unwrap a @clack/prompts result, exiting cleanly if the user cancelled (Ctrl-C / Esc).
 * Keeps the call sites readable: `const x = orExit(await text(...))`.
 */
export function orExit<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Cancelled. No changes were made.");
    process.exit(0);
  }
  return value as T;
}

/**
 * Mask a secret for display, showing only the last few characters. Uses a fixed-width mask so
 * the rendered string doesn't disclose the secret's exact length.
 */
export function maskSecret(secret: string, visible = 4): string {
  if (secret.length <= visible) return "•".repeat(8);
  return `${"•".repeat(8)}${secret.slice(-visible)}`;
}
