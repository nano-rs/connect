import { confirm, log } from "@clack/prompts";
import pc from "picocolors";
import { composeUp, dockerAvailable, waitHealthy } from "./core/deploy.js";
import { orExit } from "./ui/ui.js";

export interface RunHereOptions {
  dir: string;
  container: string;
  /** Explicit --run (skips the prompt). */
  run?: boolean;
  nonInteractive?: boolean;
}

/** "not-started" covers declined / Docker unavailable — the config is written either way. */
export type RunHereOutcome = "started" | "start-failed" | "not-started";

/**
 * Offer to pull the image and start the generated collector right here (docker compose), then
 * confirm it's healthy. Degrades gracefully when Docker is absent — the config is already written.
 * The outcome lets callers close with an honest outro instead of an unconditional "ready".
 */
export async function maybeRunHere(opts: RunHereOptions): Promise<RunHereOutcome> {
  let go = opts.run ?? false;
  if (!opts.run && !opts.nonInteractive) {
    go = orExit(
      await confirm({
        message: "Run it here now? (pulls the image and starts the collector)",
        initialValue: true,
      }),
    );
  }
  if (!go) return "not-started";

  const docker = await dockerAvailable();
  if (!docker.ok) {
    log.warn(`${docker.reason} Skipping start — run \`docker compose up -d\` in ${opts.dir} when ready.`);
    return "not-started";
  }

  log.step(pc.dim("Pulling image and starting the container…"));
  const code = await composeUp(opts.dir);
  if (code !== 0) {
    log.error(
      `docker compose exited ${code} — see its output above for the cause. Fix it, then re-run \`docker compose up -d\` in ${opts.dir}.`,
    );
    return "start-failed";
  }

  const health = await waitHealthy(opts.container);
  if (health === "healthy" || health === "no-healthcheck") {
    log.success(pc.green(`${opts.container} is running.`));
  } else if (health === "missing") {
    log.warn(`Started, but couldn't find a container named ${opts.container} to health-check. Inspect: docker compose -f ${opts.dir}/docker-compose.yml ps`);
  } else {
    log.warn(`${opts.container} started but health is "${health}" after waiting. Inspect: docker logs ${opts.container}`);
  }
  return "started";
}
