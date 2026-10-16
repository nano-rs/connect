#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=connect.sh
source "$ROOT/connect.sh"
CONNECT_NO_JQ=1
export CONNECT_NO_JQ
assert_field() {
  local actual
  actual=$(printf '%s' "$2" | field "$1")
  [ "$actual" = "$3" ] || { printf 'FAIL field: %s\n' "$1" >&2; exit 1; }
}
assert_field route_key '{"nested":{"route_key":"wrong"},"route_key":"cisco_asa"}' cisco_asa
assert_field name '{"name":"brace } [ and escaped \"quote\""}' 'brace } [ and escaped "quote"'
assert_field enabled '{ "enabled" : true }' true
assert_field count '{"count":123}' 123
assert_field name '{"name":"a\\b\nc\td"}' $'a\\b\nc\td'
if printf '%s' '{"name":null}' | field name >/dev/null; then exit 1; fi
if printf '%s' '{"name":[]}' | field name >/dev/null; then exit 1; fi
if printf '%s' '{"name":"\u0061"}' | field name >/dev/null; then exit 1; fi
if printf '%s' '{}' | field missing >/dev/null; then exit 1; fi
if printf '%s' '{"tokens":null}' | records tokens >/dev/null; then exit 1; fi
r=$(printf '%s' '{"tokens":[{"name":"a}b","nested":{"n":1}},{"name":"b"}],"sources":[]}' | records tokens | wc -l | tr -d ' ')
[ "$r" = 2 ]
[ "$(printf '%s' '[{"name":"one"}]' | records unused | field name)" = one ]
[ "$(q $'a"b\\c\nd')" = '"a\"b\\c\nd"' ]
[ "$(printf '%s' 'a path/#?.yml' | encode_path)" = a%20path/%23%3F.yml ]
[ "$(hash_port routeros)" = 5642 ]
[ "$(hash_port custom-source)" = 5632 ]
printf 'PASS: JSON extraction/escaping and path units (%s)\n' "$BASH_VERSION"
