# nano connect

`connect.sh` onboards data sources into nano. It generates local Vector
collectors (syslog listeners, Linux journald/file agents, Windows Event Log and
Sysmon agents, an aggregator), issues one ingest token per source, and proves
that events land and are searchable under the right source.

It works the same way on every nano deployment: open core, enterprise
self-hosted (sovereign), BYOC and Civo. They all expose the same Log Sources,
ingest-token, parser-registry and search APIs. The only difference the client
cares about is **where events are sent** (see [Ingest destinations](#ingest-destinations)).

It needs Bash 3.2+, curl and standard Unix tools. jq is optional; Node and npm
are not used.

```bash
curl -fsSL https://github.com/nano-rs/connect/releases/latest/download/connect.sh -o connect.sh
bash connect.sh --version
```

For automation, download `connect.sh` and `connect.sh.sha256` from the **same
versioned release** and run `sha256sum --check connect.sh.sha256` before
executing it.

## Quick start

```bash
export NANO_URL=https://nano.example.com      # the nano app
# Supply an administrator API key through your secret manager as NANO_API_KEY,
# or set NANO_EMAIL (and NANO_PASSWORD) to sign in and mint a scoped key.

bash connect.sh list-sources                                   # instance sources + parser registry
bash connect.sh add-source --sources cisco_asa,palo_alto:tcp --deploy-parsers --non-interactive
bash connect.sh add-agent --os linux --files /var/log/app/*.log --file-source myapp --non-interactive
bash connect.sh add-agent --os windows --non-interactive
bash connect.sh add-aggregator --sources cisco_asa --non-interactive
bash connect.sh connect --source cisco_asa --non-interactive   # send a marker, find it in search
bash connect.sh verify --source cisco_asa --non-interactive    # fresh events under the source
```

Generation writes artifacts under `./onboarding/<command>` (`--out-dir` picks
another directory) and starts nothing. `--run` pulls and starts a syslog
collector or aggregator with Docker Compose on this host and waits for it to be
healthy. Agents are installed on the endpoint: run the generated
`install-agent.ps1` as Administrator on Windows, or install Vector and the
generated `nano-collector.service` on Linux. The client never runs an installer.

## How it maps onto nano

| Step | API |
|---|---|
| Discover sources and tokens | `GET /api/ingest-tokens` (`sources`: every push-capable Log Source a token can bind to, with its `route_key`) |
| Issue / bind / rotate / revoke a token | `POST /api/ingest-tokens`, `/{id}/bind`, `/{id}/revoke` |
| Find the ingest destination | `GET /api/log-sources/ingest-endpoint`, `GET /api/capabilities` (edition) |
| Parser catalog | `GET /api/parser-repositories`, `GET /api/parser-repositories/{id}/parsers` (the instance registry: `nano-rs/parsers`, OCSF on `main`) |
| Add a missing source | `POST /api/parser-repositories/{id}/parsers/import/{path}` then `POST /api/log-sources/{id}/publish` (only with `--deploy-parsers` or a confirmed prompt) |
| Verify | `POST /api/search` with `metadata.log_source="<source>"` over the last `--window` minutes |

A source in nano is a Log Source. Its `route_key` (the parser's first match
value, else its name) is the name you pass to `--sources`, and the value events
carry in `metadata.log_source`. Any match value of a registry parser works as an
alias: `--sources mikrotik` resolves to the `routeros` parser.

## Ingest destinations

Enterprise deployments (enterprise self-hosted, Kubernetes, BYOC, Civo) run a
**dedicated ingest frontend on its own hostname**, for example
`https://ingest.example.com`, so ingest load cannot affect the app. Only open
core serves `/ingest` on the same host as the app.

The client resolves the destination in this order:

1. `--ingest-url URL` (`NANO_INGEST_URL`): the exact URL for the chosen
   transport (the HTTP `/ingest` URL, or an HEC base URL).
2. `--ingest-base ORIGIN` (`NANO_INGEST_BASE`): the ingest frontend's origin.
   HTTP posts to `<origin>/ingest`, OTLP to `<origin>/otlp`, HEC to the
   instance's HEC port on that host (8088 when the instance doesn't say).
3. The instance's configured ingest base (`NANO_INGEST_PUBLIC_BASE_URL`, read
   from `GET /api/log-sources/ingest-endpoint`). When it differs from the app
   URL it is used as the dedicated frontend.
4. The app host's `/ingest` (and the instance's HEC listener on the app host),
   only when the instance reports no dedicated base. On an enterprise instance
   the client says so, so you can pass `--ingest-base`.

When the ingest-endpoint API can't be read (`log_sources:view` missing) on an
enterprise instance, the client stops and asks for `--ingest-base`; open core
falls back to the app host.

**Events are never sent to the app host while a dedicated ingest base is
configured.** An `--ingest-url` or `--ingest-base` that points at the app host
on such an instance is refused. Explicit destinations are saved per instance
(and transport, for `--ingest-url`); a destination given on the command line
replaces saved ones. Discovered destinations are read again on every run, so
configuring an ingest frontend later takes effect on the next run.

```bash
# BYOC / Civo / enterprise: app and ingest on separate hostnames.
bash connect.sh add-source --url https://nano.example.com \
  --ingest-base https://ingest.example.com --sources cisco_asa --non-interactive
# A HEC listener behind its own load balancer:
bash connect.sh add-source --sources cisco_asa --transport hec --ingest-url https://hec.example.com --non-interactive
```

## Transports

The collector's upstream is HTTP (default) or HEC. Both authenticate with the
source's ingest token and carry the original log line unchanged:

- **HTTP** (`--transport http`, the default): newline-delimited `text/plain` to
  `<ingest>/ingest` with `Authorization: Bearer <token>`, with a disk buffer.
  This goes through the ingest edge, which terminates TLS like the app.
- **HEC** (`--transport hec`): Vector's `splunk_hec_logs` sink to the instance's
  HEC listener (`:8088` by default, plain HTTP unless the deployment terminates
  TLS in front of it), with gzip and a disk buffer. The token goes in
  `Authorization: Splunk <token>`.

HTTP is the default since 0.5.0. On the current ClickHouse build, events sent over
HEC to a source whose parser does not set its own `metadata.log_source` (the
generic `syslog` and `json_generic` parsers) are stored under `unknown` (OTLP
logs to such a source too), and
HEC indexer acknowledgements are refused (the collector falls back to the HTTP
200). Use HEC for sources with a vendor parser, or once those are fixed.

The token decides where an event is stored. A sender that claims another
sourcetype is still stored under the token's source; the claim is kept only as
`claimed_source_type`.

The local side of a syslog collector is one listener per source: UDP/TCP syslog
for network devices (`--sources pfsense:tcp` picks the mode), or an HTTP push
listener (`:http`) for application sources. Built-in sources keep their usual
ports (`list-sources --builtin-only`); other sources get a stable port derived
from the name in 5600–5699. Listeners have no local authentication: keep them on
a trusted network.

`--target host:9000` on `add-agent` generates an offline agent that forwards to a
trusted aggregator over the Vector protocol, without API credentials. That hop
has no token authentication; use it only on a private network. There is no
direct Vector-native uplink to nano.

## Ingest tokens

Each source gets its own named ingest token (`nit_…`), bound to that source when
it is issued. Bindings never change. Tokens are stored per instance in
`$XDG_CONFIG_HOME/nano-connect-bash` (default `~/.config/nano-connect-bash`,
0700 directories, 0600 files) and reused on later runs. Each collector gets a
`secrets/` directory read by Vector's secret backend; tokens never appear in
`vector.toml` or on the terminal.

- `--token-dir DIR`: use existing tokens, one file per source name. An unbound
  token is bound to the source; a token bound to another source, or revoked, is
  refused.
- `rotate-token --source S --out-dir DIR`: issue a replacement, save it (profile
  and the collector's `secrets/`) and only then revoke the old token. Reload the
  collector afterwards. An interrupted revocation is retried on the next run.
- `revoke-token --source S`: revoke the token the client issued for the source.
  Vector refuses it within seconds.

If the deployment has no token delivery to Vector (`NANO_INGEST_TOKENS_DELIVERY`
unset), nano refuses to issue tokens and the client stops before trying.

### Permissions

| Action | Permission |
|---|---|
| Discover sources, tokens and the ingest endpoint | `log_sources:view` |
| Issue, bind, rotate, revoke tokens | `settings:system` |
| Import and publish a registry parser (`--deploy-parsers`) | `parser_repositories:import`, `log_sources:create`, `source_configs:edit`, `log_sources:deploy` |
| Sync parser repositories | `parser_repositories:sync` (`:manage` to register the official repository) |
| `connect` and `verify` | `search:execute`, plus visibility of the source |

Signing in with `NANO_EMAIL` creates an API key named `nano-connect` with these
permissions after you confirm.

## Parsers

`list-sources` shows the instance's bindable sources and the syslog-collectable
parsers in the instance's parser registry. The registry is `nano-rs/parsers`,
synced by the instance (OCSF content on `main`). When you select a source that
isn't a Log Source yet, `--deploy-parsers` (or the confirmation prompt) imports
the registry parser and publishes it, then binds a token to the new source.
`sync-parsers` refreshes the registry (`--add-official` registers
`nano-rs/parsers` when no repository exists).

A parser declares how its data arrives with `transports:` in its YAML; the
client offers only syslog-capable parsers for a syslog listener. Sources that
are already enabled on the instance are connectable whatever their transport
(they get an HTTP push listener by default).

## Verifying delivery

- `connect --source S` sends one marker event with the source's token and waits
  until search finds it under `metadata.log_source="S"`. It tests nano's ingest
  path, not your device-to-collector hop.
- `verify --source S` searches `metadata.log_source="S"` over the last
  `--window` minutes (15) and reports how many fresh events arrived and how many
  were normalized, unparsed or failed to parse. It exits nonzero when there are
  none.
- `verify --evidence-file FILE --wait-seconds 120` checks one marker per real
  request sent through a collector. The file has one `source marker` pair per
  line; markers are 8–128 letters, digits, `_` or `-`, distinct per request.
  Each marker must be found under its source within the deadline.

In Search, `metadata.log_source="cisco_asa" | stats count by class_name` shows
how events were mapped.

## OTLP

`otlp-config --source S` writes a private `otel.env` for an OTLP/HTTP exporter:
`OTEL_EXPORTER_OTLP_ENDPOINT=<ingest>/otlp` with the source's Bearer token. The
ingest edge authenticates every request against the token and stores the logs
under its source. Use one exporter configuration per source.

## Other details

- `--yes` accepts prompts with non-interactive defaults (including parser import
  and key creation); `--non-interactive` fails on a missing value without
  authorizing anything. Every prompt has a flag or environment equivalent
  (`--help`).
- `--env-file FILE` reads only `BASE_URL`; the file is never executed.
- Without jq, the client extracts the known JSON fields with narrow awk
  parsers and fails closed on `\u` escapes in requested fields.
- Collector images pin upstream Vector 0.59.0 by digest.
- HEC connectivity tests send a private, persisted UUID request channel per
  source.
- The Linux agent sends each journald entry as a `journalctl -o json` object
  (what the OCSF journald parser reads) and starts from the current end of the
  journal on first start; Sysmon for Linux entries keep their raw XML message.
  The Windows agent sends each event as JSON, as before.

### Upgrading from 0.4.x

0.5.0 targets the ClickHouse product and removes the lake hosted model:
`--token-file`, `--credential-id` and the hosted Direct-credential import are
gone (use `--token-dir`, or let the client issue tokens), there are no
tenant-prefixed URLs, HTTP collectors always send raw text, and the default
transport is HTTP. `revoke-token` now revokes, and `otlp-config` has no release
gate. Regenerate existing collectors.

## Development

Checks need Python 3.11+ and shellcheck; Node only regenerates the retained
TypeScript goldens.

```bash
bash tests/bash/check.sh                       # syntax, shellcheck, units, offline suite, 3.2 guard
VECTOR_VALIDATE=1 python3 tests/bash/test.py   # plus `vector validate` in the pinned image
VECTOR_BINARY=/path/to/vector python3 tests/bash/test.py
TEST_BASH=/bin/bash python3 tests/bash/test.py # macOS ships Bash 3.2 here
python3 tests/bash/bash32.py                   # Bash 3.2 from the official image
pnpm exec tsx tests/bash/golden.ts             # regenerate TS goldens
```

The offline suite stubs curl, Docker, sudo and systemctl; no test starts a
collector or contacts a server. See [PARITY.md](PARITY.md) for the API parity
table and [RESULTS.md](RESULTS.md) for live validation.

The npm package `@nano-rs/connect` (0.3.0, sources under `src/`) is retired; the
Bash client replaces it.

## License

Apache-2.0
