# @nano-rs/connect

> Get your logs into [nano](https://nano.rs) in minutes.

`connect` is a zero-install CLI that walks you through pointing real data at your nano SIEM. It
connects to your instance, stands up **edge Vector collectors** in your environment (syslog from
network devices, Windows Event Log + Sysmon, Linux journald + files), wires them to nano, deploys
matching parsers, and verifies that events actually arrive and become searchable — no MCP, no
Kubernetes, no hand-written config.

```bash
npx @nano-rs/connect
```

## Commands

| Command | What it does |
| --- | --- |
| `connect` | Connect + authenticate to your instance, then send a test event to prove ingestion works. |
| `connect add-source` | Generate a **syslog** collector — one listener port per source_type (Cisco ASA, PAN-OS, FortiGate, …). |
| `connect add-agent --os windows\|linux` | Generate an **endpoint agent** — Windows Event Log + Sysmon, or Linux journald + Sysmon-for-Linux + files. |
| `connect add-aggregator` | Generate an **aggregator** that fans endpoint agents (and syslog) into nano. |
| `connect verify --source <type>` | Check whether a source_type is arriving, and whether a parser actually normalized it. |
| `connect sync-parsers` | Refresh the community parser catalog (registers the official repo if there is none). |
| `connect list-sources` | List the built-in syslog source_types (what you pass to `--sources`). |

Every generator can `--run` to pull the Vector image and start the collector right there, and
`--deploy-parsers` to auto-deploy the matching community parser.

## The topology

```
endpoints (agents) ─┐
                    ├─→  your aggregator pool  ──→  nano
syslog devices ─────┘        (or straight to nano for small setups)
```

- **Agents** run on each endpoint and ship over the Vector-native protocol (acks + backpressure +
  disk buffer).
- The **aggregator** is the hub — receives agents on `:9000` and syslog devices on their ports,
  forwards to nano on `:6000`.
- Small setups can skip the aggregator: `add-agent --to-nano`.

## Quick start

```bash
# 1. Connect (reuses your self-hosted .env, or logs in and mints a scoped key)
npx @nano-rs/connect connect

# 2. Stand up a syslog collector for your firewalls and start it here
npx @nano-rs/connect list-sources          # which source_types are built in
npx @nano-rs/connect add-source --sources cisco_asa,palo_alto --run --deploy-parsers

# 3. Point your devices at <this-host>:5514, then confirm
npx @nano-rs/connect verify --source cisco_asa
```

For endpoints:

```bash
# An aggregator pool that agents ship into
npx @nano-rs/connect add-aggregator --run

# A Windows agent (Event Log + Sysmon), shipping to that aggregator
npx @nano-rs/connect add-agent --os windows --target aggregator.internal:9000

# A Linux agent (journald + Sysmon-for-Linux + /var/log/auth.log)
npx @nano-rs/connect add-agent --os linux --target aggregator.internal:9000
```

## What gets generated

Each generator writes ready-to-run artifacts under `./onboarding/<name>/`:

- `vector.toml` — selected sources active, the rest commented for easy expansion
- `docker-compose.yml` — run the collector as a container (or `--run` does it for you)
- `nano-collector.service` / `install-agent.ps1` — systemd unit (Linux) / signed-MSI installer (Windows)
- `README.md` — where to point your devices, and how to verify

## Parsers

When you onboard a source, `connect` checks your instance and tells you whether nano already parses
it, whether a [community parser](https://github.com/nano-rs/parsers) is available (and offers to
deploy it), or whether there's none yet.

That check is only as good as the catalog it reads. An instance with no parser repository
configured reports "no parser yet" for *everything*, which looks like nano doesn't support your
source when it simply hasn't pulled the list:

```bash
npx @nano-rs/connect sync-parsers
```

This registers the official `nano-rs/parsers` repository if none exists (prompting first — it
points your instance at a git source, so it needs `parser_repositories:manage`), then syncs it and
reports how many parsers are available. Run it on a fresh instance, or any time you want to pick up
newly contributed parsers. **A missing parser never blocks onboarding** — data still
flows and is searchable as generic logs; a parser just normalizes it into UDM fields for better
detection and dashboards. Build one in the platform's Parser Editor, with the
[nano-investigator MCP](https://github.com/nano-rs/nano-investigator), or contribute to
`nano-rs/parsers`.

## Auth

Two separate secrets, by design in nano:

| Secret | Used for | Where it comes from |
| --- | --- | --- |
| **API key** | the nano API (verify search, parser matching/deploy) | minted by `connect` (with the exact scopes shown first), or paste your own |
| **Ingest token** (`VECTOR_AUTH_TOKEN`) | authenticating logs sent to nano over `--transport http` | self-hosted `.env`; managed: app.nano.rs → your deployment → Credentials |

There is no `logs:ingest` API-key scope — ingestion is gated by the Vector token, not the API. The
token is never retrievable through the nano API, so `connect` can only get it from `--ingest-token`,
a discovered `.env`, your saved profile, or an interactive paste.

Deploying a community parser (`--deploy-parsers`) is a composite operation and needs a key that can
**create** a log source, **publish** the routing config, and **deploy** it. Syncing the catalog
needs **sync**, and registering a repository needs **manage**. `connect` requests all of these; an
account that can't grant them falls back to a read-only key and tells you which step is unavailable.

Two states worth distinguishing: a log source can exist *without* an active parser. `connect` says
so explicitly when an import succeeds but activation doesn't, because nano's UI will list the
source and it otherwise looks finished. Parsing also only applies to **newly ingested** events —
deploying a parser doesn't re-parse what's already stored.

## Transports

Every generator takes `--transport native|http` (default `native`). Both reach nano; they differ
in what protects the data.

| | `native` (default) | `http` |
| --- | --- | --- |
| Wire | Vector-to-Vector protobuf on `:6000` | NDJSON to `/ingest/` |
| Encryption | **TLS, always** | HTTPS |
| Authentication | none — the port accepts any client that can reach it | **ingest token** (bearer) |
| Delivery | acks + backpressure + disk buffer | disk buffer |
| Sinks | one for everything | **one per `source_type`** (see below) |

**Native is always TLS.** nano's managed listeners terminate TLS on `:6000`, so a plaintext sink
fails the handshake (`connection error: broken pipe`) and silently buffers to disk forever. There
is no flag to turn it off.

**Native is not authenticated.** TLS protects the data in transit, but anything that can reach the
port can also write to it. Use it on a trusted network or VPN — or use `--transport http`, which
authenticates every request with your ingest token.

**HTTP fans out per source_type.** nano routes on the `X-Source-Type` *request header*, not on any
`source_type` field in the body, and Vector's http sink headers are static per sink. So each
device type gets its own `[sinks.nano_<source_type>]` block. Add a device → add a sink. On the
aggregator, agent source types outside the known set land in `agent_route._unmatched` and are
**dropped** rather than mislabeled (Vector reports this as a config warning, by design).

With `--transport http`, the ingest token is written to a `.env` (mode 0600) beside the config and
read as `${VECTOR_AUTH_TOKEN}` — never inlined into `vector.toml`.

### mTLS (client certificates)

If your deployment requires a client certificate on the native port, **drop the bundle in the
directory you're running from** — `ca.crt`, `client.crt`, `client.key`. Every generator picks it up
automatically and tells you where it found it:

```
● Transport: Vector-native + TLS → nano.example.com:6000 (client certificate from /srv/onboarding)
```

Get the files from **app.nano.rs → your deployment → Credentials → Vector mTLS → Download bundle**.
That saves three separate files; keep those exact names. Use `--mtls-dir <dir>` if they live
somewhere else.

Keep the exact filenames and one deployment's bundle per directory. Browsers rename repeat
downloads to `client (1).crt`, so a downloads folder can end up holding bundles from several
deployments — `connect` won't guess between them, and it stops if the certificate belongs to a
different deployment than the one you're onboarding.

The bundle is copied into `tls/` inside the generated artifact and referenced from
`/etc/vector/tls` — the path docker-compose mounts it at, and the one the systemd instructions tell
you to copy it to. `client.key` is written `0600`. Your source directory is never mounted into the
container.

## Common flags

- `--url <baseUrl>` — your nano URL (defaults to your saved connection)
- `--api-key <key>` / `--env-file <path>` — auth without the interactive flow
- `--non-interactive` — for CI/scripts (fails instead of prompting)
- `--run` — pull the image and start the collector here
- `--deploy-parsers` — auto-deploy available community parsers
- `--sources a,b` (add-source / add-aggregator) — which source_types to collect
- `--target host:port` / `--to-nano` (add-agent) — where an agent ships
- `--transport native|http` — how the collector reaches nano (see [Transports](#transports))
- `--mtls-dir <dir>` — where to find the mTLS bundle (default: the directory you're running in)
- `--ingest-url <url>` / `--ingest-token <token>` — override what `--transport http` uses

## Development

```bash
pnpm install
pnpm dev          # run the CLI from source
pnpm typecheck
pnpm build        # bundle to dist/ via tsup
```

## License

Apache-2.0
