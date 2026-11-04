# Parity: connect.sh 0.4.4 (lake hosted model) → 0.5.0 (ClickHouse product)

0.5.0 retargets the Bash client at the ClickHouse product (nanosiem
`clickhouse/dev`, the v2.0.0 candidate). Every deployment model (open core,
enterprise self-hosted, BYOC, Civo) serves the same API, so the client has one
path. The endpoints below are from `nanosiem-api/src/routes.rs` and the handler
OpenAPI annotations on `clickhouse/dev`.

**keep**: works unchanged. **change**: kept with a different contract or
implementation. **drop**: lake-only, removed.

## API calls

| connect.sh 0.4.4 call | Used by | clickhouse/dev equivalent | Verdict |
|---|---|---|---|
| `POST /api/auth/login` | `require_key` (email sign-in) | same (`handlers::auth::login`) | keep |
| `POST /api/api-keys` (search, log_sources, parser_repositories, source_configs, settings:system) | `require_key` | same; every requested permission exists in `auth::permissions` | keep |
| `GET /api/setup/status` (`initialized`) | `connect` | same (public) | keep; now checked on every deployment |
| `GET /api/ingest-tokens` → `tokens`, `sources` | `load_tokens` (open core) | same (NAN-4907). Needs `log_sources:view` (was documented as settings:system). Adds `delivery`, `install_token` | change: the only discovery path; `delivery: none` stops issuance up front; 403/404 messages name the right permission and API |
| `POST /api/ingest-tokens` `{name, source_id}` → `{credential, token}` | `credential` | same; 201, `settings:system`, 503 when delivery is not configured | keep |
| `POST /api/ingest-tokens/{id}/bind` | `credential` (`--token-dir`, unbound token) | same | keep |
| `POST /api/ingest-tokens/{id}/revoke` | `retire_pending` (rotation) | same | keep; also backs the new `revoke-token` |
| — | `revoke-token` (0.4.4 refused) | `POST /api/ingest-tokens/{id}/revoke` | change: implemented for the token the client issued |
| `GET /api/log-sources/ingest-endpoint` → `base_url` | hosted discovery probe only | open core (NAN-4922): `base_url`, `nano_https_url`, `hec_url`, `otlp_*_url`, `configured`, `token_delivery` | change: now the ingest URL resolver for every deployment |
| — | — | `GET /api/capabilities` → `edition` | new: decides whether falling back to the app host is allowed |
| `GET /api/log-sources/ingest-credentials` | hosted Direct credential metadata | none on clickhouse/dev | drop |
| `GET /api/log-sources` (hosted `source_type=routed` rows) | hosted source discovery; registry alias mapping | same (bare array of `LogSource`) | change: used only to map registry aliases to deployed sources |
| `GET /api/parser-repositories` → `repositories` | `load_catalog`, `sync-parsers` | same; the official row is `nano-rs/parsers` (OCSF on `main`, `legacy/clickhouse` for UDM installs), first-party only (NAN-4947) | keep |
| `GET /api/parser-repositories/{id}/parsers` (bare array) | `load_catalog` | same (`RepositoryParserResponse`: `name`, `file_path`, `raw_content`, `kind`, `is_imported`, `linked_log_source_id`) | keep |
| `POST /api/parser-repositories/{id}/parsers/import/{path}` `{import_type: linked, ingestion_method: routed}` → `log_source_id` | `review_parser` | same | keep |
| `POST /api/log-sources/{id}/publish` → `success` | `review_parser` | same (`log_sources:deploy`) | keep |
| `POST /api/parser-repositories` (official repository) | `sync-parsers --add-official` | same; only first-party URLs are accepted | keep |
| `POST /api/parser-repositories/{id}/sync`, `GET …/sync/status` | `sync-parsers` | same | keep |
| `POST /api/search` (`query`, `time_range`, `limit`, …) → `results` | `connect`, `verify` | same (search service behind the edge's `/api/search`); `metadata.log_source` is an alias of the stored `source_type` (NAN-4903) | keep |

## Transports and URLs

| 0.4.4 behaviour | clickhouse/dev | Verdict |
|---|---|---|
| Default transport HEC; HTTP alternative | HEC is Vector's own listener (`hec_url`); `/ingest` is on the TLS edge and the dedicated ingest frontend. Both lanes stamp `metadata.log_source` from the token since NAN-4963 (`db9d0ccba`) | keep: HEC default, HTTP equal; both live-verified on every source |
| HEC sink `splunk_hec_logs`, `Authorization: Splunk`, indexer acks, request channel | Vector `splunk_hec_ingest` on `:8088`, `valid_tokens_file`, `acknowledgements.enabled = true`; the token's route overrides the claimed sourcetype | keep. On `ae4872a3a` HEC/OTLP events for generic parsers were stored as `unknown`; fixed by NAN-4963 and re-verified. `POST /services/collector/ack` still answers 400 at `db9d0ccba`, so the sink logs `indexer_ack_failed` and acknowledges on the 200 |
| HEC base defaulted to the app URL (`$URL`) | HEC is Vector's own listener, `hec_url` = `<scheme>://<host>:<NANO_INGEST_HEC_PORT or 8088>` | change: taken from `hec_url`, or the chosen ingest host plus the instance's HEC port |
| HTTP sink to `$URL/ingest/`, raw text (open core) | edge `location = /ingest` and `/ingest/` → Vector `http_ingest` (`newline_delimited`, `bytes`; text/plain lines are the message) | keep (raw `text/plain`); URL from the resolver |
| HTTP sink as NDJSON JSON for hosted | — | drop (hosted HTTPS JSON validator is lake-only) |
| `--ingest-url` explicit, saved per instance/transport; discovered default saved too | dedicated ingest frontend (`NANO_INGEST_PUBLIC_BASE_URL`) on enterprise/BYOC/Civo; app host only on open core | change: `--ingest-url` > new `--ingest-base` > configured dedicated base > app host (only without a dedicated base; enterprise warns; enterprise with an unreadable endpoint fails). Only explicit values are saved. Never the app host while a dedicated base is configured |
| Tenant-prefixed `NANO_URL` (`/t/<slug>`), `<slug>.ingest.nano.rs` | none | drop (nothing in the client depended on the prefix beyond docs; any URL path is still accepted as the app URL) |
| `otlp-config` gated on `NANO_OTLP_SOURCE_AUTH_RELEASED=1`, endpoint `$URL/otlp` | edge `/otlp/v1/{logs,traces,metrics}` with `auth_request` to `/api/internal/otlp-auth` (NAN-4907) | change: gate removed; endpoint `<ingest base>/otlp` |
| Vector-native uplink refused | Vector `:6000` is not a token-authenticated push lane (`is_push_capable("vector") = false`) | keep refused |

## Credentials

| 0.4.4 | clickhouse/dev | Verdict |
|---|---|---|
| Open core: named `nit_` token per source, create/reuse/bind/rotate, pending-revoke journal | `ingest_tokens` (NAN-4907): bound once, `token_prefix` = `nit_` + 8 | keep |
| Hosted: `--token-file`, `NANO_TOKEN_FILE`, hidden prompt, `hosted-token` store | — | drop (flags and env now fail with a migration message) |
| Hosted: `--credential-id` metadata check (`kind`, `protocol`, `source_slugs`) | — | drop |
| Hosted: search-only key with explicit token + URL when discovery is 403 | — | drop; discovery needs `log_sources:view` |
| Hosted rotate/revoke → "use Settings" | rotate/revoke APIs | drop the hosted branch; open-core lifecycle applies everywhere |
| Shared `--ingest-token` / install token refused | install token still exists (legacy multiplex, deprecated) | keep refused |

## Commands

| Command | Verdict | Notes |
|---|---|---|
| `connect` | change | setup check on all deployments; resolver; marker search on `metadata.log_source` |
| `add-source` | change | resolver; no hosted import; HTTP always raw text |
| `add-agent` (linux journald/files, windows event log/sysmon, `--target`) | change | sinks via resolver; journald entries sent as `journalctl -o json` objects for the OCSF `linux_journald` parser (was MESSAGE only); journald `since_now = true` so a first start doesn't replay the whole journal |
| `add-aggregator` | keep | sinks via resolver |
| `list-sources` / `list-devices` | change | registry rows show the route key (first match value, e.g. `cisco_asa` for `cisco_asa_ocsf`), labelled `(registry)`, deduplicated; registry lookups prefer `<name>_ocsf`, so `windows_event` resolves to the JSON parser, not the XML/text variants |
| `sync-parsers` | keep | |
| `verify --source` | change | searches `metadata.log_source` (was `source_type`) for fresh events in `--window` |
| `verify --evidence-file` | keep | |
| `rotate-token` | keep | |
| `revoke-token` | change | implemented (0.4.4 always failed) |
| `otlp-config` | change | release gate removed; ingest-base endpoint |

## Retained from 0.4.x (NAN-3942 TypeScript → Bash port)

Bash 3.2 compatibility (no associative arrays, `mapfile`, `${x,,}`), optional jq
with fail-closed awk extractors (now linear-time: the ClickHouse parser catalog
is about 5 MB, which the 0.4.4 extractors took minutes to scan with macOS awk;
with jq the records are split by jq), private 0700/0600 state, secrets through
Vector's directory backend, atomic writes, the stable FNV port hash for
discovered sources, the pinned Vector 0.59.0 image, the PowerShell installer and
systemd unit generators, and the `connect.sh.sha256` release artifact are
unchanged. The retained-TS golden fixtures still check source and VRL parity.
