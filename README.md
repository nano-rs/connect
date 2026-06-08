# @nano-rs/connect

> Get your logs into [nano](https://nano.rs) in minutes.

`connect` is a zero-install CLI that walks you through pointing real data at your nano SIEM. It
connects to your instance, helps you stand up an **edge Vector collector** in your environment
(syslog from network devices, Windows Event Log, files, journald), and verifies that events are
actually arriving and queryable — no MCP, no Kubernetes, no guesswork.

```bash
npx @nano-rs/connect
```

## What it does

1. **Connects** to your nano instance — reuses your self-hosted `.env` automatically, or mints a
   scoped API key for you (it shows exactly which permissions it requests first).
2. **Verifies the path** — sends a test event and confirms it becomes searchable, so you know
   ingestion works before you wire up anything real.
3. **Sets up a collector** *(in progress)* — generates ready-to-run Vector config + Docker Compose
   / systemd artifacts for your log sources, and tells your devices where to point.
4. **Confirms data is flowing** — polls search after each source so you see green, not silence.

## Status

Early. The connect-and-verify spine is in place; collector generation (syslog → Windows → files)
is landing next. Tracked in NAN-1320.

## How auth works

Two separate secrets, by design in nano:

| Secret | Used for | Where it comes from |
| --- | --- | --- |
| **API key** | talking to the nano API (verify search, parser matching) | minted by `connect`, or paste your own |
| **Ingest token** (`VECTOR_AUTH_TOKEN`) | authenticating logs sent to nano | self-hosted `.env`, or your admin console |

There is no `logs:ingest` API-key scope — ingestion is gated by the Vector token, not the API.

## Transports

`connect` forwards from your edge to nano over one of:

- **HTTPS** (`/ingest`, Bearer-authenticated) — recommended for SaaS / over the internet.
- **Vector-native** (`:6000`) — richer/pre-structured, recommended on a trusted network or VPN.

## Development

```bash
pnpm install
pnpm dev          # run the CLI from source
pnpm typecheck
pnpm build        # bundle to dist/ via tsup
```

## License

Apache-2.0
