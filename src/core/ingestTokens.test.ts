import assert from "node:assert/strict";
import { test } from "node:test";
import type { NanoClient } from "./api.js";
import { SYSLOG_CATALOG } from "./catalog.js";
import {
  detectIngestModel,
  ingestRejectionMessage,
  matchSource,
  parsePairs,
  planToken,
  tokenEnvVar,
  tokenName,
} from "./ingestTokens.js";
import { buildVectorToml } from "./syslog.js";
import { type BindableSource, type IngestTokenList, NanoApiError } from "./types.js";
import { buildIngestEnvFile, composeUplinkLines, type NanoUplink } from "./uplink.js";
import { httpSinks } from "./vector.js";

const ASA: BindableSource = {
  source_id: "11111111-1111-4111-8111-111111111111",
  name: "Cisco ASA",
  source_type: "routed",
  route_key: "cisco_asa",
  enabled: true,
};
const PAN: BindableSource = {
  source_id: "22222222-2222-4222-8222-222222222222",
  name: "Palo Alto",
  source_type: "routed",
  route_key: "palo_alto",
  enabled: true,
};

function listOf(over: Partial<IngestTokenList> = {}): IngestTokenList {
  return { tokens: [], sources: [ASA, PAN], ...over };
}

const TOKEN_ASA = "nit_aaaaaaaaRESTOFTHETOKEN0123456789";

test("each source_type reads its own token variable", () => {
  assert.equal(tokenEnvVar("cisco_asa"), "NANO_TOKEN_CISCO_ASA");
  assert.equal(tokenEnvVar("windows-event.v2"), "NANO_TOKEN_WINDOWS_EVENT_V2");
  assert.equal(tokenEnvVar("__"), "NANO_TOKEN_SOURCE");
});

test("--source-token / --source-map pairs parse, values may contain '='", () => {
  assert.deepEqual(parsePairs("a=b, c=d==", "--x"), { a: "b", c: "d==" });
  assert.deepEqual(parsePairs(undefined, "--x"), {});
  assert.throws(() => parsePairs("novalue", "--x"), /expected <source_type>=<value>/);
  assert.throws(() => parsePairs("a=", "--x"), NanoApiError);
});

test("a source_type matches the log source whose route key it is, or an explicit choice", () => {
  assert.equal(matchSource("cisco_asa", [ASA, PAN])?.source_id, ASA.source_id);
  assert.equal(matchSource("fortigate", [ASA, PAN]), undefined);
  assert.equal(matchSource("fortigate", [ASA, PAN], "palo alto")?.source_id, PAN.source_id);
  assert.equal(matchSource("fortigate", [ASA, PAN], PAN.source_id)?.source_id, PAN.source_id);
  assert.equal(matchSource("fortigate", [ASA, PAN], "cisco_asa")?.source_id, ASA.source_id);
  // An enabled source wins over a disabled one with the same route key.
  const disabled = { ...ASA, source_id: "33333333-3333-4333-8333-333333333333", enabled: false };
  assert.equal(matchSource("cisco_asa", [disabled, ASA])?.source_id, ASA.source_id);
});

test("no supplied or saved token: issue one", () => {
  assert.deepEqual(planToken({ sourceType: "cisco_asa", source: ASA, list: listOf() }), { kind: "create" });
});

test("a saved token still bound to the source is reused, otherwise reissued", () => {
  const saved = { credentialId: "c1", sourceId: ASA.source_id, token: TOKEN_ASA };
  const active = listOf({
    tokens: [{ credential_id: "c1", name: "x", token_prefix: "nit_aaaaaaaa", state: "active", source_id: ASA.source_id, route_key: "cisco_asa" }],
  });
  assert.deepEqual(planToken({ sourceType: "cisco_asa", source: ASA, list: active, saved }), {
    kind: "reuse",
    credentialId: "c1",
    token: TOKEN_ASA,
  });
  // Revoked (or gone) → a fresh one, nothing to replace.
  const revoked = listOf({ tokens: [{ ...active.tokens[0]!, state: "revoked" }] });
  assert.deepEqual(planToken({ sourceType: "cisco_asa", source: ASA, list: revoked, saved }), { kind: "create", replaces: undefined });
  assert.deepEqual(planToken({ sourceType: "cisco_asa", source: ASA, list: listOf(), saved }), { kind: "create", replaces: undefined });
  // The operator picked a different source this time → a new token; the old one is reported.
  assert.deepEqual(planToken({ sourceType: "cisco_asa", source: PAN, list: active, saved }), { kind: "create", replaces: "c1" });
});

test("a supplied issued token is bound when unbound, used when bound here, refused when bound elsewhere", () => {
  const base = { credential_id: "c9", name: "fw", token_prefix: "nit_aaaaaaaa" };
  const unbound = listOf({ tokens: [{ ...base, state: "unbound", source_id: null }] });
  assert.deepEqual(planToken({ sourceType: "cisco_asa", source: ASA, list: unbound, supplied: TOKEN_ASA }), {
    kind: "bind",
    credentialId: "c9",
    token: TOKEN_ASA,
  });
  const here = listOf({ tokens: [{ ...base, state: "active", source_id: ASA.source_id, route_key: "cisco_asa" }] });
  assert.deepEqual(planToken({ sourceType: "cisco_asa", source: ASA, list: here, supplied: TOKEN_ASA }), {
    kind: "use",
    token: TOKEN_ASA,
    credentialId: "c9",
  });
  const elsewhere = listOf({
    tokens: [{ ...base, state: "active", source_id: PAN.source_id, source_name: "Palo Alto", route_key: "palo_alto" }],
  });
  const refused = planToken({ sourceType: "cisco_asa", source: ASA, list: elsewhere, supplied: TOKEN_ASA });
  assert.equal(refused.kind, "error");
  assert.match((refused as { message: string }).message, /bound to "Palo Alto" \(palo_alto\).*never changes/);
  const unknown = planToken({ sourceType: "cisco_asa", source: ASA, list: listOf(), supplied: TOKEN_ASA });
  assert.match((unknown as { message: string }).message, /isn't an ingest token on this nano/);
  // The error never echoes more than the display prefix.
  assert.doesNotMatch((unknown as { message: string }).message, /RESTOFTHETOKEN/);
  const revoked = listOf({ tokens: [{ ...base, state: "revoked", source_id: ASA.source_id }] });
  assert.match(
    (planToken({ sourceType: "cisco_asa", source: ASA, list: revoked, supplied: TOKEN_ASA }) as { message: string }).message,
    /revoked/,
  );
});

test("a non-issued token (the install token) only works for the source it is bound to", () => {
  const install = "legacy-install-token-value-0123456789";
  const boundHere = listOf({ install_token: { enabled: true, state: "active", source_id: ASA.source_id, route_key: "cisco_asa" } });
  assert.deepEqual(planToken({ sourceType: "cisco_asa", source: ASA, list: boundHere, supplied: install }), {
    kind: "use",
    token: install,
  });
  const unbound = listOf({ install_token: { enabled: true, state: "unbound", source_id: null } });
  const plan = planToken({ sourceType: "cisco_asa", source: ASA, list: unbound, supplied: install });
  assert.equal(plan.kind, "error");
  assert.match((plan as { message: string }).message, /refuses it \(401\)/);
});

function fakeClient(impl: () => Promise<IngestTokenList>): NanoClient {
  return { listIngestTokens: impl } as unknown as NanoClient;
}

test("the ingest model is read from GET /api/ingest-tokens", async () => {
  const bound = await detectIngestModel(fakeClient(async () => listOf()));
  assert.equal(bound.kind, "bound");

  // Pre-NAN-3806 nano: the endpoint exists but lists no bindable sources.
  const older = await detectIngestModel(fakeClient(async () => ({ tokens: [] })));
  assert.equal(older.kind, "legacy");

  const missing = await detectIngestModel(
    fakeClient(async () => {
      throw new NanoApiError("nope", 404);
    }),
  );
  assert.equal(missing.kind, "legacy");

  const forbidden = await detectIngestModel(
    fakeClient(async () => {
      throw new NanoApiError("nope", 403);
    }),
  );
  assert.equal(forbidden.kind, "unknown");
  assert.equal((await detectIngestModel(undefined)).kind, "unknown");
});

test("a 401 on a nano with bound tokens tells the operator to bind it", () => {
  assert.match(ingestRejectionMessage(401, "bound"), /Ingestion → Credentials → Bind/);
  assert.match(ingestRejectionMessage(401, "bound"), /\/api\/ingest-tokens\/\{credential_id\}\/bind/);
  assert.match(ingestRejectionMessage(401, "legacy"), /VECTOR_AUTH_TOKEN/);
});

test("token names fit nano's 100-character limit", () => {
  assert.ok(tokenName("x".repeat(80), "h".repeat(80)).length <= 100);
  assert.equal(tokenName("cisco_asa", "edge1"), "nano-connect cisco_asa @ edge1");
});

test("every HTTP sink authenticates with its own source's token", () => {
  const toml = httpSinks(
    [
      { sourceType: "cisco_asa", inputs: ["asa_tag"] },
      { sourceType: "palo_alto", inputs: ["pan_tag"] },
    ],
    "https://nano.example.com/ingest/",
    1,
  );
  assert.match(toml, /\[sinks\.nano_cisco_asa\.auth\][^[]*token = "\$\{NANO_TOKEN_CISCO_ASA\}"/);
  assert.match(toml, /\[sinks\.nano_palo_alto\.auth\][^[]*token = "\$\{NANO_TOKEN_PALO_ALTO\}"/);
  assert.doesNotMatch(toml, /VECTOR_AUTH_TOKEN/);
  // The header is still sent (harmless claim on a current nano, the routing key on an older one).
  assert.match(toml, /X-Source-Type = "cisco_asa"/);
});

test("a sink with no token ships commented out", () => {
  const toml = httpSinks([{ sourceType: "linux_sysmon", inputs: ["r.linux_sysmon"], skipped: "no nano log source for it yet" }], "https://x/ingest/", 1);
  assert.match(toml, /# --- linux_sysmon: not forwarded yet — no nano log source for it yet/);
  for (const line of toml.split("\n")) assert.ok(line === "" || line.startsWith("#"), line);
});

test("the .env holds one variable per source and refuses a token that could break out", () => {
  const env = buildIngestEnvFile({ palo_alto: "nit_bbbbbbbbXYZ", cisco_asa: "nit_aaaaaaaaXYZ" });
  const vars = env.split("\n").filter((l) => l.startsWith("NANO_TOKEN_"));
  assert.deepEqual(vars, ["NANO_TOKEN_CISCO_ASA=nit_aaaaaaaaXYZ", "NANO_TOKEN_PALO_ALTO=nit_bbbbbbbbXYZ"]);
  assert.throws(() => buildIngestEnvFile({ cisco_asa: "nit_aaaa\nEVIL=1" }), /characters a token never has/);
});

function httpUplink(over: Partial<NanoUplink> = {}): NanoUplink {
  return {
    transport: "http",
    target: { host: "nano.example.com", port: 6000 },
    ingestUrl: "https://nano.example.com/ingest/",
    tls: { enabled: true },
    ...over,
  };
}

test("a syslog collector over HTTP gets one sink + token per device type", () => {
  const asa = SYSLOG_CATALOG.find((d) => d.sourceType === "cisco_asa")!;
  const pan = SYSLOG_CATALOG.find((d) => d.sourceType === "palo_alto")!;
  const toml = buildVectorToml(
    {
      catalog: SYSLOG_CATALOG,
      selected: [asa, pan],
      uplink: httpUplink({ sourceTokens: { cisco_asa: "nit_a", palo_alto: "nit_b" } }),
      bufferBytes: 1,
      image: "img",
    },
    "now",
  );
  assert.match(toml, /\$\{NANO_TOKEN_CISCO_ASA\}/);
  assert.match(toml, /\$\{NANO_TOKEN_PALO_ALTO\}/);
  // Token values never land in vector.toml.
  assert.doesNotMatch(toml, /nit_a|nit_b/);
});

test("compose reads the .env only when one is written", () => {
  assert.match(composeUplinkLines(httpUplink({ sourceTokens: { a: "nit_aaaaaaaa1" } })).env, /env_file/);
  assert.equal(composeUplinkLines(httpUplink({ sourceTokens: {} })).env, "");
});
