# NAN-3942 0.4.3 — hosted routed sources and search-only discovery

RESUME 3 fixes are implemented on `fix/NAN-3942-hosted-routed` from main
`b84f69c` in the requested isolated worktree.

- Hosted `source_type=routed` resolves the source's canonical `name`, so Apache
  and other enabled tenant sources can import UI-created credentials and connect.
- Enabled tenant sources bypass the community-only syslog filter. Application
  parsers render HTTP push listeners; syslog metadata keeps raw socket listeners.
  Unknown transport metadata defaults to HTTP, with explicit :tcp/:udp/:http
  overrides. HTTP listener ports publish as TCP in Compose. HEC/HTTP upstream
  sinks still have separate bound credentials and raw event payloads.
- Discovery 403s permit import only with an explicitly supplied ingest endpoint
  plus a token file/directory. Cached endpoints cannot authorize the fallback.
  Warnings explain unavailable enablement/binding checks; fresh canonical search
  evidence still proves delivery. Readable disabled sources and other discovery
  errors fail. No hosted issuance, rotation or revocation API mutation is added.

Validation: 112 offline CLI cases on Bash 5.3.15 and actual Bash 3.2.57, plus
JSON/path/hash units on both, POSIX units, shellcheck, syntax/static portability,
checksum and git whitespace checks. Retained TS structural goldens pass. Eight
configurations, including the new Apache HTTP listener, pass upstream Vector
0.59.0 `validate --no-environment` using a standalone binary downloaded into a
private temporary directory. No host Docker, services or installers ran. CI also
validates with the existing pinned upstream image digest.

New regression cases cover routed Apache render/connect, disabled sources,
HTTP/raw TCP selection, discovery-denied token-file and per-source token-directory
flows, multiple sources, explicit environment equivalents, cached endpoint refusal,
missing token/source file, token-discovery403, and endpoint401/404/500 refusal.
Fixture credentials alone are used; the supplied UI token file is untouched.

Coordinator must rerun full hosted b12 CLI render/connect with the UI-issued
Apache credential and search-only key, then verify distinct collector request
markers within two minutes. Earlier live CT108 and supplemental hosted proof are
in the connectlive lane; this patch makes no new live acceptance claim. No release,
npm deprecation, get.nano.rs changes, live tenant/lab calls or Slack messages.
Linear tools were unavailable in this session; the prior lane recorded its issue
read, and this follow-up implements the explicit RESUME 3 scope from the brief.

---

# NAN-3942 0.4.2 — hosted UI credential import

The latest coordinator decision is implemented: hosted source credentials are
created/revealed in Settings → ingest credentials for that source and supplied
with `--token-file`/NANO_TOKEN_FILE, hidden input, or a per-source token directory.
They are stored 0600 in 0700 profile directories, reused and rendered through the
existing secret backend. No hosted issuance/reveal/revoke mutation or crypto
runtime was added. Hosted rotate/revoke print UI guidance; open-core automatic
lifecycle remains intact.

Optional --credential-id validates readable hosted metadata: active, source kind,
exact single-source allowlist, matching protocol. The listing has no fingerprint;
metadata alone cannot link the secret to the ID. Fresh connect searches require
canonical metadata.log_source and the request marker; collector delivery still
requires distinct per-request evidence. Missing metadata access is explicit,
never a fabricated validation claim. README documents scopes and examples.

Validation: 91 offline CLI checks pass on Bash 5.3.15 and actual Bash 3.2.57;
JSON/path/hash units pass on both, plus Bash POSIX units, shellcheck, syntax/static
portability, checksum and whitespace checks. Existing TS goldens run in the suite;
Vector rendering is unchanged, so prior pinned-image validation applies. No Docker
was run on the host in this follow-up.

Tests add hosted import/reuse, HEC/HTTP connectivity, denied metadata, optional ID,
wrong source/protocol/kind/state, unknown ID, multi-source single-file rejection,
and rotate/revoke UI guidance with no hosted credential mutation.

Live CT108/hosted b12, two-source collector deadline, Windows and OTLP release
acceptance remain coordinator work. No release or npm deprecation is authorized
by offline checks. Earlier reports below describe historical blockers superseded
by this explicit UI-import decision.

---

# NAN-3942 live-proof follow-up — BLOCKED on hosted lifecycle

The 0.4.1 follow-up fixes the missing HEC channel and adds per-request delivery
evidence. Hosted detection/scopes are implemented; hosted automatic credential
issuance/reuse/rotation is **not complete**, so this is not release-ready.

- HEC curl requests now require a UUID v4 channel, private and stable per
  profile/source. Vector's existing HEC sink already generates a channel in
  `src/sinks/splunk_hec/common/service.rs` and uses it for event/ack requests;
  no unsupported Vector config option was added.
- `verify --evidence-file FILE --wait-seconds 120` checks distinct markers from
  actual collector requests under `metadata.log_source`, remembers successes,
  and shares a deadline across sources. A partial result fails. Snapshot mode
  is `--wait-seconds 0`. The coordinator must record send times separately;
  the deadline here measures polling time, not time since external sends.
- Mock routing now stores claimed-source-B requests with token A under A.
  Wrong-source imports still fail locally. Server refusal is expected for revoked
  tokens, not for a claim that the server overrides with the token binding.
- Open-core 404 triggers hosted endpoint/credential discovery rather than an
  unconditional open-core prerequisite. Denials name `log_sources:view`,
  `log_sources:deploy`, `search:execute`, open-core `settings:system`, and source
  visibility. Hosted detection stops before requesting or revoking anything.

## Hosted blocker and evidence

Read the hosted handlers and core types in local nanosiem `lean-lake-merge`:
`nanosiem-enterprise/src/handlers/enterprise_shared_sources.rs` (request, poll,
reveal, revoke) and `nanosiem-core/src/enterprise_shared_sources.rs` (endpoint).
Read nano-main origin/main's `packages/shared/src/crypto/ingest-credential-envelope.ts`,
`apps/api/src/services/shared-infrastructure/ingest-credential-seal.ts`, and
`apps/api/src/services/hosted-shared-ingest-credentials.ts`. The org-facing
nano-main service can return plaintext to its separately authenticated org API;
it is not the tenant SIEM API or authenticated by its `NANO_API_KEY`.

Tenant API contract:
`POST /api/log-sources/ingest-credentials` takes `kind: source`, one `source_slugs`
entry, `protocol: hec|nano_https|otlp_http`, `reveal_public_key`, and reveal-key
algorithm. Poll `GET .../requests/{id}`, then `POST .../requests/{id}/reveal` once.
The revealed token is an X25519/P-256 ECDH + HKDF-SHA256 + AES-256-GCM envelope,
AAD request UUID concatenated with tenant UUID. The API does not return plaintext.
Stock `openssl enc` does not support AEAD/GCM; optional openssl alone does not
supply the required authenticated opener. Implementing custom GCM in shell is
not a reviewed crypto solution. An approved authenticated-decryption runtime or
server-supported CLI issuance contract is needed to finish automatic hosted
lifecycle within the allowed dependency model. This run adds neither dependency
nor an unauthenticated decrypt/fallback, and does not claim hosted support.

Inspected the credential provisioning/hosted sections of nano-ludus PR #6: its hosted path accepts pre-issued source
tokens; only open-core provisions through `/api/ingest-tokens`. It does not solve
the hosted encrypted issuance requirement.

## Follow-up validation

- 77 offline CLI checks pass on Bash 5.3.15 and actual Bash 3.2.57.
- JSON/escaping/path/hash units pass on both versions and Bash POSIX mode.
- Shellcheck, Bash syntax, static Bash 3.2 compatibility and git whitespace pass.
- Existing structural TS goldens remain checked by the full suite. Rendering and
  the pinned image are unchanged; no new host Docker/installer/service execution.
- New tests cover required/stable/distinct HEC channels, two-source complete and
  delayed evidence, partial and wrong-source evidence, duplicate marker refusal,
  deadline expiry, final line without newline, hosted alternate API detection,
  and scope-denied diagnostics. Fixtures do not establish live hosted acceptance.

## Coordinator work still required

Do not release or deprecate npm. Resolve the hosted runtime/API contract, complete
hosted lifecycle support and rerun CT108 + hosted b12 acceptance with fresh keys
having the stated scopes. Send distinct markers through both collector listeners,
record their send times, and run evidence verification immediately. Repeat
revoke/rotate isolation and confirm requests land under their token's source.
No live tenant/lab API, service, installer, host Docker, Slack, or secret output
was used in this follow-up. The earlier implementation report follows for history.

---

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
