import { Command } from "commander";
import pc from "picocolors";
import pkg from "../package.json" with { type: "json" };
import { type AddAgentOptions, runAddAgent } from "./addAgent.js";
import { type AddAggregatorOptions, runAddAggregator } from "./addAggregator.js";
import { type AddSourceOptions, runAddSource } from "./addSource.js";
import { type ConnectOptions, runConnect } from "./flow.js";
import { NanoApiError } from "./core/types.js";
import { type VerifyOptions, runVerify } from "./verifyCmd.js";

function fail(err: unknown): never {
  if (err instanceof NanoApiError) {
    console.error(pc.red(`\n✖ ${err.message}`));
    if (err.body) console.error(pc.dim(err.body.slice(0, 500)));
  } else {
    console.error(pc.red(`\n✖ ${err instanceof Error ? err.message : String(err)}`));
  }
  process.exit(1);
}

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
      fail(err);
    }
  });

program
  .command("add-source")
  .description("Generate an edge Vector collector config for a log source (syslog).")
  .option("--url <baseUrl>", "nano base URL (defaults to your saved connection)")
  .option("--api-key <key>", "nano API key (defaults to your saved connection)")
  .option("--env-file <path>", "path to a nano install .env to read connection details from")
  .option("--vector-host <host>", "nano Vector-native host (defaults to the nano URL's host)")
  .option("--vector-port <port>", "nano Vector-native port (default 6000)")
  .option("--devices <ids>", "comma-separated device ids to enable (e.g. cisco_asa,fortinet_fortigate)")
  .option("--out-dir <dir>", "where to write the generated config (default ./onboarding/syslog)")
  .option("--run", "pull the image and start the collector here after generating")
  .option("--non-interactive", "with no --devices, enable all catalog devices instead of prompting")
  .action(async (raw: Record<string, unknown>) => {
    const opts: AddSourceOptions = {
      url: raw.url as string | undefined,
      apiKey: raw.apiKey as string | undefined,
      envFile: raw.envFile as string | undefined,
      vectorHost: raw.vectorHost as string | undefined,
      vectorPort: raw.vectorPort as string | undefined,
      devices: raw.devices as string | undefined,
      outDir: raw.outDir as string | undefined,
      run: Boolean(raw.run),
      nonInteractive: Boolean(raw.nonInteractive),
    };
    try {
      await runAddSource(opts);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("add-agent")
  .description("Generate an endpoint agent (Windows Event Log / Linux journald+files) that ships to an aggregator or nano.")
  .option("--url <baseUrl>", "nano base URL (defaults to your saved connection)")
  .option("--api-key <key>", "nano API key (defaults to your saved connection)")
  .option("--env-file <path>", "path to a nano install .env to read connection details from")
  .option("--os <os>", "endpoint OS: windows | linux")
  .option("--target <host:port>", "where the agent ships (an aggregator), default port 9000")
  .option("--to-nano", "ship straight to nano (:6000) instead of an aggregator")
  .option("--no-journald", "(linux) don't collect journald")
  .option("--out-dir <dir>", "where to write the generated config (default ./onboarding/agent-<os>)")
  .option("--non-interactive", "fail instead of prompting when a required value is missing")
  .action(async (raw: Record<string, unknown>) => {
    const opts: AddAgentOptions = {
      url: raw.url as string | undefined,
      apiKey: raw.apiKey as string | undefined,
      envFile: raw.envFile as string | undefined,
      os: raw.os as string | undefined,
      target: raw.target as string | undefined,
      toNano: Boolean(raw.toNano),
      journald: raw.journald as boolean | undefined,
      outDir: raw.outDir as string | undefined,
      nonInteractive: Boolean(raw.nonInteractive),
    };
    try {
      await runAddAgent(opts);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("add-aggregator")
  .description("Generate the aggregator config: receives endpoint agents + syslog, ships to nano.")
  .option("--url <baseUrl>", "nano base URL (defaults to your saved connection)")
  .option("--api-key <key>", "nano API key (defaults to your saved connection)")
  .option("--env-file <path>", "path to a nano install .env to read connection details from")
  .option("--vector-host <host>", "nano Vector-native host (defaults to the nano URL's host)")
  .option("--vector-port <port>", "nano Vector-native port (default 6000)")
  .option("--agent-port <port>", "port endpoint agents ship to (default 9000)")
  .option("--devices <ids>", "comma-separated syslog device ids to also listen for")
  .option("--out-dir <dir>", "where to write the generated config (default ./onboarding/aggregator)")
  .option("--run", "pull the image and start the aggregator here after generating")
  .option("--non-interactive", "skip prompts (no syslog devices unless --devices given)")
  .action(async (raw: Record<string, unknown>) => {
    const opts: AddAggregatorOptions = {
      url: raw.url as string | undefined,
      apiKey: raw.apiKey as string | undefined,
      envFile: raw.envFile as string | undefined,
      vectorHost: raw.vectorHost as string | undefined,
      vectorPort: raw.vectorPort as string | undefined,
      agentPort: raw.agentPort as string | undefined,
      devices: raw.devices as string | undefined,
      outDir: raw.outDir as string | undefined,
      run: Boolean(raw.run),
      nonInteractive: Boolean(raw.nonInteractive),
    };
    try {
      await runAddAggregator(opts);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("verify")
  .description("Check whether events of a source_type are arriving and searchable in nano.")
  .option("--url <baseUrl>", "nano base URL (defaults to your saved connection)")
  .option("--api-key <key>", "nano API key (defaults to your saved connection)")
  .option("--search-url <url>", "override the search endpoint (split deployments)")
  .option("--env-file <path>", "path to a nano install .env to read connection details from")
  .option("--source <source_type>", "the source_type to check for (e.g. cisco_asa)")
  .option("--window <minutes>", "how far back to look, in minutes (default 15)")
  .action(async (raw: Record<string, unknown>) => {
    const opts: VerifyOptions = {
      url: raw.url as string | undefined,
      apiKey: raw.apiKey as string | undefined,
      searchUrl: raw.searchUrl as string | undefined,
      envFile: raw.envFile as string | undefined,
      source: raw.source as string | undefined,
      window: raw.window as string | undefined,
    };
    try {
      await runVerify(opts);
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync(process.argv).catch(fail);
