import { Command } from "commander";
import pc from "picocolors";
import pkg from "../package.json" with { type: "json" };
import { type ConnectOptions, runConnect } from "./flow.js";
import { NanoApiError } from "./core/types.js";

const program = new Command();

program
  .name("connect")
  .description(
    "Onboard a data source into nano — connect to your instance, then set up an edge\nVector collector and verify your logs are flowing.",
  )
  .version(pkg.version, "-v, --version");

program
  .command("connect", { isDefault: true })
  .description("Interactive onboarding: connect to nano and verify ingestion.")
  .option("--url <baseUrl>", "nano base URL (e.g. https://nano.example.com)")
  .option("--api-key <key>", "nano API key (skip interactive auth)")
  .option("--env-file <path>", "path to a nano install .env to read connection details from")
  .option("--search-url <url>", "override the search endpoint (split deployments, e.g. http://host:3002/api/search)")
  .option("--ingest-url <url>", "override the ingest endpoint (split deployments, e.g. http://host:8080/)")
  .option("--ingest-token <token>", "ingest token (VECTOR_AUTH_TOKEN); otherwise read from .env or prompted")
  .option("--non-interactive", "fail instead of prompting when a required value is missing")
  .action(async (raw: Record<string, unknown>) => {
    const opts: ConnectOptions = {
      url: raw.url as string | undefined,
      apiKey: raw.apiKey as string | undefined,
      envFile: raw.envFile as string | undefined,
      searchUrl: raw.searchUrl as string | undefined,
      ingestUrl: raw.ingestUrl as string | undefined,
      ingestToken: raw.ingestToken as string | undefined,
      nonInteractive: Boolean(raw.nonInteractive),
    };
    try {
      await runConnect(opts);
    } catch (err) {
      if (err instanceof NanoApiError) {
        console.error(pc.red(`\n✖ ${err.message}`));
        if (err.body) console.error(pc.dim(err.body.slice(0, 500)));
      } else {
        console.error(pc.red(`\n✖ ${err instanceof Error ? err.message : String(err)}`));
      }
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(pc.red(`\n✖ ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
