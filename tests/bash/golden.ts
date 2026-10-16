// Test-time TypeScript only: snapshot collection semantics from the retained CLI.
import { writeFileSync } from 'node:fs';
import { buildVectorToml } from '../../src/core/syslog.js';
import { buildLinuxAgentToml, buildWindowsAgentToml } from '../../src/core/agent.js';
import { buildAggregatorToml } from '../../src/core/aggregator.js';
import { SYSLOG_CATALOG } from '../../src/core/catalog.js';
const uplink = { transport: 'http' as const, target: {host:'nano.test',port:6000}, ingestUrl:'https://nano.test/ingest/', tls:{enabled:true} };
const common = {uplink,bufferBytes:268435488,image:'unused'};
const plans = {
  syslog:buildVectorToml({...common,catalog:SYSLOG_CATALOG,selected:[SYSLOG_CATALOG[0]!]},'fixture'),
  linux:buildLinuxAgentToml({...common,journald:true,files:[]},'fixture'),
  windows:buildWindowsAgentToml({...common,channels:['Application','System','Security','Microsoft-Windows-Sysmon/Operational','Microsoft-Windows-PowerShell/Operational','Microsoft-Windows-Windows Defender/Operational']},'fixture'),
  aggregator:buildAggregatorToml({...common,agentPort:9000,syslogCatalog:SYSLOG_CATALOG,syslogSelected:[SYSLOG_CATALOG[0]!]},'fixture'),
};
for (const [name,body] of Object.entries(plans)) writeFileSync(new URL(`./fixtures/ts-${name}.toml`,import.meta.url),body);
