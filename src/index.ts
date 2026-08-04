import { Command, Option } from "commander";
import pc from "picocolors";
import pkg from "../package.json" with { type: "json" };
import { type AddAgentOptions, runAddAgent } from "./addAgent.js";
import { type AddAggregatorOptions, runAddAggregator } from "./addAggregator.js";
import { type AddSourceOptions, runAddSource } from "./addSource.js";
import { type ConnectOptions, runConnect } from "./flow.js";
import { NanoApiError } from "./core/types.js";
import { SYSLOG_CATALOG } from "./core/catalog.js";
import { runSyncParsers } from "./syncParsers.js";
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
  .option("--transport <mode>", "how the collector reaches nano: native (Vector-native + TLS) | http (HTTPS + ingest token)", "native")
  .option("--mtls-dir <dir>", "where to find the Vector mTLS bundle (default: the current directory — just drop ca.crt, client.crt, client.key in)")
  .option("--ingest-url <url>", "override the ingest endpoint used by --transport http")
  .option("--ingest-token <token>", "ingest token for --transport http (defaults to your saved connection)")
  .option("--sources <ids>", "comma-separated source_types to collect — see `connect list-sources` (e.g. cisco_asa,palo_alto)")
  .addOption(new Option("--devices <ids>", "deprecated alias for --sources").hideHelp())
  .option("--out-dir <dir>", "where to write the generated config (default ./onboarding/syslog)")
  .option("--run", "pull the image and start the collector here after generating")
  .option("--deploy-parsers", "auto-deploy available community parsers for your sources")
  .option("--non-interactive", "with no --sources, enable every source_type in the catalog instead of prompting")
  .action(async (raw: Record<string, unknown>) => {
    const opts: AddSourceOptions = {
      url: raw.url as string | undefined,
      apiKey: raw.apiKey as string | undefined,
      envFile: raw.envFile as string | undefined,
      vectorHost: raw.vectorHost as string | undefined,
      vectorPort: raw.vectorPort as string | undefined,
      transport: raw.transport as string | undefined,
      mtlsDir: raw.mtlsDir as string | undefined,
      ingestUrl: raw.ingestUrl as string | undefined,
      ingestToken: raw.ingestToken as string | undefined,
      sources: (raw.sources ?? raw.devices) as string | undefined,
      outDir: raw.outDir as string | undefined,
      run: Boolean(raw.run),
      deployParsers: Boolean(raw.deployParsers),
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
  .option("--transport <mode>", "how the agent reaches nano when using --to-nano: native (Vector-native + TLS) | http (HTTPS + ingest token)", "native")
  .option("--mtls-dir <dir>", "where to find the Vector mTLS bundle (default: the current directory — just drop ca.crt, client.crt, client.key in)")
  .option("--ingest-url <url>", "override the ingest endpoint used by --transport http")
  .option("--ingest-token <token>", "ingest token for --transport http (defaults to your saved connection)")

  .option("--no-journald", "(linux) don't collect journald")
  .option("--out-dir <dir>", "where to write the generated config (default ./onboarding/agent-<os>)")
  .option("--deploy-parsers", "auto-deploy available community parsers for this agent's sources")
  .option("--non-interactive", "fail instead of prompting when a required value is missing")
  .action(async (raw: Record<string, unknown>) => {
    const opts: AddAgentOptions = {
      url: raw.url as string | undefined,
      apiKey: raw.apiKey as string | undefined,
      envFile: raw.envFile as string | undefined,
      os: raw.os as string | undefined,
      target: raw.target as string | undefined,
      toNano: Boolean(raw.toNano),
      transport: raw.transport as string | undefined,
      mtlsDir: raw.mtlsDir as string | undefined,
      ingestUrl: raw.ingestUrl as string | undefined,
      ingestToken: raw.ingestToken as string | undefined,
      journald: raw.journald as boolean | undefined,
      outDir: raw.outDir as string | undefined,
      deployParsers: Boolean(raw.deployParsers),
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
  .option("--transport <mode>", "how the aggregator reaches nano: native (Vector-native + TLS) | http (HTTPS + ingest token)", "native")
  .option("--mtls-dir <dir>", "where to find the Vector mTLS bundle (default: the current directory — just drop ca.crt, client.crt, client.key in)")
  .option("--ingest-url <url>", "override the ingest endpoint used by --transport http")
  .option("--ingest-token <token>", "ingest token for --transport http (defaults to your saved connection)")

  .option("--sources <ids>", "comma-separated syslog source_types to also listen for — see `connect list-sources`")
  .addOption(new Option("--devices <ids>", "deprecated alias for --sources").hideHelp())
  .option("--out-dir <dir>", "where to write the generated config (default ./onboarding/aggregator)")
  .option("--run", "pull the image and start the aggregator here after generating")
  .option("--deploy-parsers", "auto-deploy available community parsers for the syslog sources")
  .option("--non-interactive", "skip prompts (no syslog listeners unless --sources is given)")
  .action(async (raw: Record<string, unknown>) => {
    const opts: AddAggregatorOptions = {
      url: raw.url as string | undefined,
      apiKey: raw.apiKey as string | undefined,
      envFile: raw.envFile as string | undefined,
      vectorHost: raw.vectorHost as string | undefined,
      vectorPort: raw.vectorPort as string | undefined,
      agentPort: raw.agentPort as string | undefined,
      transport: raw.transport as string | undefined,
      mtlsDir: raw.mtlsDir as string | undefined,
      ingestUrl: raw.ingestUrl as string | undefined,
      ingestToken: raw.ingestToken as string | undefined,
      sources: (raw.sources ?? raw.devices) as string | undefined,
      outDir: raw.outDir as string | undefined,
      run: Boolean(raw.run),
      deployParsers: Boolean(raw.deployParsers),
      nonInteractive: Boolean(raw.nonInteractive),
    };
    try {
      await runAddAggregator(opts);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("sync-parsers")
  .description("Refresh the community parser catalog (and register the official repo if there is none).")
  .option("--url <baseUrl>", "nano base URL (defaults to your saved connection)")
  .option("--api-key <key>", "nano API key (defaults to your saved connection)")
  .option("--env-file <path>", "path to a nano install .env to read connection details from")
  .option("--add-official", "register the official nano parsers repository without prompting")
  .option("--non-interactive", "fail instead of prompting when a required value is missing")
  .action(async (raw: Record<string, unknown>) => {
    try {
      await runSyncParsers({
        url: raw.url as string | undefined,
        apiKey: raw.apiKey as string | undefined,
        envFile: raw.envFile as string | undefined,
        addOfficial: Boolean(raw.addOfficial),
        nonInteractive: Boolean(raw.nonInteractive),
      });
    } catch (err) {
      fail(err);
    }
  });

program
  .command("list-sources")
  .alias("list-devices")
  .description("List the built-in syslog source_types you can pass to --sources.")
  .action(() => {
    console.log(
      `\n${pc.bold("Syslog source_types")} — pass these to ${pc.cyan("--sources")} on add-source / add-aggregator.\n` +
        `Each gets its own listener port so nano can tell the vendors apart.\n`,
    );
    const w = Math.max(...SYSLOG_CATALOG.map((d) => d.id.length));
    for (const d of SYSLOG_CATALOG) {
      console.log(
        `  ${pc.cyan(d.id.padEnd(w))}  ${String(d.port).padStart(5)}/${d.mode.padEnd(3)}  ${d.label}` +
          `${d.sourceType !== d.id ? pc.dim(`  (source_type ${d.sourceType})`) : ""}`,
      );
      if (d.note) console.log(`  ${" ".repeat(w)}  ${pc.dim(d.note)}`);
    }
    console.log(
      `\n${pc.dim("e.g.")}  connect add-source --sources ${SYSLOG_CATALOG.slice(0, 2).map((d) => d.id).join(",")}\n` +
        `${pc.dim("Not listed? Copy a block in the generated vector.toml and change id/port/mode/source_type.")}\n`,
    );
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
