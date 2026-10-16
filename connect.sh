#!/usr/bin/env bash
# nano-connect: standalone Bash 3.2+ client. Apache-2.0.
# Never enable xtrace: credentials pass through shell variables and private files.
set +x
set -euo pipefail
umask 077
VERSION=0.4.0
VECTOR_IMAGE='timberio/vector:0.59.0-alpine@sha256:0e36bc2a290039e9b6a5e92f04bd2f133223506f72d09682c1df16c015172b7a'
fail() { printf 'connect: %s\n' "$*" >&2; exit 1; }
note() { if [ -t 1 ] && [ -z "${NO_COLOR+x}" ]; then printf '\033[36m%s\033[0m\n' "$*"; else printf '%s\n' "$*"; fi; }
# Known API field extractor: no evaluation, no external JSON runtime. Only
# immediate scalar fields are accepted; arrays/objects have a separate scanner.
# Unicode escapes are deliberately refused without jq rather than mis-decoded.
field() {
  if command -v jq >/dev/null 2>&1 && [ "${CONNECT_NO_JQ:-0}" != 1 ]; then
    jq -er --arg k "$1" 'if has($k) and .[$k] != null then .[$k] | if type == "string" or type == "boolean" or type == "number" then tostring else empty end else empty end' 2>/dev/null
  else
    awk -v want="$1" '
    function string(   c,o,e) {
      o=""; i++
      while(i<=length(s)) {
        c=substr(s,i++,1)
        if(c=="\"") return o
        if(c=="\\") {
          e=substr(s,i++,1)
          if(e=="u") { bad=1; return "" }
          if(e=="n") c="\n"; else if(e=="r") c="\r"; else if(e=="t") c="\t"
          else if(e=="\"" || e=="\\" || e=="/") c=e
          else { bad=1; return "" }
        }
        o=o c
      }
      bad=1; return ""
    }
    {s=s $0 "\n"}
    END {
      depth=0
      for(i=1;i<=length(s);) {
        c=substr(s,i,1)
        if(c=="{" || c=="[") {depth++; i++; continue}
        if(c=="}" || c=="]") {depth--; i++; continue}
        if(c!="\"") {i++; continue}
        key=string(); if(bad) exit 1
        while(substr(s,i,1) ~ /[ \t\r\n]/) i++
        if(depth!=1 || key!=want || substr(s,i,1)!=":") continue
        i++; while(substr(s,i,1) ~ /[ \t\r\n]/) i++
        if(substr(s,i,1)=="\"") {v=string(); if(bad) exit 1; print v; exit 0}
        tail=substr(s,i)
        if(match(tail,/^(true|false|-?[0-9]+([.][0-9]+)?)/)) {print substr(tail,1,RLENGTH); exit 0}
        exit 1
      }
      exit 1
    }'
  fi
}
# Extract a known named array (or a bare array), then emit its immediate objects.
# Nested objects, escaped quotes, and braces inside strings do not split records.
records() {
  awk -v key="$1" '
  {s=s $0 "\n"}
  END {
    start=1
    if(s !~ /^[ \r\n\t]*\[/) {
      pat="\"" key "\"[ \t\r\n]*:[ \t\r\n]*\\["
      if(!match(s,pat)) exit 1
      start=RSTART+RLENGTH-1
    }
    instr=0; esc=0; depth=0; begin=0; array=0
    for(i=start;i<=length(s);i++) {
      c=substr(s,i,1)
      if(instr) {if(esc) esc=0; else if(c=="\\") esc=1; else if(c=="\"") instr=0; continue}
      if(c=="\"") {instr=1; continue}
      if(c=="[") array++
      if(c=="]") {array--; if(array==0) exit 0}
      if(c=="{") {if(depth==0) begin=i; depth++}
      if(c=="}") {depth--; if(depth==0 && begin) {r=substr(s,begin,i-begin+1); gsub(/\n/," ",r); print r; begin=0}}
    }
    exit 1
  }'
}
quote() {
  # JSON string encoder, also valid for TOML basic strings.
  LC_ALL=C awk 'BEGIN {printf "\""} {if(NR>1) printf "\\n"; for(i=1;i<=length($0);i++) {c=substr($0,i,1); if(c=="\\") printf "\\\\"; else if(c=="\"") printf "\\\""; else if(c=="\t") printf "\\t"; else if(c=="\r") printf "\\r"; else printf "%s",c}} END {printf "\""}'
}
q() { printf '%s' "$1" | quote; }
get() { printf '%s' "$2" | field "$1"; }
safe_id() { [[ "$1" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || fail 'Invalid source identifier'; }
port_check() {
  if ! [[ "$1" =~ ^[0-9]{1,5}$ ]] || [ "$1" -le 0 ] || [ "$1" -gt 65535 ]; then fail 'Invalid port'; fi
}
url_check() {
  case "$1" in http://*|https://*) ;; *) fail 'URL must use http:// or https://' ;; esac
  local authority=${1#*://}
  authority=${authority%%/*}
  [ -n "$authority" ] || fail 'URL needs a host'
  case "$authority" in *@*) fail 'URL must not contain credentials' ;; esac
  [[ "$1" != *[$'\r\n\t ']* && "$1" != *'"'* && "$1" != *\\* && "$1" != *'?'* && "$1" != *'#'* ]] || fail 'Invalid URL'
}
private_dir() { [ ! -L "$1" ] || fail 'Refusing symlink directory'; mkdir -p "$1"; chmod 700 "$1"; }
atomic() {
  local dest=$1 tmp
  [ ! -L "$dest" ] || fail 'Refusing symlink file'
  tmp=$(mktemp "${dest}.XXXXXX")
  cat > "$tmp"; chmod 600 "$tmp"; mv -f "$tmp" "$dest"
}
prompt() {
  local label=$1 default=${2:-} secret=${3:-0} answer
  if [ "$NONINTERACTIVE" != 0 ] || [ ! -t 0 ]; then fail "Missing required value: $label"; fi
  printf '%s [%s]: ' "$label" "$default" >&2
  if [ "$secret" = 1 ]; then read -r -s answer || fail 'Input ended'; printf '\n' >&2; else read -r answer || fail 'Input ended'; fi
  printf '%s' "${answer:-$default}"
}
confirm() {
  [ "$YES" = 1 ] && return 0
  [ "$NONINTERACTIVE" = 0 ] || return 1
  local answer
  answer=$(prompt "$1 (yes/no)" no)
  [ "$answer" = yes ]
}
# All credentials/body data are passed in private files, never curl argv or logs.
request() {
  local method=$1 endpoint=$2 body=${3:-} auth=${4:-api} header
  url_check "$endpoint"
  header=$WORK/headers
  : > "$header"
  case "$auth" in
    api) [ -z "$API_KEY" ] || printf 'X-API-Key: %s\n' "$API_KEY" >> "$header" ;;
    jwt) printf 'Authorization: Bearer %s\n' "$JWT" >> "$header" ;;
    ingest) printf 'Authorization: Bearer %s\n' "$TOKEN" >> "$header" ;;
    hec) printf 'Authorization: Splunk %s\n' "$TOKEN" >> "$header" ;;
  esac
  printf 'Content-Type: application/json\n' >> "$header"
  printf '%s' "$body" > "$WORK/body"
  HTTP_CODE=$(curl --silent --show-error --connect-timeout 8 --max-time 25 --proto '=http,https' \
    --request "$method" --header "@$header" --data-binary "@$WORK/body" \
    --output "$WORK/response" --write-out '%{http_code}' "$endpoint" 2> "$WORK/curl-error") || fail 'Request failed (network or TLS); response details withheld'
  RESPONSE=$(cat "$WORK/response")
  case "$HTTP_CODE" in 2??) return 0 ;; *) return 1 ;; esac
}
api() { request "$1" "$URL/api/$2" "${3:-}" || fail "API request failed (HTTP $HTTP_CODE); check permissions and server version"; }
require_key() {
  if [ -z "$API_KEY" ]; then
    if [ -n "$EMAIL" ]; then
      [ -n "$PASSWORD" ] || PASSWORD=$(prompt 'nano password (or NANO_PASSWORD)' '' 1)
      request POST "$URL/api/auth/login" "{\"email\":$(q "$EMAIL"),\"password\":$(q "$PASSWORD")}" none || fail 'Login rejected'
      JWT=$(printf '%s' "$RESPONSE" | sed 's/"tokens"[[:space:]]*:/"tokens":/')
      # access_token is nested: isolate tokens with the known response object.
      JWT=$(printf '%s' "$RESPONSE" | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p')
      [ -n "$JWT" ] || fail 'Login response missing access token'
      confirm 'Create nano-connect API key with search, parser and settings:system permissions?' || fail 'API key creation declined; provide NANO_API_KEY'
      request POST "$URL/api/api-keys" '{"name":"nano-connect","permissions":["search:execute","log_sources:view","parser_repositories:view","parser_repositories:sync","parser_repositories:manage","parser_repositories:import","log_sources:create","source_configs:edit","log_sources:deploy","settings:system"]}' jwt || fail 'Cannot create API key; provide an administrator key'
      API_KEY=$(get key "$RESPONSE") || fail 'API key response missing key'
      PASSWORD=''; JWT=''
    else
      API_KEY=$(prompt 'nano API key (or NANO_API_KEY)' '' 1)
    fi
  fi
  [[ "$API_KEY" != *[$'\r\n']* ]] || fail 'Invalid API key'
}
profile() {
  # Own format: never source/eval a dotenv, profile, or downloaded file.
  if [ -n "$ENV_FILE" ]; then
    [ -f "$ENV_FILE" ] || fail 'Missing env file'
    if [ -z "$URL" ]; then URL=$(sed -n 's/^BASE_URL=//p' "$ENV_FILE" | head -1 | sed 's/^['"'"'\"]//;s/['"'"'\"]$//'); fi
  fi
  [ -n "$URL" ] || { [ ! -f "$CONFIG/current" ] || URL=$(cat "$CONFIG/current"); }
  [ -n "$URL" ] || URL=$(prompt 'nano URL (or NANO_URL)' 'https://nano.example.com')
  case "$URL" in http://*|https://*) ;; *) URL=https://$URL ;; esac
  URL=${URL%/}; url_check "$URL"
  # Full URL encoded into a stable instance identity; never cross-load credentials.
  INSTANCE=$(printf '%s' "$URL" | cksum | awk '{print $1 "-" $2}')
  STATE=$CONFIG/$INSTANCE
  private_dir "$CONFIG"; private_dir "$STATE"
  if [ -f "$STATE/url" ]; then [ "$(cat "$STATE/url")" = "$URL" ] || fail 'Instance identity collision'; fi
  printf '%s' "$URL" | atomic "$STATE/url"
  [ -n "$API_KEY" ] || { [ ! -f "$STATE/api-key" ] || API_KEY=$(cat "$STATE/api-key"); }
  require_key
  printf '%s' "$API_KEY" | atomic "$STATE/api-key"
  printf '%s' "$URL" | atomic "$CONFIG/current"
  [ -n "$SEARCH_URL" ] || { [ ! -f "$STATE/search-url" ] || SEARCH_URL=$(cat "$STATE/search-url"); }
  [ -n "$INGEST_URL" ] || { [ ! -f "$STATE/ingest-$TRANSPORT-url" ] || INGEST_URL=$(cat "$STATE/ingest-$TRANSPORT-url"); }
  [ -n "$SEARCH_URL" ] || SEARCH_URL=$URL/api/search
  [ -n "$INGEST_URL" ] || { if [ "$TRANSPORT" = http ]; then INGEST_URL=$URL/ingest/; else INGEST_URL=$URL; fi; }
  url_check "$INGEST_URL"; url_check "$SEARCH_URL"
  printf '%s' "$SEARCH_URL" | atomic "$STATE/search-url"
  printf '%s' "$INGEST_URL" | atomic "$STATE/ingest-$TRANSPORT-url"
}
catalog() {
  printf '%s\n' 'cisco_asa 5514 udp' 'palo_alto 5515 tcp' 'fortinet 5516 udp' 'cisco_ios 5517 udp' 'juniper_srx 5518 udp' 'sonicwall 5519 udp' 'pfsense 5520 udp' 'linux_syslog 5521 udp' 'f5_bigip 5522 tcp'
}
# Only enabled bindable sources can receive credentials.
load_tokens() {
  api GET ingest-tokens
  LISTING=$RESPONSE
  printf '%s' "$LISTING" | records sources > "$WORK/sources" || fail 'Server lacks source-bound credential API (NAN-3806); upgrade nano'
  printf '%s' "$LISTING" | records tokens > "$WORK/tokens" || fail 'Malformed token listing'
}
source_id() {
  local row route enabled found=
  while IFS= read -r row; do
    route=$(get route_key "$row" || :); enabled=$(get enabled "$row" || :)
    if [ "$route" = "$1" ] && [ "$enabled" = true ]; then
      [ -z "$found" ] || fail 'Ambiguous enabled source route'
      found=$(get source_id "$row") || fail 'Missing source id'
    fi
  done < "$WORK/sources"
  [ -n "$found" ] || return 1
  printf '%s' "$found"
}
persist_artifact_token() {
  case "$COMMAND" in add-source|add-agent|add-aggregator|otlp-config|rotate-token)
    printf '%s' "$TOKEN" | atomic "$OUT/secrets/$1" ;;
  esac
}
retire_pending() {
  local st=$1 cid=$2 pending=$STATE/credentials/$1/pending-revoke old row
  [ -f "$pending" ] || return 0
  old=$(cat "$pending"); safe_id "$old"
  # A crash before the replacement record was persisted leaves old == current.
  [ "$old" != "$cid" ] || return 0
  row=$(find_credential credential_id "$old" || :)
  if [ -n "$row" ] && [ "$(get state "$row" || :)" != revoked ]; then
    [ "$(get route_key "$row" || :)" = "$st" ] || fail 'Pending revocation belongs to another source'
    api POST "ingest-tokens/$old/revoke"
  fi
  rm -f "$pending"
}
find_credential() {
  local row value found=
  while IFS= read -r row; do
    value=$(get "$1" "$row" || :)
    if [ "$value" = "$2" ]; then [ -z "$found" ] || fail 'Ambiguous credential'; found=$row; fi
  done < "$WORK/tokens"
  [ -n "$found" ] || return 1
  printf '%s' "$found"
}
credential() {
  local st=$1 sid row='' old='' cid='' value='' prefix state
  safe_id "$st"
  sid=$(source_id "$st") || fail "No enabled bindable source for $st; deploy its parser first"
  safe_id "$sid"
  private_dir "$STATE/credentials"; private_dir "$STATE/credentials/$st"
  local store=$STATE/credentials/$st/current
  if [ -n "$TOKEN_DIR" ] && [ -f "$TOKEN_DIR/$st" ]; then
    [ "$ROTATE" = 0 ] || fail 'To rotate a managed credential, omit --token-dir'
    value=$(cat "$TOKEN_DIR/$st")
    [[ "$value" =~ ^nit_[A-Za-z0-9_-]+$ ]] || fail 'Supplied token is not a named nano credential'
    prefix=${value:0:12}
    row=$(find_credential token_prefix "$prefix") || fail 'Supplied credential is not listed by this instance'
    cid=$(get credential_id "$row"); safe_id "$cid"
    state=$(get state "$row")
    if [ "$state" = unbound ]; then
      api POST "ingest-tokens/$cid/bind" "{\"source_id\":$(q "$sid")}"; load_tokens
      row=$(find_credential credential_id "$cid") || fail 'Bound credential not found'
    fi
    if [ "$(get state "$row")" != active ] || [ "$(get source_id "$row")" != "$sid" ]; then fail 'Supplied token belongs to another source or is inactive'; fi
  elif [ -f "$store" ]; then
    { IFS= read -r cid; IFS= read -r value; } < "$store"
    safe_id "$cid"
    row=$(find_credential credential_id "$cid" || :)
    if [ -n "$row" ] && [ "$(get state "$row")" = active ] && [ "$(get source_id "$row" || :)" = "$sid" ]; then
      [ "$(get token_prefix "$row" || :)" = "${value:0:12}" ] || fail 'Stored token does not match credential metadata'
      TOKEN=$value
      persist_artifact_token "$st"
      retire_pending "$st" "$cid"
      if [ "$ROTATE" = 0 ]; then return; fi
      old=$cid
    fi
    cid=''; value=''
  fi
  if [ -z "$value" ]; then
    api POST ingest-tokens "{\"name\":$(q "nano-connect-$st-$(date +%s)"),\"source_id\":$(q "$sid")}"
    value=$(get token "$RESPONSE") || fail 'Create response missing token'
    # credential_id is inside credential; known narrow extraction, no eval.
    cid=$(printf '%s' "$RESPONSE" | sed -n 's/.*"credential_id"[[:space:]]*:[[:space:]]*"\([a-zA-Z0-9_-]*\)".*/\1/p')
    [ -n "$cid" ] || fail 'Create response missing credential id'
    safe_id "$cid"; load_tokens
    row=$(find_credential credential_id "$cid") || fail 'Issued credential absent from listing'
    if [ "$(get state "$row")" != active ] || [ "$(get source_id "$row" || :)" != "$sid" ]; then fail 'Issued credential not active or bound correctly'; fi
  fi
  [[ "$value" =~ ^nit_[A-Za-z0-9_-]+$ ]] || fail 'Invalid credential token'
  # One atomic record contains both id and secret; no split-state rotation window.
  if [ -n "$old" ]; then printf '%s' "$old" | atomic "$STATE/credentials/$st/pending-revoke"; fi
  printf '%s\n%s\n' "$cid" "$value" | atomic "$store"
  TOKEN=$value
  # The generated artifact secret is persisted before revocation too.
  persist_artifact_token "$st"
  retire_pending "$st" "$cid"
}
# Parser catalog APIs are optional for listing but provisioning always fails closed.
load_catalog() {
  : > "$WORK/deployed"; : > "$WORK/parsers"; REPO_ID=
  if request GET "$URL/api/log-sources"; then
    printf '%s' "$RESPONSE" | records log_sources > "$WORK/deployed" || :
  fi
  if request GET "$URL/api/parser-repositories"; then
    local row enabled rid fallback=''
    printf '%s' "$RESPONSE" | records repositories > "$WORK/repos" || return 0
    while IFS= read -r row; do
      enabled=$(get enabled "$row" || :); [ "$enabled" != false ] || continue
      rid=$(get id "$row" || :); [ -n "$rid" ] || continue
      [ -n "$fallback" ] || fallback=$rid
      case "$(get url "$row" || :)" in *nano-rs/parsers*) REPO_ID=$rid; break ;; esac
    done < "$WORK/repos"
    [ -n "$REPO_ID" ] || REPO_ID=$fallback
    if [ -n "$REPO_ID" ]; then
      safe_id "$REPO_ID"
      if request GET "$URL/api/parser-repositories/$REPO_ID/parsers"; then
        printf '%s' "$RESPONSE" | records parsers > "$WORK/parsers" || :
      fi
    fi
  fi
}
# Known match_values field only. Accept either API array strings or YAML block aliases.
aliases() {
  local raw
  raw=$(get raw_content "$1" || :)
  printf '%s\n' "$raw" | awk '
    /^match_values:[ \t]*$/ {on=1; next}
    on && /^[ \t]*-[ \t]*/ {sub(/^[ \t]*-[ \t]*/, ""); gsub(/["\047]/, ""); print; next}
    on {exit}'
  printf '%s' "$1" | sed -n 's/.*"match_values"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | sed 's/^[[:space:]]*"//;s/"[[:space:]]*$//'
}
lookup_in() {
  local want=$1 file=$2 row name alias
  [ -f "$file" ] || return 1
  while IFS= read -r row; do
    [ "$(get kind "$row" || :)" != enrichment ] || continue
    name=$(get name "$row" || :)
    if [ "$name" = "$want" ]; then printf '%s' "$row"; return; fi
    while IFS= read -r alias; do
      if [ "$alias" = "$want" ]; then printf '%s' "$row"; return; fi
    done < <(aliases "$row")
  done < "$file"
  return 1
}
lookup_parser() { lookup_in "$1" "$WORK/parsers"; }
syslog_collectable() {
  local raw category
  raw=$(get raw_content "$1" || :)
  if printf '%s\n' "$raw" | grep -q '^transports:'; then
    printf '%s\n' "$raw" | awk '/^transports:/ {on=1; if($0 ~ /syslog/) ok=1; next} on && /^[ \t]*-/ {if($0 ~ /syslog/) ok=1; next} on {on=0} END {exit !ok}'
  else
    category=$(printf '%s\n' "$raw" | sed -n 's/^category:[[:space:]]*//p' | tr -d "\"'")
    case "$category" in cloud|endpoint|application) return 1 ;; esac
  fi
}
encode_path() {
  # Percent-encode every byte except RFC3986 unreserved and slash, preserving
  # axum catch-all path segments. Used only for repository parser paths.
  LC_ALL=C od -An -v -tu1 | awk '{for(i=1;i<=NF;i++) {n=$i; if((n>=48&&n<=57)||(n>=65&&n<=90)||(n>=97&&n<=122)||n==45||n==46||n==95||n==126||n==47) printf "%c",n; else printf "%%%02X",n}}'
}
review_parser() {
  local st=$1 row path id
  if source_id "$st" >/dev/null; then return; fi
  row=$(lookup_parser "$st" || :)
  [ -n "$row" ] || fail "No bindable source or community parser for $st"
  [ "$DEPLOY_PARSERS" = 1 ] || confirm "Import and publish parser for $st?" || fail 'Deploy the parser first, or pass --deploy-parsers'
  path=$(get file_path "$row") || fail 'Parser file path missing'
  case "$path" in /*|*../*|*/..|..) fail 'Unsafe parser path' ;; esac
  path=$(printf '%s' "$path" | encode_path)
  api POST "parser-repositories/$REPO_ID/parsers/import/$path" '{"import_type":"linked","ingestion_method":"routed"}'
  id=$(get log_source_id "$RESPONSE") || fail 'Import response missing log source id'; safe_id "$id"
  api POST "log-sources/$id/publish"
  [ "$(get success "$RESPONSE" || :)" = true ] || fail 'Parser publish failed; source is not ready'
  load_tokens
  source_id "$st" >/dev/null || fail 'Published parser has no enabled credential binding'
}
target_check() {
  local host port
  case "$TARGET" in
    \[*\]:*) host=${TARGET%:*}; port=${TARGET##*:} ;;
    *:*:*) host=[$TARGET]; port=9000 ;;
    *:*) host=${TARGET%:*}; port=${TARGET##*:} ;;
    *) host=$TARGET; port=9000 ;;
  esac
  [[ "$host" != *[!A-Za-z0-9._:\[\]-]* && -n "$host" ]] || fail 'Invalid aggregator host'
  port_check "$port"; TARGET=$host:$port
}
hash_port() {
  local h=2166136261 byte
  while IFS= read -r byte; do
    [ -n "$byte" ] || continue
    h=$(( ((h ^ byte) * 16777619) & 4294967295 ))
  done < <(printf '%s' "$1" | od -An -v -tu1 | tr -s ' ' '\n')
  printf '%s' "$((5600 + h % 100))"
}
canonical_source() {
  local st=$1 row id item
  if source_id "$st" >/dev/null; then printf '%s' "$st"; return; fi
  row=$(lookup_in "$st" "$WORK/deployed" || :)
  if [ -n "$row" ]; then
    id=$(get id "$row" || :)
    while IFS= read -r item; do
      if [ "$(get source_id "$item" || :)" = "$id" ]; then get route_key "$item"; return; fi
    done < "$WORK/sources"
  fi
  row=$(lookup_parser "$st" || :)
  if [ -n "$row" ]; then get name "$row"; else printf '%s' "$st"; fi
}
select_sources() {
  catalog > "$WORK/catalog"
  if [ -z "$SOURCES" ]; then
    if [ "$COMMAND" = add-source ]; then SOURCES=$(catalog | awk '{print $1}' | paste -sd, -); else SOURCES=; fi
    if [ "$NONINTERACTIVE" = 0 ]; then SOURCES=$(prompt 'Comma-separated syslog sources (--sources)' "$SOURCES"); fi
  fi
  : > "$WORK/selected"
  local selector st mode hit row assigned=5600
  local selectors
  selectors=$(printf '%s' "$SOURCES" | tr ',' '\n')
  while IFS= read -r selector; do
    selector=$(printf '%s' "$selector" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')
    [ -n "$selector" ] || continue
    st=${selector%%:*}; safe_id "$st"; mode=
    case "$selector" in *:*) mode=${selector#*:}; case "$mode" in udp|tcp) ;; *) fail 'Use :udp or :tcp' ;; esac ;; esac
    hit=$(awk -v st="$st" '$1==st {print}' "$WORK/catalog")
    if [ -z "$hit" ]; then st=$(canonical_source "$st"); safe_id "$st"; fi
    if awk -v st="$st" '$1==st {found=1} END {exit !found}' "$WORK/selected"; then continue; fi
    hit=$(awk -v st="$st" '$1==st {print}' "$WORK/catalog")
    if [ -z "$hit" ]; then
      local parser_row
      parser_row=$(lookup_parser "$st" || :)
      if [ -n "$parser_row" ]; then syslog_collectable "$parser_row" || fail 'This parser is not a syslog source; use its endpoint/cloud integration'; fi
      if ! source_id "$st" >/dev/null; then
        [ -n "$parser_row" ] || fail "Unknown syslog source: $st"
      fi
      # Stable checksum-based ports, collision probe within a separate range.
      assigned=$(hash_port "$st")
      local probes=0
      while awk -v p="$assigned" '$2==p {found=1} END {exit !found}' "$WORK/selected"; do
        assigned=$((5600 + (assigned - 5599) % 100))
        probes=$((probes + 1)); [ "$probes" -lt 100 ] || fail 'Discovered syslog port range exhausted'
      done
      hit="$st $assigned udp"
    fi
    if [ -n "$mode" ]; then hit=$(printf '%s\n' "$hit" | awk -v m="$mode" '{print $1,$2,m}'); fi
    printf '%s\n' "$hit" >> "$WORK/selected"
  done <<< "$selectors"
}
render_socket() {
  local st=$1 port=$2 mode=$3
  cat <<EOF
[sources.$st]
type = "socket"
mode = "$mode"
address = "0.0.0.0:$port"
[sources.$st.decoding]
codec = "bytes"
[transforms.${st}_tag]
type = "remap"
inputs = ["$st"]
source = '''
.source_type = "$st"
.src_host = to_string(.host) ?? ""
'''

EOF
}
render_sink() {
  local st=$1 input=$2
  if [ "$TRANSPORT" = hec ]; then
    cat <<EOF
[sinks.nano_$st]
type = "splunk_hec_logs"
inputs = ["$input"]
endpoint = $(q "$INGEST_URL")
default_token = "SECRET[nano_ingest.$st]"
sourcetype = "$st"
host_key = "src_host"
encoding.codec = "text"
compression = "gzip"
acknowledgements.enabled = true
acknowledgements.indexer_acknowledgements_enabled = true
EOF
  else
    cat <<EOF
[sinks.nano_$st]
type = "http"
inputs = ["$input"]
uri = $(q "$INGEST_URL")
method = "post"
encoding.codec = "text"
framing.method = "newline_delimited"
auth.strategy = "bearer"
auth.token = "SECRET[nano_ingest.$st]"
request.headers.Content-Type = "text/plain"
EOF
  fi
  cat <<EOF
[sinks.nano_$st.buffer]
type = "disk"
max_size = 268435488
when_full = "block"

EOF
}
file_includes() {
  local path sep=''
  while IFS= read -r path; do
    [ -n "$path" ] || fail 'Empty file path'
    printf '%s' "$sep"; q "$path"; sep=', '
  done < <(printf '%s\n' "$FILES" | tr ',' '\n')
}
render_agent() {
  if [ "$OS" = windows ]; then
    cat <<'EOF'
[sources.windows_events]
type = "windows_event_log"
channels = ["Application", "System", "Security", "Microsoft-Windows-Sysmon/Operational", "Microsoft-Windows-PowerShell/Operational", "Microsoft-Windows-Windows Defender/Operational"]
read_existing_events = false
[transforms.tag]
type = "remap"
inputs = ["windows_events"]
source = '''
channel = downcase(to_string(.channel) ?? "")
source_type = "windows_event"
if contains(channel, "sysmon") { source_type = "windows_sysmon" }
host = get_hostname!()
event_json = encode_json(.)
. = {}
.message = event_json
.source_type = source_type
.src_host = host
'''
EOF
  elif [ "$JOURNALD" = 1 ]; then
    cat <<'EOF'
[sources.journald]
type = "journald"
[transforms.tag]
type = "remap"
inputs = ["journald"]
source = '''
ident = downcase(string(.SYSLOG_IDENTIFIER) ?? "")
unit = downcase(string(._SYSTEMD_UNIT) ?? "")
source_type = "linux_journald"
if contains(ident, "sysmon") || contains(unit, "sysmon") { source_type = "linux_sysmon" }
.source_type = source_type
.src_host = get_hostname!()
'''
EOF
  fi
  if [ -n "$FILES" ]; then
    cat <<EOF
[sources.files]
type = "file"
include = [$(file_includes)]
[transforms.files_tag]
type = "remap"
inputs = ["files"]
source = '''
.source_type = "$FILE_SOURCE"
.src_host = get_hostname!()
'''
EOF
  fi
}
render() {
  printf '# nano-connect %s; source-bound credentials, original message on the wire\n' "$VERSION"
  if [ "$OS" = windows ]; then printf 'data_dir = "C:/ProgramData/Vector/data"\n'; else printf 'data_dir = "/var/lib/vector"\n'; fi
  if [ -z "$TARGET" ]; then
    local secret_path=/etc/vector/secrets
    [ "$OS" != windows ] || secret_path=C:/ProgramData/Vector/secrets
    printf '[secret.nano_ingest]\ntype = "directory"\npath = "%s"\nremove_trailing_whitespace = true\n' "$secret_path"
  fi
  if [ "$COMMAND" = add-agent ]; then
    render_agent
  elif [ "$COMMAND" = add-aggregator ]; then
    printf '[sources.agents]\ntype = "vector"\naddress = "0.0.0.0:%s"\n' "$AGENT_PORT"
  fi
  local st p m
  while read -r st p m; do [ -z "$st" ] || render_socket "$st" "$p" "$m"; done < "$WORK/selected"
  if [ -n "$TARGET" ]; then
    printf '[sinks.out]\ntype = "vector"\ninputs = ["%s"]\naddress = %s\nacknowledgements.enabled = true\n[sinks.out.buffer]\ntype = "disk"\nmax_size = 268435488\nwhen_full = "block"\n' "$NATIVE_INPUT" "$(q "$TARGET")"
  else
    if [ -s "$WORK/agent-types" ]; then
      printf '[transforms.by_source]\ntype = "route"\ninputs = ["%s"]\n' "$UPSTREAM"
      while IFS= read -r st; do printf "route.%s = '.source_type == \"%s\"'\n" "$st" "$st"; done < "$WORK/agent-types"
      while IFS= read -r st; do render_sink "$st" "by_source.$st"; done < "$WORK/agent-types"
    fi
    while read -r st p m; do [ -z "$st" ] || render_sink "$st" "${st}_tag"; done < "$WORK/selected"
    if [ -n "$FILES" ]; then render_sink "$FILE_SOURCE" files_tag; fi
  fi
  printf '[sources.internal_metrics]\ntype = "internal_metrics"\n[sinks.metrics]\ntype = "prometheus_exporter"\ninputs = ["internal_metrics"]\naddress = "0.0.0.0:9598"\n'
}
compose() {
  cat <<EOF
services:
  nano-collector:
    image: $VECTOR_IMAGE
    restart: unless-stopped
    command: ["--config", "/etc/vector/vector.toml"]
    volumes:
      - ./vector.toml:/etc/vector/vector.toml:ro
      - ./secrets:/etc/vector/secrets:ro
      - nano-data:/var/lib/vector
EOF
  if [ "$COMMAND" = add-aggregator ] || [ -s "$WORK/selected" ]; then
    printf '    ports:\n'
    [ "$COMMAND" != add-aggregator ] || printf '      - "%s:%s"\n' "$AGENT_PORT" "$AGENT_PORT"
    local st p m
    while read -r st p m; do printf '      - "%s:%s/%s"\n' "$p" "$p" "$m"; done < "$WORK/selected"
  fi
  printf '    healthcheck:\n      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:9598/metrics"]\n      interval: 15s\n      timeout: 5s\n      retries: 3\nvolumes:\n  nano-data:\n'
}
platform_artifacts() {
  if [ "$OS" = windows ]; then
    # Generated only; never executed by connect.sh. The signed upstream MSI is
    # necessary: the Linux-only trimmed nano server image is not an agent MSI.
    cat <<'EOF' | atomic "$OUT/install-agent.ps1"
# Run as Administrator on the intended Windows endpoint.
$ErrorActionPreference = "Stop"
$ver = "0.59.0"
$msi = "$env:TEMP\vector-$ver-x64.msi"
$cfgDir = "C:\ProgramData\Vector"
$bin = "C:\Program Files\Vector\bin\vector.exe"
Invoke-WebRequest -Uri "https://packages.timber.io/vector/$ver/vector-$ver-x64.msi" -OutFile $msi
$sig = Get-AuthenticodeSignature $msi
if ($sig.Status -ne "Valid") { throw "MSI signature is not valid; aborting" }
Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet /norestart" -Wait
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
Copy-Item -Path "$PSScriptRoot\vector.toml" -Destination "$cfgDir\vector.toml" -Force
# Restrict the destination before any secret material is copied.
New-Item -ItemType Directory -Force -Path "$cfgDir\secrets" | Out-Null
icacls "$cfgDir\secrets" /reset /T | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Cannot reset secret ACL" }
icacls "$cfgDir\secrets" /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Cannot restrict secret ACL" }
Copy-Item -Path "$PSScriptRoot\secrets\*" -Destination "$cfgDir\secrets" -Force
sc.exe stop vector 2>$null | Out-Null
sc.exe delete vector 2>$null | Out-Null
New-Service -Name vector -DisplayName "Vector (nano agent)" -StartupType Automatic `
  -BinaryPathName "`"$bin`" --config-toml `"$cfgDir\vector.toml`""
sc.exe failure vector reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
Start-Service vector
EOF
  else
    cat <<'EOF' | atomic "$OUT/nano-collector.service"
# Requires Vector 0.59.0 installed on the intended endpoint.
# Copy vector.toml to /etc/nano-collector/vector.toml and secrets/ to
# /etc/vector/secrets (0700 directory, 0600 files). Root reads journal/logs.
# Then install this unit in /etc/systemd/system on that endpoint.
[Unit]
Description=nano collector (Vector)
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/bin/vector --config /etc/nano-collector/vector.toml
Restart=on-failure
RestartSec=5
StateDirectory=vector
[Install]
WantedBy=multi-user.target
EOF
  fi
}
run_here() {
  command -v docker >/dev/null || fail 'Docker unavailable; artifacts were generated'
  docker version >/dev/null 2>&1 || fail 'Docker engine unavailable'
  docker compose version >/dev/null 2>&1 || fail 'Compose v2 unavailable'
  docker compose -f "$OUT/docker-compose.yml" pull || fail 'Image pull failed'
  docker compose -f "$OUT/docker-compose.yml" up -d || fail 'Collector start failed'
  local n=0 health
  while [ "$n" -lt 45 ]; do
    health=$(docker compose -f "$OUT/docker-compose.yml" ps --format '{{.Health}}' 2>/dev/null || :)
    case "$health" in healthy) note 'Collector healthy'; return ;; unhealthy) fail 'Collector unhealthy' ;; esac
    n=$((n+1)); sleep 2
  done
  fail 'Collector health did not become ready within 90 seconds'
}
search() {
  local query=$1 now start end
  now=$(date +%s)
  start=$(date -u -d "@$((now - WINDOW * 60))" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -r "$((now - WINDOW * 60))" '+%Y-%m-%dT%H:%M:%SZ')
  end=$(date -u -d "@$((now + 60))" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -r "$((now + 60))" '+%Y-%m-%dT%H:%M:%SZ')
  request POST "$SEARCH_URL" "{\"query\":$(q "$query"),\"time_range\":{\"start\":$(q "$start"),\"end\":$(q "$end")},\"limit\":100,\"offset\":0,\"skip_histogram\":true,\"skip_field_stats\":true,\"async_mode\":false}" || fail "Search failed (HTTP $HTTP_CODE)"
}
verify() {
  [ -n "$SOURCE" ] || SOURCE=$(prompt 'Source type (--source)' '')
  safe_id "$SOURCE"; search "source_type=\"$SOURCE\""
  printf '%s' "$RESPONSE" | records results > "$WORK/results" || fail 'Malformed search response'
  local count generic failed row parsed key val
  count=$(wc -l < "$WORK/results" | tr -d ' '); generic=0; failed=0; parsed=0
  while IFS= read -r row; do
    if printf '%s' "$row" | grep -Eq '"parser_type"[[:space:]]*:[[:space:]]*"generic"'; then generic=$((generic+1))
    elif printf '%s' "$row" | grep -Eq '"(ext[.])?parse_error"[[:space:]]*:[[:space:]]*"[^" ]'; then failed=$((failed+1))
    else
      for key in src_ip dest_ip src_port dest_port protocol action user src_user dest_user process_name file_path file_name url query; do
        val=$(get "$key" "$row" || :)
        if [ -n "$val" ] && [ "$val" != 0 ]; then parsed=$((parsed+1)); break; fi
      done
    fi
  done < "$WORK/results"
  note "$count sampled searchable events ($parsed normalized, $generic generic, $failed parser failures; sample limit 100)"
  [ "$count" -gt 0 ] || return 1
}
connect_flow() {
  api GET setup/status
  [ "$(get initialized "$RESPONSE")" = true ] || fail 'Complete initial server setup first'
  [ -n "$SOURCE" ] || SOURCE=$(prompt 'Existing source for connectivity test (--source)' '')
  safe_id "$SOURCE"; load_tokens; credential "$SOURCE"
  local marker n=0
  marker=nano-connect-$(date +%s)-$$-$RANDOM
  if [ "$TRANSPORT" = hec ]; then
    request POST "${INGEST_URL%/}/services/collector/event" "{\"sourcetype\":$(q "$SOURCE"),\"event\":$(q "nano-connect connectivity test $marker")}" hec || fail "Ingest rejected (HTTP $HTTP_CODE)"
  else
    request POST "$INGEST_URL" "{\"message\":$(q "nano-connect connectivity test $marker")}" ingest || fail "Ingest rejected (HTTP $HTTP_CODE)"
  fi
  while [ "$n" -lt 23 ]; do
    search "source_type=\"$SOURCE\""
    if printf '%s' "$RESPONSE" | records results | grep -Fq "$marker"; then note 'Connectivity event searchable; connection saved'; return; fi
    n=$((n+1)); sleep 2
  done
  search '*'
  fail 'Event accepted but not searchable after 46 seconds; inspect source parser and server pipeline'
}
parsers() {
  api GET parser-repositories
  printf '%s' "$RESPONSE" | records repositories > "$WORK/repos" || fail 'Malformed repositories'
  if [ ! -s "$WORK/repos" ]; then
    [ "$ADD_OFFICIAL" = 1 ] || confirm 'Register official nano parsers repository?' || fail 'No parser repository; pass --add-official'
    api POST parser-repositories '{"name":"nano parsers","slug":"nano-rs/parsers","description":"Official nano parsers","url":"https://github.com/nano-rs/parsers","branch":"main","parsers_path":"parsers/","auto_sync_enabled":false,"sync_interval_hours":24,"enabled":true}'
    printf '%s\n' "$RESPONSE" > "$WORK/repos"
  fi
  local row rid n status
  while IFS= read -r row; do
    [ "$(get enabled "$row" || :)" != false ] || continue
    rid=$(get id "$row"); safe_id "$rid"
    api POST "parser-repositories/$rid/sync"
    n=0
    while [ "$n" -lt 60 ]; do
      api GET "parser-repositories/$rid/sync/status"; status=$(get status "$RESPONSE" || :)
      case "$status" in pending|running|in_progress|syncing) ;; *fail*|*error*) fail 'Parser sync failed' ;; '') fail 'Sync status missing' ;; *) break ;; esac
      n=$((n+1)); sleep 2
    done
    [ "$n" -lt 60 ] || fail 'Parser sync timed out'
  done < "$WORK/repos"
  note 'Parser repositories synced'
}
help_text() {
  cat <<EOF
nano-connect $VERSION — Bash 3.2+, curl, coreutils, awk/sed/grep (jq optional)
Usage: bash connect.sh [connect|add-source|add-agent|add-aggregator|list-sources|sync-parsers|verify|rotate-token|otlp-config] [flags]
  --url URL / NANO_URL                  --api-key KEY / NANO_API_KEY
  --email EMAIL / NANO_EMAIL            --password PASSWORD / NANO_PASSWORD
  --env-file FILE (read BASE_URL only; never execute)
  --transport hec|http (default hec; direct native nano uplink refused)
  --ingest-url URL / NANO_INGEST_URL     --search-url URL / NANO_SEARCH_URL
  --source TYPE / NANO_SOURCE           --sources a,b:tcp / NANO_SOURCES
  --token-dir DIR / NANO_TOKEN_DIR (one named source credential per file)
  --rotate (persist replacement before revocation)
  --os linux|windows / NANO_OS          --target HOST:PORT (trusted aggregator)
  --no-journald                        --files PATH --file-source TYPE
  --agent-port PORT (9000)              --out-dir DIR / NANO_OUT_DIR
  --deploy-parsers (import + publish matching community parsers)
  --run (docker compose deployment)     --window MINUTES (15)
  --add-official                        --builtin-only
  --yes / NANO_YES=1                    --non-interactive / NANO_NON_INTERACTIVE=1
  --version                            --help
Secrets are never shown. Prefer env variables/private files over secret flags.
OTLP exporters: use source-bound Bearer credentials at /otlp/v1/{logs,metrics,traces}
only after nano-rs/nanosiem#6811 is released (NANO_OTLP_SOURCE_AUTH_RELEASED=1).
The /api/internal/otlp-auth endpoint is server-internal; clients use /otlp.
No raw OTLP port fallback.
EOF
}
main() {
  URL=${NANO_URL:-}; API_KEY=${NANO_API_KEY:-}; EMAIL=${NANO_EMAIL:-}; PASSWORD=${NANO_PASSWORD:-}; JWT=
  INGEST_URL=${NANO_INGEST_URL:-}; SEARCH_URL=${NANO_SEARCH_URL:-}; ENV_FILE=
  SOURCE=${NANO_SOURCE:-}; SOURCES=${NANO_SOURCES:-}; OUT=${NANO_OUT_DIR:-}; OS=${NANO_OS:-}; TARGET=${NANO_TARGET:-}
  TRANSPORT=${NANO_TRANSPORT:-hec}; TOKEN_DIR=${NANO_TOKEN_DIR:-}; ROTATE=0; RUN=0; JOURNALD=1; FILES=; FILE_SOURCE=application
  OTLP_READY=${NANO_OTLP_SOURCE_AUTH_RELEASED:-0}; AGENT_PORT=9000; WINDOW=15; DEPLOY_PARSERS=0; NATIVE_INPUT=tag; ADD_OFFICIAL=0; BUILTIN=0; YES=${NANO_YES:-0}; NONINTERACTIVE=${NANO_NON_INTERACTIVE:-0}
  CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}/nano-connect-bash
  COMMAND=connect; UPSTREAM=tag; TOKEN=;
  [ -t 0 ] || NONINTERACTIVE=1
  while [ "$#" -gt 0 ]; do
    case "$1" in
      connect|add-source|add-agent|add-aggregator|list-sources|list-devices|sync-parsers|verify|rotate-token|otlp-config) COMMAND=$1; shift ;;
      --help|-h) help_text; return ;; --version|-v) printf '%s\n' "$VERSION"; return ;;
      --yes) YES=1; NONINTERACTIVE=1; shift ;; --non-interactive) NONINTERACTIVE=1; shift ;;
      --run) RUN=1; shift ;; --rotate) ROTATE=1; shift ;; --no-journald) JOURNALD=0; shift ;;
      --add-official) ADD_OFFICIAL=1; shift ;; --builtin-only) BUILTIN=1; shift ;;
      --to-nano) TARGET=; shift ;;
      --url|--api-key|--email|--password|--env-file|--ingest-url|--search-url|--source|--sources|--devices|--out-dir|--os|--target|--transport|--token-dir|--files|--file-source|--agent-port|--window)
        [ "$#" -ge 2 ] || fail 'Flag requires a value'
        case "$1" in
          --url) URL=$2 ;; --api-key) API_KEY=$2 ;; --email) EMAIL=$2 ;; --password) PASSWORD=$2 ;; --env-file) ENV_FILE=$2 ;;
          --ingest-url) INGEST_URL=$2 ;; --search-url) SEARCH_URL=$2 ;; --source) SOURCE=$2 ;;
          --sources|--devices) SOURCES=$2 ;; --out-dir) OUT=$2 ;; --os) OS=$2 ;; --target) TARGET=$2 ;;
          --transport) TRANSPORT=$2 ;; --token-dir) TOKEN_DIR=$2 ;; --files) FILES=$2 ;; --file-source) FILE_SOURCE=$2 ;;
          --agent-port) AGENT_PORT=$2 ;; --window) WINDOW=$2 ;;
        esac; shift 2 ;;
      --ingest-token) fail 'Shared ingest token removed; use --token-dir with one bound credential per source' ;;
      --mtls-dir|--vector-host|--vector-port) fail 'Direct native nano uplink bypasses source credentials; use HEC/HTTP' ;;
      --deploy-parsers) DEPLOY_PARSERS=1; shift ;;
      *) fail 'Unknown command or flag; see --help' ;;
    esac
  done
  case "$TRANSPORT" in hec|http) ;; *) fail 'Use hec or http; native nano uplink bypasses source-bound credentials' ;; esac
  safe_id "$FILE_SOURCE"
  port_check "$AGENT_PORT"
  if ! [[ "$WINDOW" =~ ^[0-9]{1,4}$ ]] || [ "$WINDOW" -le 0 ]; then fail 'Invalid search window'; fi
  if [ "$COMMAND" = list-devices ]; then COMMAND=list-sources; fi
  if [ "$COMMAND" = list-sources ] && [ "$BUILTIN" = 1 ]; then catalog; return; fi
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/nano-connect.XXXXXXXX")
  trap 'rm -rf "$WORK"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ "$COMMAND" = add-agent ] && [ -n "$TARGET" ]; then
    : # Trusted aggregator generation is offline, without nano API credentials.
  else
    profile
  fi
  case "$COMMAND" in
    connect) connect_flow ;;
    verify) verify ;;
    sync-parsers) parsers ;;
    otlp-config)
      [ "$OTLP_READY" = 1 ] || fail 'OTLP source auth requires nano-rs/nanosiem#6811 (unreleased at implementation); set NANO_OTLP_SOURCE_AUTH_RELEASED=1 only on a server shipping that contract'
      [ -n "$SOURCE" ] || fail 'Pass --source for this OTLP exporter'
      safe_id "$SOURCE"; load_tokens
      [ -n "$OUT" ] || OUT=./onboarding/otlp-$SOURCE
      private_dir "$OUT"; private_dir "$OUT/secrets"
      credential "$SOURCE"
      printf '%s' "$TOKEN" | atomic "$OUT/secrets/$SOURCE"
      { printf 'OTEL_EXPORTER_OTLP_ENDPOINT=%s/otlp\n' "$URL"; printf 'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\n'; printf "OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer %s'\n" "$TOKEN"; } | atomic "$OUT/otel.env"
      note 'Private OTLP exporter environment generated. Each source needs its own exporter and bound credential; the server enforces revocation per request'
      ;;
    rotate-token)
      [ -n "$SOURCE" ] || fail 'Pass --source'
      [ -n "$OUT" ] || fail 'Pass --out-dir for the collector whose secret is rotated'
      private_dir "$OUT"; private_dir "$OUT/secrets"
      ROTATE=1; load_tokens; credential "$SOURCE"; note 'Credential rotated; reload the collector to use its new secret'
      ;;
    list-sources)
      catalog; load_tokens; load_catalog
      while IFS= read -r row; do
        local route
        route=$(get route_key "$row" || :)
        [ -z "$route" ] || printf '%s (instance)\n' "$route"
      done < "$WORK/sources"
      while IFS= read -r row; do
        if syslog_collectable "$row" && [ "$(get kind "$row" || :)" != enrichment ]; then
          route=$(get name "$row" || :)
          [ -z "$route" ] || printf '%s (community)\n' "$route"
        fi
      done < "$WORK/parsers"
      ;;
    add-source|add-agent|add-aggregator)
      if [ -z "$TARGET" ]; then
        load_tokens
        load_catalog
      fi
      : > "$WORK/selected"; : > "$WORK/agent-types"
      if [ "$COMMAND" = add-agent ]; then
        [ -n "$OS" ] || OS=$(prompt 'Endpoint OS (--os)' linux)
        case "$OS" in
          linux) [ "$JOURNALD" = 0 ] || printf '%s\n' linux_journald linux_sysmon > "$WORK/agent-types" ;;
          windows) printf '%s\n' windows_event windows_sysmon > "$WORK/agent-types" ;;
          *) fail 'OS must be linux or windows' ;;
        esac
        [ "$OS" != linux ] || [ "$JOURNALD" = 1 ] || [ -n "$FILES" ] || fail 'Nothing to collect'
        if [ "$JOURNALD" = 0 ] && [ -n "$FILES" ]; then NATIVE_INPUT=files_tag; fi
        if [ "$JOURNALD" = 1 ] && [ -n "$FILES" ]; then NATIVE_INPUT='tag", "files_tag'; fi
        if [ -n "$TARGET" ]; then
          target_check
          [[ "$TARGET" != *[!A-Za-z0-9._:\[\]-]* ]] || fail 'Invalid aggregator target'
          note 'Native aggregator hop requires a trusted private network; it has no source authentication'
        fi
      else
        select_sources
        if [ "$COMMAND" = add-aggregator ]; then UPSTREAM=agents; printf '%s\n' windows_event windows_sysmon linux_journald linux_sysmon > "$WORK/agent-types"; fi
      fi
      if [ -n "$FILES" ] && grep -Fxq "$FILE_SOURCE" "$WORK/agent-types"; then fail 'File source must differ from built-in agent routes'; fi
      [ -n "$OUT" ] || OUT=./onboarding/$COMMAND${OS:+-$OS}
      private_dir "$OUT"; OUT=$(cd "$OUT" && pwd); private_dir "$OUT/secrets"
      if [ -z "$TARGET" ]; then
        { cat "$WORK/agent-types"; awk '{print $1}' "$WORK/selected"; [ -z "$FILES" ] || printf '%s\n' "$FILE_SOURCE"; } | sort -u > "$WORK/wanted"
        while IFS= read -r st; do
          [ -n "$st" ] || continue
          review_parser "$st"
          credential "$st"
          printf '%s' "$TOKEN" | atomic "$OUT/secrets/$st"
        done < "$WORK/wanted"
        # Reject duplicates even when supplied under different file names.
        local previous='' current st
        while IFS= read -r st; do
          current=$(cat "$OUT/secrets/$st")
          case "$previous" in *"|$current|"*) fail 'A credential cannot be shared across source lanes' ;; esac
          previous=$previous'|'$current'|'
        done < "$WORK/wanted"
      fi
      render | atomic "$OUT/vector.toml"
      if [ "$COMMAND" != add-agent ]; then compose | atomic "$OUT/docker-compose.yml"; fi
      platform_artifacts
      printf '%s\n' 'Generated with nano-connect. Mount secrets/ at /etc/vector/secrets (0700 dir, 0600 files).' 'Syslog/aggregator: run docker compose up -d only on the intended collector host. Agents: install the generated service on the endpoint. No installer runs automatically.' 'For bare-metal Vector, copy secrets to /etc/vector/secrets and supply vector.toml to your service.' 'For Windows, run the generated install-agent.ps1 as Administrator on the endpoint; secrets are ACL-restricted.' | atomic "$OUT/README.txt"
      note "Artifacts generated in $OUT"
      if [ "$RUN" = 1 ]; then
        [ "$COMMAND" != add-agent ] || fail 'Agent artifacts generated; install the service on the intended endpoint'
        run_here
      fi
      ;;
  esac
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
