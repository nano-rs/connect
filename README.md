# nano connect

The standalone Bash script is the primary installation path. It needs Bash 3.2+,
curl and standard Unix tools; Node/npm and jq are optional. The npm implementation
remains in this repository and stays published until the coordinator completes
live parity proof. This branch adds the release assets; the download below becomes
available after its first versioned release.

```bash
curl -fsSL https://github.com/nano-rs/connect/releases/latest/download/connect.sh -o connect.sh && bash connect.sh
```

For automation, download both `connect.sh` and `connect.sh.sha256` from the **same
versioned release**, then run `sha256sum --check connect.sh.sha256` before execution.
The script version is available with `bash connect.sh --version`.

```bash
export NANO_URL=https://nano.example.com
# Supply an administrator API key via your secret manager as NANO_API_KEY.
bash connect.sh list-sources --builtin-only
bash connect.sh add-source --sources cisco_asa,palo_alto:tcp --deploy-parsers --non-interactive
bash connect.sh add-agent --os linux --non-interactive
bash connect.sh add-agent --os windows --non-interactive
bash connect.sh add-aggregator --sources cisco_asa --non-interactive
bash connect.sh connect --source cisco_asa --non-interactive
bash connect.sh verify --source cisco_asa --non-interactive
bash connect.sh sync-parsers --add-official --non-interactive
```

Generation writes artifacts under `./onboarding/` and does not start services.
`--out-dir` chooses another directory. `--run` explicitly pulls and starts the
syslog collector or aggregator with Docker Compose and waits for health. Execute the generated
Windows PowerShell installer on the Windows endpoint. Agents use endpoint services. Linux systemd instructions
are in the generated service file. Both require installing Vector on the intended
endpoint; the client itself never runs an installer or systemd.

Every source gets its own named bound ingest credential. The default transport is
HEC (with indexer acknowledgements and the original event message); `--transport
http --ingest-url https://nano.example.com/ingest/` uses a per-source Bearer token
and raw text. Set `--ingest-url` to the correct HEC **base URL** for split/hosted
deployments, e.g. `https://tenant.ingest.nano.rs`. API and ingest hosts may differ.
There is no shared install-token fallback and no direct native uplink to nano.
`--target host:9000` generates an offline native agent hop to a trusted private
aggregator; this hop requires network isolation and has no token authentication.

For existing named credentials, use `--token-dir /private/source-tokens` with one
file per canonical source type. The API checks binding/state, binds unbound tokens,
and rejects wrong-source or ambiguous tokens. It requires the current source-binding
API and `settings:system` plus search/parser permissions as applicable. A missing
source must be imported and published first (`--deploy-parsers` opts into doing so).
Profiles and credentials are isolated per instance in
`$XDG_CONFIG_HOME/nano-connect-bash` (default `~/.config/nano-connect-bash`).
Legacy npm profiles and install `.env` secrets are deliberately not imported.
`--env-file` reads only `BASE_URL` and never executes file content.

Open-core credential management requires `settings:system`. Hosted discovery
requires `log_sources:view`; hosted request/reveal/revoke requires
`log_sources:deploy`; verification requires `search:execute`. The key and its
owning user also need visibility of the selected sources. Parser import/publish
requires the parser and source permissions named by those APIs. A search-only key
cannot provision credentials.

**Hosted: create the source credential in the UI, then run the client.** In
Settings → ingest credentials for that source, create a **source** credential
for HEC (or HTTP), save its revealed value in a private 0600 file, then run:

```bash
bash connect.sh add-source --sources cisco_asa --token-file /private/cisco-token --ingest-url https://tenant.ingest.nano.rs --non-interactive
bash connect.sh connect --source cisco_asa --token-file /private/cisco-token --ingest-url https://tenant.ingest.nano.rs --non-interactive
```

Supply `NANO_API_KEY` privately with `log_sources:view`, `search:execute` and
visibility of the source. UI issuance/revocation additionally needs
`log_sources:deploy`. A search-only key can render/send when both a private token
file/directory and an **explicit** `--ingest-url` (or `NANO_INGEST_URL`) are supplied.
Discovery 403s then warn that enablement and binding are unverified; no source or
credential is created. Cached endpoints alone do not enable this fallback.
`connect`/`verify` need only `search:execute` and visibility of the expected source
for their searches. Missing tokens, explicit endpoints, readable disabled sources,
and non-permission discovery errors still fail. A hidden prompt
is available interactively instead of `--token-file`; automation can set
`NANO_TOKEN_FILE`. Tokens are saved privately per profile/source and reused.
For multiple sources use `--token-dir` with a separate file per canonical source.
Pass the correct explicit ingest endpoint; discovery never guesses a token destination.

Enabled tenant sources are selectable by their canonical name, including hosted
rows whose `source_type` is `routed`. For example:

```bash
bash connect.sh add-source --sources apache_access --token-file /private/apache-token --ingest-url https://tenant.ingest.nano.rs --non-interactive
bash connect.sh connect --source apache_access --token-file /private/apache-token --ingest-url https://tenant.ingest.nano.rs --non-interactive
```

Application/web sources use a local HTTP push listener; sources whose parser
metadata declares syslog retain raw syslog listeners. Common built-in syslog
ports stay unchanged. When transport metadata is unreadable, discovered sources
default to HTTP; choose `--sources apache_access:tcp`, `:udp` or `:http` explicitly
if needed. The upstream `--transport hec|http` is independent of the local listener.
HTTP listeners accept raw POST bodies at `/` on their generated stable port;
point your sender at that collector address. They have no local authentication:
use a trusted network or authenticated reverse proxy. This does not configure
file tailing or cloud API polling. Every upstream sink still uses its own bound
credential. Use fresh canonical-source evidence to prove the supplied token lands
under the requested source.

`--credential-id ID` (`NANO_CREDENTIAL_ID`) optionally checks the hosted listing
for active state, source kind, exact single-source binding and transport. The
listing has no token fingerprint, so metadata cannot authenticate the supplied
secret. Without an ID the client explicitly reports that limitation; when metadata
access is denied it still permits import. Run `connect` with fresh evidence to
prove actual token possession/routing, and use collector evidence below before
claiming delivery. Rendering alone proves neither. Wrong IDs/bindings and shared
collector credentials are rejected when an ID is provided.

Hosted HTTP collectors send newline-delimited JSON with the original log in
`message`; self-hosted HTTP collectors retain raw text. HEC is the default for
both. Regenerate existing hosted `--transport http` collectors after updating
the script: older configs sent raw text, which hosted JSON ingest rejects.

Hosted automatic issuance is intentionally delegated to the UI: its one-time
ECDH/HKDF/AES-GCM reveal is designed for the browser. No crypto dependency or
server-contract change is introduced. Hosted `rotate-token`, `--rotate` and
`revoke-token` print the UI path. Save the replacement privately and regenerate/
reload the collector before revoking the old credential in the UI. Open core
retains automatic create/reuse/rotate. Live hosted b12 acceptance remains the
coordinator's responsibility.

A source credential decides where an event is stored. Sending source B's claimed
HEC sourcetype or HTTP path with source A's credential is accepted under **A**;
the claim cannot override the binding. Revoked tokens are refused. A supplied
credential for the wrong requested source is rejected locally before sending.

HEC connectivity requests include a private UUID v4 channel, persisted as a 0600
file per profile/source under `channels/`. It survives reruns and rotations.
Vector 0.59's HEC sink generates its own UUID channel and includes it on event
and acknowledgement requests; its supported config has no channel override.

For collector delivery proof, send a different marker in **each actual request**
through the collector's listeners, then record the expected token source and
marker in a file (one `source marker` pair per line):

```text
cisco_asa proof-cisco-request-001
palo_alto proof-palo-request-002
```

```bash
bash connect.sh verify --evidence-file /private/request-evidence.txt --wait-seconds 120
```

Markers must be distinct, 8–128 ASCII letters/digits/underscores/hyphens. Verification
searches each marker with `metadata.log_source`, checks the returned canonical
stored source, remembers successful requests, and polls only missing ones within
one shared deadline. `--wait-seconds 0` takes one snapshot. A partial result exits
nonzero and names missing evidence. This command sends no events: direct API
connectivity cannot prove collector delivery. Start verification immediately after
sending; the verifier's deadline starts when polling starts, so the coordinator
must also record send times for the end-to-end two-minute acceptance.

Token directories are 0700 and token files 0600. Collector configs use Vector's
secret directory backend; no tokens appear in TOML or terminal output. Windows
installer artifacts restrict the secret directory ACL to Administrators and SYSTEM.
Rotate with `bash connect.sh rotate-token --source cisco_asa --out-dir
./onboarding/add-source --non-interactive`, then reload the collector. Replacement
state and artifact secrets are saved atomically before revoking the old credential.
A pending-revocation journal allows recovery on the next run if revocation fails.
Each collector directory is an independent artifact: regenerate other copies before
revoking a credential they still use. Do not run concurrent rotations for one instance.

`--yes` selects non-interactive defaults and permits prompted parser/key creation;
`--non-interactive` fails on required missing values without authorizing optional
changes. All required prompts have flag/environment equivalents (`--help`).
`NO_COLOR` disables colors; redirected output is always plain text. For optional
JSON extraction, jq handles Unicode escapes; without jq the tested narrow awk/sed
extractors handle the known ASCII credential/route fields, escaped quotes,
backslashes and nested records. Unicode escapes in requested scalar fields fail
closed without jq; install jq if a parser catalog uses those escaped identifiers.

`otlp-config --source <type> --out-dir <dir>` generates a private `otel.env` for
an OTLP/HTTP protobuf exporter. **Blocked on a server shipping
[nanosiem #6811](https://github.com/nano-rs/nanosiem/pull/6811)** (open/unreleased
when implemented); opt in only then with `NANO_OTLP_SOURCE_AUTH_RELEASED=1`.
The public endpoint is `/otlp/v1/{logs,metrics,traces}`. nginx calls
`/api/internal/otlp-auth` on every request, injects the verified credential/source
identity, and fails closed for revoked/unbound credentials or disabled sources.
The client never calls that internal endpoint or falls back to raw OTLP ports.
Use a separate exporter configuration/credential per source. Regenerate `otel.env`
after rotation before restarting the exporter.

Collector images pin upstream Vector 0.59.0 by digest, matching the Ludus sender:
the trimmed nano server image lacks HEC sender/edge components and cannot run
these collectors. See [PARITY.md](PARITY.md) for behavior changes and
[RESULTS.md](RESULTS.md) for validation and outstanding coordinator proof.

Development checks (Python 3.11+, shellcheck; Node only for regenerating TS goldens):

```bash
pnpm exec tsx tests/bash/golden.ts
bash tests/bash/check.sh
VECTOR_VALIDATE=1 python3 tests/bash/test.py
# Or validate with a local upstream Vector 0.59.0 binary:
VECTOR_BINARY=/path/to/vector python3 tests/bash/test.py
# Optional actual Bash 3.2 path:
TEST_BASH=/path/to/bash-3.2 python3 tests/bash/test.py
```

The Vector check runs only `validate --no-environment` in a read-only, networkless
container with a temporary artifact mount. Deployment tests stub curl, Docker,
sudo and systemctl. No test starts a collector or touches a tenant.

---

## Retained npm CLI documentation

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
| `connect list-sources` | List the syslog source_types you can pass to `--sources` — built-ins **plus whatever your instance already parses**. |

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
npx @nano-rs/connect list-sources          # built-ins + what your instance already parses
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

**HTTP fans out per source_type.** Current source credentials determine the stored source;
claimed headers or body fields cannot override that binding. The retained npm renderer uses
static per-sink headers, while the Bash client uses one bound token per sink. So each
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

## Source types come from your instance, not just this CLI

Nine common vendors ship curated here (vetted port, correct transport, vendor notes). Everything
else comes from **your** nano: `add-source`, `add-aggregator`, and `list-sources` read the parser
registry and present three tiers.

```bash
npx @nano-rs/connect list-sources
#   Built-in
#     cisco_asa           5514/udp  Cisco ASA / FTD firewall
#     …
#   From your instance (parsers you have deployed; ports assigned by connect)
#     mikrotik_routeros   5697/udp  MikroTik RouterOS  (also: routeros, mikrotik)
#   Available in the community catalog (not imported yet — selecting one imports its parser)
#     suricata              —       Suricata IDS/IPS  [security]
#     zeek                  —       Zeek Network Monitor  [network]
#     …

npx @nano-rs/connect add-source --sources routeros
```

So importing the community MikroTik parser is enough to make its source_type collectable — and a
parser you *haven't* imported is still selectable, with the import offered right after the
listener is generated.

Any `match_value` the parser routes on works as the name: `routeros` and `mikrotik` both resolve
to the entry above, and the generated config stamps the canonical one.

### What's *not* offered

`add-source` generates a syslog listener, so the community tier only lists sources that can
actually arrive that way. CloudTrail, Okta, Sysmon and friends are parsed by nano perfectly well —
they just reach it by API poll, HTTP push, or an endpoint agent, never by pointing a device at a
UDP port. Asking for one is refused rather than handed a listener that stays silent forever:

```
✖ Can't collect over syslog:
  sysmon is an `endpoint` source — collect it with `connect add-agent` on the endpoint.
```

A parser declares this itself with `transports:` in its YAML, which is authoritative:

```yaml
name: okta
category: security
transports: [api]      # never offered for a syslog listener
```

Parsers that don't declare it yet fall back to their `category` (`network` / `security` /
`generic` count as syslog-collectable). That fallback is coarse — `category` describes what a
source *is*, not how it reaches you — so a `security` parser that's really API-only stays listed
until the repo annotates it.

### Caveats on discovered types

The registry has no transport detail, so the port is assigned by
`connect` (stably — it's derived from the name, so importing other parsers won't renumber a
listener your devices already point at) and the mode defaults to UDP; override with
`--sources <type>:tcp`. And an unattended `--non-interactive` run without `--sources` enables only
the built-ins — opening a port for every parser on your instance isn't something to do unasked.

If the registry isn't readable (no saved key, missing parser scopes, offline), everything still
works against the built-ins and says so.

## Common flags

- `--url <baseUrl>` — your nano URL (defaults to your saved connection)
- `--api-key <key>` / `--env-file <path>` — auth without the interactive flow
- `--non-interactive` — for CI/scripts (fails instead of prompting)
- `--run` — pull the image and start the collector here
- `--deploy-parsers` — auto-deploy available community parsers
- `--sources a,b` (add-source / add-aggregator) — which source_types to collect; append `:tcp` /
  `:udp` to pin a listener's transport (e.g. `pfsense:tcp`)
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
