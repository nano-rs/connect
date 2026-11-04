# NAN-4974: connect.sh 0.5.0 against the ClickHouse product

Target: nanosiem `clickhouse/dev` at `ae4872a3a` (API 0.1.703), OCSF schema
profile (the install default), brought up with `scripts/e2e.sh up` as
throwaway, ownership-labelled stacks on free ports. No shared or developer
stack was used. Collectors ran in Docker from the client's own artifacts.

## Offline suite

| Check | Result |
|---|---|
| `bash tests/bash/check.sh` (syntax, shellcheck, units, offline suite, Bash 3.2 syntax guard, `--posix` units) | pass |
| `tests/bash/test.py` on Bash 5.3.15 | 108 checks pass |
| `tests/bash/test.py` on Bash 3.2.57 (`TEST_BASH=/bin/bash`, macOS) | 108 checks pass |
| `tests/bash/unit.sh` on Bash 3.2.57 and 5.3.15 | pass |
| `tests/bash/test.py` with every generated config run through `vector validate --no-environment` in the pinned `timberio/vector:0.59.0-alpine` image | pass |
| jq-less extractors on the live 5 MB parser catalog (73 records) | identical to jq, ~4 s (0.4.4's extractors did not finish in minutes) |

New offline cases cover: ingest resolution (open core app host; enterprise
dedicated frontend; enterprise without a configured base; enterprise with the
endpoint unreadable; `--ingest-base` and `--ingest-url` precedence and saving;
refusal of app-host destinations while a dedicated base is configured, by
`--ingest-url`, HEC URL and `--ingest-base`; OTLP endpoint on the dedicated
host), default HTTP transport, `delivery: none` stopping issuance, removed
lake flags and env, `revoke-token`, and journald JSON output.

## Live: enterprise build, OCSF

`capabilities.edition = enterprise`. Client pointed at the stack's edge
(`NANO_URL` = edge origin, which is also the configured ingest base, so it is
the not-dedicated case with the enterprise warning), and collectors in Docker
used `--ingest-base http://host.docker.internal:<edge>`.

| Source | Collector | Transport | Result |
|---|---|---|---|
| syslog UDP, `cisco_asa` (registry parser imported and published by `--deploy-parsers`) | `add-source --run` (compose) | HEC, then HTTP | lands, `metadata.log_source=cisco_asa`, Network Activity |
| syslog TCP, `palo_alto` (imported) | `add-source --run` | HEC, then HTTP | lands under `palo_alto` |
| syslog UDP, generic `syslog` (imported) | `add-source --run` | HTTP | lands under `syslog` |
| syslog TCP, generic `syslog` | `add-source --run` | HEC | **stored under `unknown`** (server, see findings) |
| journald (`linux_journald`, imported) | `add-agent --os linux`, installed with the generated `nano-collector.service` on a systemd endpoint container | HEC, then HTTP | lands under `linux_journald` |
| file (`--files /var/log/nan4974/*.log --file-source json_generic`, imported) | same agent | HTTP | lands under `json_generic` |
| file, `json_generic` | same agent | HEC | **stored under `unknown`** (server, see findings) |
| Windows Event Log + Sysmon | `add-agent --os windows` | HTTP | config passes `vector validate` (0.59.0). Also: the same config with only the `windows_event_log` source swapped for an HTTP JSON source, fed events in the Vector Windows shape: lands under `windows_event` and `windows_sysmon`, both mapped to an OCSF class |
| `connect --source <s>` | direct marker | HTTP and HEC | marker searchable under the source (HEC: not for `syslog`/`json_generic`) |
| `verify --source <s>` | fresh-event search | | counts per source, normalized vs Base Event |
| `verify --evidence-file` | one marker per real request | | final HTTP matrix run (cisco_asa, palo_alto, syslog, linux_journald, json_generic): four found within 120 s; the cisco_asa event was held by the collector until the next cisco_asa event, then both were found (see the straggler finding) |

Dedicated ingest frontend, live: with `NANO_URL` set to the API port directly,
the instance's configured base (the edge) is a different origin, so the client
reported `Dedicated ingest frontend: http://127.0.0.1:<edge>`, sent the
`connect` marker there and found it; `--ingest-url http://127.0.0.1:<api>/ingest`
was refused (`refusing to send events to the app origin`).

## Live: open-core build, OCSF

Built with `--edition open` into a separate `CARGO_TARGET_DIR`;
`capabilities.edition = open`. Fresh profile, fresh stack (no pre-existing log
sources: every source below was imported from the registry and published by
the client with `--deploy-parsers`). Default transport (HTTP) throughout.

| Source | Collector | Result |
|---|---|---|
| syslog UDP `cisco_asa`, syslog TCP `palo_alto`, syslog UDP `syslog` | one `add-source --run` collector (compose) | all three found in one evidence run |
| journald `linux_journald` | `add-agent --os linux` installed with the generated systemd unit | found; the sshd failure line mapped to Authentication (1 normalized) |
| file `json_generic` | same agent | found |
| Windows `windows_event` + `windows_sysmon` | `add-agent --os windows`: `vector validate` pass; simulated-source run | both found, both mapped to an OCSF class |
| `verify --evidence-file` | the five Linux/syslog lanes | **all five found within 120 s in one run** |
| `connect --source cisco_asa` | HTTP and HEC | found both ways |
| `verify --source` | seven sources | fresh counts for each |
| `rotate-token --source syslog` + collector restart | | new token active, old revoked, fresh event found |
| `revoke-token --source syslog` | | both revoked; the collector's next request was refused (401) and the event never landed |
| `otlp-config` | | `OTEL_EXPORTER_OTLP_ENDPOINT=<edge>/otlp`. A protobuf OTLP log with that token was accepted (200; a bogus token got 401) but stored under `unknown` (server finding 1 applies to OTLP too) |
| Bash 3.2.57 (`/bin/bash`) with `CONNECT_NO_JQ=1` | `add-source` against the live 5 MB catalog | 2.3 s |

## Findings on clickhouse/dev (server side, not client bugs)

1. **HEC lane loses the source for generic OCSF parsers.**
   `config/vector/00-base.toml` `source_type_extract` stashes
   `%source_type = downcase(source_type)` for the OCSF lane; `02-hec-source.toml`
   `hec_normalize` sets `.source_type` from the token but never stashes
   `%source_type`. The OCSF `_ocsf_prepare` step reads `%source_type`, so a parser
   that doesn't hardcode `metadata.log_source` (generic `syslog`, `json_generic`)
   stores HEC events with `metadata.log_source = source_type = unknown`. Vendor
   parsers (cisco_asa, palo_alto, linux_journald) set it themselves and are
   unaffected. The same events over HTTP land correctly. Confirmed live for
   OTLP too: an authenticated OTLP log bound to `json_generic` was stored under
   `unknown`. Fix: stash `%source_type` at the end of `hec_normalize` and the
   OTLP prep transform, as `source_type_extract` does.
2. **HEC indexer acknowledgements are refused.** `POST /services/collector/ack`
   returns 400 (`BadRequest` in the server's Vector log), so `splunk_hec_logs`
   logs `indexer_ack_failed` and falls back to acknowledging on the 200.

Because of (1), and because `/ingest` is the TLS-terminated edge path (HEC is
plain HTTP on 8088 by default), 0.5.0 makes `--transport http` the default.

## Findings on the collector side

- **A single straggler event can wait for the next one.** Twice in the live
  runs, after several idle minutes, one sink took an event into its disk
  buffer but didn't send it until the next event for that source arrived; both
  were then delivered together (Vector metrics: buffer received 2, sink received
  1, then 3/3 after one more event). It didn't reproduce with an isolated Vector
  0.59 disk buffer to a local HTTP server, including after 100 s idle. It may be
  idle-connection handling through Docker Desktop's `host.docker.internal`.
  Continuous traffic never shows it; an evidence check that sends a single event
  per source after a long idle can.
- On a revoked token Vector's `http` sink treats the 401 as not retriable and
  drops the request, so rotate (replacement first) rather than revoke a token a
  running collector still uses.
- The Linux agent used to replay the whole journal on first start (2,400+
  entries on the test endpoint). 0.5.0 sets `since_now = true`.
