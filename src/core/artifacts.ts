import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface WriteArtifactsOptions {
  /**
   * Filenames whose contents are secret (e.g. the ingest-token .env). Written 0600 with an
   * explicit chmod, because writeFileSync's mode only applies when it creates the file — a
   * re-run over an existing world-readable file would otherwise keep the loose mode.
   */
  secretFiles?: string[];
}

/** Write a set of generated files into a directory, returning their absolute paths. */
export function writeArtifacts(
  dir: string,
  files: Record<string, string>,
  opts: WriteArtifactsOptions = {},
): string[] {
  const target = resolve(dir);
  mkdirSync(target, { recursive: true });
  const secret = new Set(opts.secretFiles ?? []);
  const written: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(target, name);
    // Names may be nested (e.g. "tls/client.key").
    mkdirSync(dirname(path), { recursive: true });
    if (secret.has(name)) {
      writeFileSync(path, content, { mode: 0o600 });
      chmodSync(path, 0o600);
    } else {
      writeFileSync(path, content);
    }
    written.push(path);
  }
  return written;
}
