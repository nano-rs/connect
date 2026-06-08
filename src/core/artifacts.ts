import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Write a set of generated files into a directory, returning their absolute paths. */
export function writeArtifacts(dir: string, files: Record<string, string>): string[] {
  const target = resolve(dir);
  mkdirSync(target, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(target, name);
    writeFileSync(path, content);
    written.push(path);
  }
  return written;
}
