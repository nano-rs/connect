# NAN-3942 standalone Bash client results

Implemented `connect.sh` 0.4.0, primary-path documentation, a complete TS-module
inventory in PARITY.md, version/checksum release packaging, and offline tests.
The npm source/package is retained. get.nano.rs is untouched.

## Validation

- Bash 5.3.15 and actual Bash 3.2.57: **62 offline CLI checks on each**
  in the lifecycle/rendering/negative harness plus JSON extraction/escaping/path/hash unit tests. The Bash 3.2
  interpreter is extracted into a temporary directory from the pinned official
  container; no system installation or build is performed.
- Shellcheck `-s bash`: connect.sh and test shell runners are clean; Bash syntax
  and a static 3.2 incompatibility guard pass. POSIX-mode Bash also passes units.
- TypeScript-generated goldens: source configs and collection VRL match the retained
  syslog, Linux, Windows and aggregator renderers. Sink changes are asserted:
  distinct source credentials, raw text codec, minimum durable disk buffers,
  secret-directory backend and HEC acknowledgements.
- Seven real Vector validations: HEC syslog, HTTP syslog, Linux journald, file-only
  agent, trusted-native agent, aggregator+syslog, multiple file paths. They run
  `validate --no-environment` only, in read-only/networkless containers mounting
  temporary output. Pinned collector image:
  `timberio/vector:0.59.0-alpine@sha256:0e36bc2a290039e9b6a5e92f04bd2f133223506f72d09682c1df16c015172b7a`.
- The pinned nano.7 **server** image was also tried and rejected the HEC sink:
  its trimmed build omits edge/sender components. The upstream collector digest
  above matches nano-ludus #6 and is intentionally used instead.
- Actionlint passes for the new GitHub workflow; checksum and git whitespace
  checks pass. No repository-wide formatter was run.
- Credential cases include create/reuse/rotate, bind supplied unbound, reject
  wrong-source/revoked/disabled/legacy/shared credentials, per-instance isolation,
  secret mode repair, and recovery after failed revoke. The mock asserts both
  replacement state and sender token file exist before old-token revocation.
  Outputs are checked against fixture secrets; curl gets headers/body via private
  files rather than secret command-line arguments.
- Deployment steps use PATH-stubbed curl/docker/sudo/systemctl. No installer,
  service, tenant/lab API, VM, or live sender was run. No Slack messages were sent.

## Outstanding coordinator acceptance

This is implementation/offline proof, not a claim that the issue's live acceptance
has been met. The coordinator must run against **CT108 open core and hosted b12**:

1. Resolve the actual API and ingest endpoints and supply the scoped administrator
   key through a secret manager. Import/publish the selected source parsers.
2. Generate/deploy the collector on those intended targets; confirm a different
   named bound credential for every source, raw HEC/HTTP payload shape, and events
   searchable under the correct source with expected normalized fields.
3. Re-run to prove reuse, rotate with replacement files persisted first, reload
   the sender, then revoke a test source credential and prove the next request is
   refused while another source continues to work.
4. Execute the generated Windows MSI/service flow on an authorized Windows
   endpoint. Linux cannot validate the Windows-only event source; its config and
   collection VRL have golden parity, but no Windows execution is claimed.
5. OTLP: nano-rs/nanosiem#6811 was **OPEN, unmerged and unreleased** when inspected.
   After a release includes it, opt in with NANO_OTLP_SOURCE_AUTH_RELEASED=1,
   generate a separate exporter env per source, and prove /otlp/v1/logs,
   /otlp/v1/metrics and /otlp/v1/traces enforce current binding/revocation state.
   nginx must call /api/internal/otlp-auth per request, overwrite credential/source
   identity headers, and fail closed if the auth service fails. Never use raw ports.
6. Publish the script/checksum release only after the coordinator approves the live
   proof. npm deprecation remains deferred until then. No release is published
   by this implementation run; the PR is for coordinator review/merge.

## Reproduction

```bash
pnpm exec tsx tests/bash/golden.ts
bash tests/bash/check.sh
VECTOR_VALIDATE=1 python3 tests/bash/test.py
python3 tests/bash/bash32.py
sha256sum --check connect.sh.sha256
```

Python 3.11+ and Node are test tooling only. Runtime needs Bash/curl/coreutils and
awk/sed/grep, with jq optional. Read PARITY.md for intentional native/legacy-token,
profile migration, endpoint-probing and UI changes, and JSON fallback limitations.
