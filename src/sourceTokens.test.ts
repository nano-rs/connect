import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { NanoClient } from "./core/api.js";
import { loadInstance } from "./core/profile.js";
import type { BindableSource, IngestTokenInfo } from "./core/types.js";
import type { NanoUplink } from "./core/uplink.js";
import { attachSourceTokens } from "./sourceTokens.js";

// The profile lives under XDG_CONFIG_HOME: keep the tests' writes out of the real one.
const configHome = mkdtempSync(join(tmpdir(), "nano-connect-test-"));
process.env.XDG_CONFIG_HOME = configHome;
after(() => rmSync(configHome, { recursive: true, force: true }));

const BASE = "https://nano.example.com";
const WIN: BindableSource = { source_id: "a0000000-0000-4000-8000-000000000001", name: "Windows Event", source_type: "routed", route_key: "windows_event", enabled: true };
const SYSMON: BindableSource = { source_id: "a0000000-0000-4000-8000-000000000002", name: "Windows Sysmon", source_type: "routed", route_key: "windows_sysmon", enabled: true };

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  apiKey?: string;
}

/**
 * A stand-in for nano's ingest-token API (nanosiem #6582): list, create (a fresh `nit_` token
 * bound to the source), bind (unbound only). `mode` mimics an older nano.
 */
function fakeNano(opts: { mode?: "bound" | "no-sources" | "404"; sources?: BindableSource[]; tokens?: IngestTokenInfo[]; createStatus?: number } = {}) {
  const calls: Call[] = [];
  const tokens: IngestTokenInfo[] = [...(opts.tokens ?? [])];
  const sources = opts.sources ?? [WIN, SYSMON];
  let n = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, path: url.pathname, body, apiKey: headers["X-API-Key"] });
    if (opts.mode === "404") return json(404, { error: "not found" });
    if (method === "GET" && url.pathname === "/api/ingest-tokens") {
      return json(200, opts.mode === "no-sources" ? { tokens } : { tokens, install_token: { enabled: true, state: "unbound" }, sources });
    }
    if (method === "POST" && url.pathname === "/api/ingest-tokens") {
      if (opts.createStatus) return json(opts.createStatus, { error: "forbidden" });
      const source = sources.find((s) => s.source_id === body!.source_id)!;
      n += 1;
      const token = `nit_tok${n}xxxxSECRET${n}`;
      const credential: IngestTokenInfo = {
        credential_id: `cred-${n}`,
        name: String(body!.name),
        token_prefix: token.slice(0, 12),
        state: "active",
        source_id: source.source_id,
        source_name: source.name,
        route_key: source.route_key,
      };
      tokens.push(credential);
      return json(201, { credential, token });
    }
    const bind = /^\/api\/ingest-tokens\/([^/]+)\/bind$/.exec(url.pathname);
    if (method === "POST" && bind) {
      const cred = tokens.find((t) => t.credential_id === bind[1]);
      if (!cred) return json(404, {});
      if (cred.source_id) return json(409, {});
      const source = sources.find((s) => s.source_id === body!.source_id)!;
      Object.assign(cred, { source_id: source.source_id, route_key: source.route_key, state: "active" });
      return json(200, cred);
    }
    return json(404, {});
  }) as typeof fetch;
  return { calls, tokens };
}

function uplink(over: Partial<NanoUplink> = {}): NanoUplink {
  return { transport: "http", target: { host: "nano.example.com", port: 6000 }, ingestUrl: `${BASE}/ingest/`, tls: { enabled: true }, ...over };
}

const client = () => new NanoClient(BASE, { apiKey: "test-api-key" });
const types = ["windows_event", "windows_sysmon"];

beforeEach(() => {
  rmSync(join(configHome, "nano-connect"), { recursive: true, force: true });
});

test("each source type gets its own token bound to its own log source", async () => {
  const nano = fakeNano();
  const out = await attachSourceTokens(uplink(), { baseUrl: BASE, client: client(), sourceTypes: types, opts: { nonInteractive: true } });
  const creates = nano.calls.filter((c) => c.method === "POST" && c.path === "/api/ingest-tokens");
  assert.deepEqual(
    creates.map((c) => c.body!.source_id),
    [WIN.source_id, SYSMON.source_id],
  );
  assert.ok(creates.every((c) => c.apiKey === "test-api-key"));
  assert.ok(out.sourceTokens!.windows_event!.startsWith("nit_"));
  assert.notEqual(out.sourceTokens!.windows_event, out.sourceTokens!.windows_sysmon);
  assert.deepEqual(out.skipped, {});
  // Saved per instance so a re-run reuses instead of minting more.
  assert.equal(loadInstance(BASE).sourceTokens!.windows_event!.sourceId, WIN.source_id);
});

test("a re-run reuses the tokens it issued", async () => {
  const first = fakeNano();
  await attachSourceTokens(uplink(), { baseUrl: BASE, client: client(), sourceTypes: types, opts: { nonInteractive: true } });
  const second = fakeNano({ tokens: first.tokens });
  const out = await attachSourceTokens(uplink(), { baseUrl: BASE, client: client(), sourceTypes: types, opts: { nonInteractive: true } });
  assert.equal(second.calls.filter((c) => c.method === "POST").length, 0);
  assert.equal(out.sourceTokens!.windows_event, loadInstance(BASE).sourceTokens!.windows_event!.token);
});

test("an unbound token you pass is bound to the source, not reissued", async () => {
  const unbound: IngestTokenInfo = { credential_id: "old-1", name: "fw", token_prefix: "nit_oldtoken", state: "unbound", source_id: null };
  const nano = fakeNano({ tokens: [unbound] });
  const out = await attachSourceTokens(uplink(), {
    baseUrl: BASE,
    client: client(),
    sourceTypes: ["windows_event"],
    opts: { nonInteractive: true, sourceToken: "windows_event=nit_oldtoken-rest-of-it" },
  });
  const binds = nano.calls.filter((c) => c.path === "/api/ingest-tokens/old-1/bind");
  assert.equal(binds.length, 1);
  assert.equal(binds[0]!.body!.source_id, WIN.source_id);
  assert.equal(out.sourceTokens!.windows_event, "nit_oldtoken-rest-of-it");
  assert.equal(nano.calls.filter((c) => c.path === "/api/ingest-tokens" && c.method === "POST").length, 0);
});

test("--source-map sends a type to a log source with another route key", async () => {
  const nano = fakeNano();
  await attachSourceTokens(uplink(), {
    baseUrl: BASE,
    client: client(),
    sourceTypes: ["sysmon_custom"],
    opts: { nonInteractive: true, sourceMap: "sysmon_custom=Windows Sysmon" },
  });
  const create = nano.calls.find((c) => c.method === "POST" && c.path === "/api/ingest-tokens")!;
  assert.equal(create.body!.source_id, SYSMON.source_id);
});

test("no log source: a required type fails, an optional one is skipped", async () => {
  fakeNano({ sources: [WIN] });
  await assert.rejects(
    attachSourceTokens(uplink(), { baseUrl: BASE, client: client(), sourceTypes: types, opts: { nonInteractive: true } }),
    /No nano log source for windows_sysmon/,
  );
  fakeNano({ sources: [WIN] });
  const out = await attachSourceTokens(uplink(), {
    baseUrl: BASE,
    client: client(),
    sourceTypes: types,
    optional: ["windows_sysmon"],
    opts: { nonInteractive: true },
  });
  assert.deepEqual(Object.keys(out.sourceTokens!), ["windows_event"]);
  assert.ok(out.skipped!.windows_sysmon);
});

test("a key that can't issue tokens gets an actionable error", async () => {
  fakeNano({ createStatus: 403 });
  await assert.rejects(
    attachSourceTokens(uplink(), { baseUrl: BASE, client: client(), sourceTypes: types, opts: { nonInteractive: true } }),
    /settings:system.*--source-token windows_event=<token>/s,
  );
});

test("an older nano keeps the shared token and header routing", async () => {
  for (const mode of ["404", "no-sources"] as const) {
    const nano = fakeNano({ mode });
    const out = await attachSourceTokens(uplink({ ingestToken: "shared-install-token-0123" }), {
      baseUrl: BASE,
      client: client(),
      sourceTypes: types,
      opts: { nonInteractive: true },
    });
    assert.deepEqual(out.sourceTokens, { windows_event: "shared-install-token-0123", windows_sysmon: "shared-install-token-0123" });
    assert.equal(nano.calls.filter((c) => c.method === "POST").length, 0, mode);
  }
  fakeNano({ mode: "404" });
  await assert.rejects(
    attachSourceTokens(uplink(), { baseUrl: BASE, client: client(), sourceTypes: types, opts: { nonInteractive: true } }),
    /needs an ingest token/,
  );
});

test("native uplinks are left alone", async () => {
  const nano = fakeNano();
  const native: NanoUplink = { ...uplink(), transport: "native" };
  assert.equal(await attachSourceTokens(native, { baseUrl: BASE, client: client(), sourceTypes: types, opts: {} }), native);
  assert.equal(nano.calls.length, 0);
});
