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
| `connect add-source` | Generate a **syslog** collector — one listener port per device type (Cisco ASA, PAN-OS, FortiGate, …). |
| `connect add-agent --os windows\|linux` | Generate an **endpoint agent** — Windows Event Log + Sysmon, or Linux journald + Sysmon-for-Linux + files. |
| `connect add-aggregator` | Generate an **aggregator** that fans endpoint agents (and syslog) into nano. |
| `connect verify --source <type>` | Check whether a source_type is arriving and normalized. |

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
npx @nano-rs/connect add-source --devices cisco_asa,palo_alto --run --deploy-parsers

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
deploy it), or whether there's none yet. **A missing parser never blocks onboarding** — data still
flows and is searchable as generic logs; a parser just normalizes it into UDM fields for better
detection and dashboards. Build one in the platform's Parser Editor, with the
[nano-investigator MCP](https://github.com/nano-rs/nano-investigator), or contribute to
`nano-rs/parsers`.

## Auth

Two separate secrets, by design in nano:

| Secret | Used for | Where it comes from |
| --- | --- | --- |
| **API key** | the nano API (verify search, parser matching/deploy) | minted by `connect` (with the exact scopes shown first), or paste your own |
| **Ingest token** (`VECTOR_AUTH_TOKEN`) | authenticating logs sent to nano | self-hosted `.env`, or your admin console |

There is no `logs:ingest` API-key scope — ingestion is gated by the Vector token, not the API.

## Transports

`connect` forwards from your edge to nano over:

- **Vector-native** (`:6000`) — protobuf, acks, backpressure, disk buffer. Best on a trusted
  network or VPN (the native port is unauthenticated).
- **HTTPS** — the `connect` smoke test auto-detects your ingest endpoint (open-core `:8080`,
  cheaper-plan `/ingest`, or a dedicated `ingest-<sub>.nano.rs` host).

## Common flags

- `--url <baseUrl>` — your nano URL (defaults to your saved connection)
- `--api-key <key>` / `--env-file <path>` — auth without the interactive flow
- `--non-interactive` — for CI/scripts (fails instead of prompting)
- `--run` — pull the image and start the collector here
- `--deploy-parsers` — auto-deploy available community parsers
- `--devices a,b` (add-source) / `--target host:port` / `--to-nano` (add-agent)

## Development

```bash
pnpm install
pnpm dev          # run the CLI from source
pnpm typecheck
pnpm build        # bundle to dist/ via tsup
```

## License

Apache-2.0
