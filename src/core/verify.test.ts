import assert from "node:assert/strict";
import { test } from "node:test";
import type { NanoClient } from "./api.js";
import { classifyRow, countRecent, verifyMarker } from "./verify.js";

// Rows shaped like nano's search results on OCSF data: dotted top-level keys plus nested objects.
const authRow = {
  class_uid: 3002,
  "device.hostname": "lt-eng-025.corp.local",
  "user.name": "mjones",
  event: { metadata: { log_source: "windows_event" } },
  unmapped: { client_ip: "10.0.0.5" },
};

test("an OCSF event with a real class (3002) is parsed", () => {
  assert.equal(classifyRow(authRow).state, "parsed");
  assert.equal(classifyRow({ class_uid: "4002" }).state, "parsed");
});

test("class_uid 0 or missing is not counted as parsed", () => {
  assert.equal(classifyRow({ class_uid: 0, message: "x" }).state, "unknown");
  assert.equal(classifyRow({ message: "x" }).state, "unknown");
  assert.equal(classifyRow({ class_uid: null }).state, "unknown");
});

test("top-level legacy keys alone no longer count as parsed", () => {
  assert.equal(classifyRow({ src_ip: "10.0.0.1", user: "mjones" }).state, "unknown");
});

test("the generic lane is reported as generic", () => {
  assert.equal(classifyRow({ metadata: { parser_type: "generic" } }).state, "generic");
  assert.equal(classifyRow({ "metadata.parser_type": "generic" }).state, "generic");
  assert.equal(classifyRow({ metadata: '{"parser_type":"generic"}' }).state, "generic");
});

test("an OCSF parse failure is read from unmapped.parse_error (nested or dotted)", () => {
  assert.deepEqual(classifyRow({ class_uid: 0, unmapped: { parse_error: "bad shape" } }), {
    state: "failed",
    error: "bad shape",
  });
  assert.deepEqual(classifyRow({ "unmapped.parse_error": "bad shape" }), {
    state: "failed",
    error: "bad shape",
  });
  assert.equal(classifyRow({ metadata: { parse_error: "not json" } }).state, "failed");
  assert.equal(classifyRow({ class_uid: 3002, unmapped: { parse_error: "" } }).state, "parsed");
});

test("an unmapped.parse_fallback marker counts as a failure; false does not", () => {
  assert.equal(classifyRow({ class_uid: 0, unmapped: { parse_fallback: true } }).state, "failed");
  assert.equal(classifyRow({ class_uid: 4002, unmapped: { parse_fallback: false } }).state, "parsed");
});

// What the OCSF generic lane actually stores: metadata rebuilt as { log_source }, the original
// record (marker and any parse error included) kept under `unmapped`.
const genericOcsfRow = {
  class_uid: 0,
  metadata: { log_source: "fooba" },
  unmapped: { metadata: { parser_type: "generic", original_source_type: "fooba" }, message: "x" },
};

test("the OCSF generic lane row (marker under unmapped.metadata) is generic", () => {
  assert.equal(classifyRow(genericOcsfRow).state, "generic");
  assert.equal(classifyRow({ class_uid: 0, "unmapped.metadata.parser_type": "generic" }).state, "generic");
  assert.equal(classifyRow({ class_uid: 0, unmapped: { "metadata.parser_type": "generic" } }).state, "generic");
});

test("a pre-OCSF failure routed through the generic lane is a failure, not generic", () => {
  const row = {
    ...genericOcsfRow,
    unmapped: { metadata: { parser_type: "generic", parse_error: "not json" } },
  };
  assert.deepEqual(classifyRow(row), { state: "failed", error: "not json" });
});

function fakeClient(results: Record<string, unknown>[], queries: string[]): NanoClient {
  return {
    search: async (query: string) => {
      queries.push(query);
      return { results } as never;
    },
  } as unknown as NanoClient;
}

test("countRecent searches metadata.log_source and tallies OCSF rows", async () => {
  const queries: string[] = [];
  const rows = [
    authRow,
    { class_uid: 0 },
    { metadata: { parser_type: "generic" } },
    { class_uid: 0, unmapped: { parse_error: "format mismatch" } },
  ];
  const r = await countRecent(fakeClient(rows, queries), "windows_event");
  assert.deepEqual(queries, ['metadata.log_source="windows_event"']);
  assert.equal(r.count, 4);
  assert.equal(r.parsed, 1);
  assert.equal(r.generic, 1);
  assert.equal(r.parseFailed, 1);
  assert.equal(r.parseError, "format mismatch");
});

test("verifyMarker searches metadata.log_source", async () => {
  const queries: string[] = [];
  const r = await verifyMarker(
    fakeClient([{ class_uid: 0, raw_data: "nano-connect marker-123" }], queries),
    "cisco_asa",
    "marker-123",
    { timeoutMs: 5_000 },
  );
  assert.equal(r.arrived, true);
  assert.deepEqual(queries, ['metadata.log_source="cisco_asa"']);
});
