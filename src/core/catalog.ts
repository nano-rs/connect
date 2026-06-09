/**
 * Catalog of common syslog-emitting device types.
 *
 * Each gets its own listener port (port-per-source) because (a) Vector's `syslog` source binds
 * one address + one mode + one framing, so vendors that differ in protocol/framing can't share a
 * listener, and (b) the syslog source hard-codes `source_type = "syslog"` — so the only reliable
 * way to tag which vendor sent an event is to know it from the port it arrived on, then stamp the
 * real source_type in a per-port transform.
 *
 * Ports start at 5514 (unprivileged) so the collector never needs root. There is deliberately no
 * :514 / catch-all listener — operators enable exactly the inputs they need.
 */
export interface DeviceType {
  /** Stable id; also the Vector source/transform name base. */
  id: string;
  label: string;
  /** Value stamped onto `.source_type` — what nano routes parsers on. */
  sourceType: string;
  port: number;
  mode: "udp" | "tcp";
  note?: string;
}

export const SYSLOG_CATALOG: DeviceType[] = [
  { id: "cisco_asa", label: "Cisco ASA / FTD firewall", sourceType: "cisco_asa", port: 5514, mode: "udp" },
  {
    // source_type aligned to the community parser's canonical name (nano-rs/parsers: palo_alto).
    id: "palo_alto",
    label: "Palo Alto PAN-OS firewall",
    sourceType: "palo_alto",
    port: 5515,
    mode: "tcp",
    note: "PAN-OS can emit UDP/TCP/TLS; this defaults to TCP. Switch mode if your firewall uses UDP.",
  },
  { id: "fortinet", label: "Fortinet FortiGate", sourceType: "fortinet", port: 5516, mode: "udp" },
  { id: "cisco_ios", label: "Cisco IOS switch / router", sourceType: "cisco_ios", port: 5517, mode: "udp" },
  { id: "juniper_srx", label: "Juniper SRX", sourceType: "juniper_srx", port: 5518, mode: "udp" },
  { id: "sonicwall", label: "SonicWall firewall", sourceType: "sonicwall", port: 5519, mode: "udp" },
  {
    id: "pfsense",
    label: "pfSense / OPNsense",
    sourceType: "pfsense",
    port: 5520,
    mode: "udp",
    note: "pfSense uses RFC 5424; if you see framing errors, try TCP.",
  },
  { id: "linux_syslog", label: "Linux / Unix syslog (rsyslog, syslog-ng)", sourceType: "linux_syslog", port: 5521, mode: "udp" },
  { id: "f5_bigip", label: "F5 BIG-IP", sourceType: "f5_bigip", port: 5522, mode: "tcp" },
];
