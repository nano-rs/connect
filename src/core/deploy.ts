import { spawn } from "node:child_process";
import { join } from "node:path";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command, capturing output. Never throws — inspect `code`. */
function run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => resolve({ code: 127, stdout, stderr }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Run a command with the user's terminal attached (so they see docker's pull/up progress). */
function runInherit(cmd: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export interface DockerStatus {
  ok: boolean;
  reason?: string;
}

/** Check Docker Engine + Compose v2 are usable before we try to deploy. */
export async function dockerAvailable(): Promise<DockerStatus> {
  const engine = await run("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (engine.code === 127) return { ok: false, reason: "Docker isn't installed (or not on PATH)." };
  if (engine.code !== 0) return { ok: false, reason: "Docker is installed but the daemon isn't reachable — is it running?" };
  const compose = await run("docker", ["compose", "version"]);
  if (compose.code !== 0) return { ok: false, reason: "Docker Compose v2 isn't available (need `docker compose`)." };
  return { ok: true };
}

/** `docker compose pull` then `up -d` in `dir`, with progress shown to the user. */
export async function composeUp(dir: string): Promise<number> {
  const file = join(dir, "docker-compose.yml");
  const pull = await runInherit("docker", ["compose", "-f", file, "pull"], dir);
  if (pull !== 0) return pull;
  return runInherit("docker", ["compose", "-f", file, "up", "-d"], dir);
}

/**
 * Poll a container's healthcheck until it reports healthy (or we give up). Returns the final
 * state: "healthy", "unhealthy", "starting", "no-healthcheck", or "missing".
 */
export async function waitHealthy(container: string, timeoutMs = 45_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "missing";
  while (Date.now() < deadline) {
    const res = await run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}", container]);
    if (res.code !== 0) {
      last = "missing";
    } else {
      last = res.stdout.trim() || "missing";
      if (last === "healthy" || last === "no-healthcheck") return last;
      if (last === "unhealthy") return last;
    }
    await sleep(2_000);
  }
  return last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
