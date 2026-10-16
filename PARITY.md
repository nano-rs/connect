# TypeScript → Bash parity (NAN-3942)

Runtime is one `connect.sh`; Node/TypeScript and Python are test tooling only.
Tests referenced below live in `tests/bash/`: `test.py` is the offline curl/command
harness, `unit.sh` tests narrow extraction, and `golden.ts` generates retained-TS
fixtures. `test.py` compares source configs and whitespace/comment-normalized VRL
against those fixtures. Sink changes are explicit assertions, because a legacy
shared-token sink would violate the new credential contract.

| TS feature / file | Bash function / behavior | Verification |
| --- | --- | --- |
| `index.ts`, `ui/ui.ts` commands, flags, errors | `main`, `help_text`, `prompt`, `confirm`, `note`, `fail`; plain read, TTY colors, NO_COLOR, flags/env, --yes | help/version/missing input/injection cases; Bash 3.2/5 |
| `flow.ts` setup/auth/save/connectivity | `profile`, `require_key`, `connect_flow`, `search`; send to an existing bound source and require searchable marker | mocked login/mint, setup, ingest and search |
| `addSource.ts` | `select_sources`, `render_socket`, `render`, `compose` | HEC/HTTP fixtures, selector/dedup, raw bytes, Vector validation |
| `addAgent.ts` | `render_agent`, `render`, `platform_artifacts` | Linux/Windows TS golden, native trusted target, file-only collection |
| `addAggregator.ts` | `render`, `compose`; agents + optional per-port syslog | TS source golden and Vector validation |
| `listSources.ts` | `catalog`, `load_tokens`, `load_catalog`; built-ins, bindable instance routes, community syslog parsers | offline builtins and API harness |
| `selectSources.ts` | `select_sources`, `canonical_source`; comma-separated read prompt, :udp/:tcp, aliases, dedup | selector, alias, wrong transport tests |
| `syncParsers.ts` | `parsers`; official registration, enabled repositories, bounded sync poll | sync fixture; explicit errors for missing status/timeouts |
| `reviewParsers.ts` | `review_parser`; opt-in import + publish; success=false fails | missing-source import path escaped; publish fixture |
| `runHere.ts` | `run_here`; explicit --run, Compose v2 checks/pull/up/health | PATH-stubbed Docker; no real deployment |
| `verifyCmd.ts` | `verify`; sampled count, normalized/generic/parser-failed distinction | search fixtures; never trust total_count |
| `preflight.ts`, `core/tlsProbe.ts` | direct nano native removed; curl verifies TLS for HEC/HTTP | native/mtls flags fail with migration hint |
| `core/api.ts`, `core/types.ts` | `request`, `api`, `field`, `records`; timeouts, status checks, response bodies withheld | HTTP 401/403/500; nested/escaped JSON units; no secret argv/output |
| `core/env.ts` | `profile` reads explicit BASE_URL only, never sources a file | shell inspection; no install-token import |
| `core/profile.ts`, `core/connection.ts` | `profile`, `atomic`, `private_dir`; per-instance URL collision check, private API key, per-transport endpoint overrides | different-instance rejection, file mode assertions |
| `core/endpoints.ts` | `url_check`, `profile`; explicit split endpoints; normalize missing scheme/trailing slash | reject userinfo/config injection; HTTP/HEC endpoints |
| `core/scopes.ts` | `require_key`; search/parser scopes + settings:system for credential lifecycle | login/mint stub; no secret output |
| `core/catalog.ts` | `catalog`; same nine source types/ports/modes | TS golden and builtins list |
| `core/discovery.ts` | `load_catalog`, `lookup_in`, `aliases`, `syslog_collectable`, `canonical_source`, `hash_port`, `select_sources` | canonical alias, category/transport gate, FNV ports and collision bound |
| `core/parsers.ts` | `load_catalog`, `lookup_parser`, `review_parser`, `encode_path` | import then publish, success check, escaped #/?/spaces |
| `core/vector.ts` | `render_sink`, `render`; raw text, disk minimum, block buffer, metrics; per-source secret backend | golden structural checks, six real Vector validations |
| `core/syslog.ts` | `render_socket`, `render`, `compose`, `platform_artifacts` | raw-wire source/VRL golden, :tcp override |
| `core/agent.ts` | `render_agent`, `platform_artifacts`; channels/Sysmon split, journald/Sysmon tagging, file tailing; signed MSI/service restart artifact | Linux/Windows golden, file-only/native configs; installers never executed |
| `core/aggregator.ts` | `render`, `compose`; same four endpoint routes plus selected syslog | source golden + real validation |
| `core/uplink.ts` | `credential`, `render_sink`, `persist_artifact_token`; HEC or HTTP per source; secret-directory mount | separate sink/token per route, create/reuse/bind/rotate tests |
| `core/target.ts` | `safe_id`, `port_check`, `target_check`, `url_check` | malicious source/URL, IPv4/IPv6, invalid port cases |
| `core/artifacts.ts` | `private_dir`, `atomic`, `platform_artifacts` | 0700/0600, repair loose token mode, temp-only rendering |
| `core/ingest.ts` | `connect_flow`; HEC string event or HTTP JSON message, bound token, searchable marker | wire shape asserted by mock; search proof stub |
| `core/verify.ts` | `search`, `verify`, `connect_flow`; bounded marker polling, recent-window sample and parse classification | mock marked event + normalized/generic/error samples |
| NAN-3806 / NAN-3841 additions | `load_tokens`, `source_id`, `find_credential`, `credential`, `retire_pending`; create/reuse/bind/rotate; no shared install fallback | active/wrong-source/unbound/revoked/disabled/legacy cases, persisted-before-revoke assertions |
| OTLP #6811 addition | `otlp-config`; private source-specific exporter env; public /otlp prefix; explicit release gate | gate refusal, private env mode; live contract requires release |
| Release packaging | version, `connect.sh.sha256`, `.github/workflows/bash.yml` | checksum verification and version/tag guard |

## Intentional changes and exclusions

- Direct Vector-native forwarding to nano, mTLS bundle import/CN probing, and
  `--mtls-dir`/`--vector-host`/`--vector-port` are removed: those hops cannot prove
  source-bound token routing. Use HEC/HTTP. A native agent→aggregator hop is
  retained only for explicitly trusted private networks; it is not an authenticated
  nano ingest endpoint. No openssl dependency remains.
- Shared `--ingest-token`/VECTOR_AUTH_TOKEN is refused. A synthetic catch-all
  connectivity source is not created implicitly; pass `connect --source` for an
  existing enabled source. Named credentials require the admin settings:system
  API; read-only key mint fallback cannot satisfy this workflow and is omitted.
- No automatic migration from npm profiles or automatic install `.env` discovery:
  importing the legacy shared token would defeat the required model. Explicit
  --env-file reads only BASE_URL. Split endpoints are explicit and saved per instance;
  no speculative ingest probing sends source tokens to guessed hosts.
- Only selected listeners are emitted. Commented dormant listeners are omitted:
  uncommenting one without provisioning its bound token would silently lose data.
  Re-run generation to add a source. IDs with dots/control characters are rejected
  rather than interpolated as unintended TOML table paths; lower-case ASCII
  alphanumeric/underscore/hyphen route keys are supported.
- Interactive multi-select becomes a plain comma-separated read prompt. `--yes`
  uses non-interactive defaults. No implicit deployment prompt: only --run deploys.
- Parser publishing does not fall back to legacy deploy on 404: those servers
  cannot prove a fresh draft is active. Sync failures/timeouts return nonzero.
- Upstream Vector 0.59.0 collector digest replaces TS 0.56.0 and the trimmed nano
  server image. The nano.7 digest was tried: it lacks `splunk_hec_logs`, so cannot
  validate/run the required HEC sender. Use the same upstream sender as Ludus #6.
- Windows collection/installer syntax is compared against retained TS output;
  Linux Vector cannot validate the Windows-only source. Windows execution remains
  coordinator/endpoint proof, not a claimed Linux validation.
- OTLP source authentication is unreleased (#6811 was OPEN on inspection). The
  generated configuration implements its public HTTP/protobuf/Bearer contract,
  gated by NANO_OTLP_SOURCE_AUTH_RELEASED=1; it never contacts the internal nginx
  auth endpoint or exposes raw OTLP ports. Live proof waits for that release.

## Live-proof follow-up (0.4.1)

| Requirement | Implementation | Offline proof / limit |
|---|---|---|
| HEC request channel | `hec_channel`, `request`: private UUID persisted per instance/source | Header required by mock; stable across processes; independent between sources. Vector already generates channels in its HEC service. |
| Hosted discovery/scopes | `load_tokens`, `api`: probe alternate hosted endpoint and credential list after open-core 404 | Hosted and missing-scope fixtures; UI-issued source credentials imported via `--token-file`, hidden prompt or per-source directory; optional ID metadata validation. No hosted issuance/revoke API mutation. |
| Token-authoritative routing | Server stores requests under token source, regardless of source claims | Mock accepts B claim with A token, then evidence passes only under A. Local wrong-source credential validation stays strict. |
| Per-request collector evidence | `verify_evidence`: distinct markers, canonical stored source, shared deadline ≤120s | Complete/partial/wrong source, distinct markers, delayed second source, no final newline, timeout cases. Coordinator must send through real collector and record send times. |

Hosted issuance/rotation/revocation intentionally uses Settings → ingest credentials
for that source (coordinator decision). `hosted_credential` imports and privately
persists user-created source tokens; optional credential ID checks kind, source,
state and protocol. The list has no fingerprint, so fresh canonical connectivity
evidence proves secret binding. Offline import/reuse, denied metadata, mismatched
metadata, HTTP/HEC, multi-source file refusal and UI lifecycle guidance are tested.
