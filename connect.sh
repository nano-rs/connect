#!/usr/bin/env bash
# nano-connect: standalone Bash 3.2+ client. Apache-2.0.
# Never enable xtrace: credentials pass through shell variables and private files.
set +x
set -euo pipefail
umask 077
VERSION=0.5.0
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
    # Linear scan: characters come from one split() (awk substr on a long
    # string is O(length)), unwanted string values are skipped, and only the
    # requested value is decoded, so large parser catalogs stay fast.
    LC_ALL=C awk -v want="$1" '
    function string(   c,o,e,st) {
      o=""; i++; st=i
      while(i<=n) {
        c=ch[i]
        if(c=="\"") {o=o substr(s,st,i-st); i++; return o}
        if(c=="\\") {
          o=o substr(s,st,i-st); e=ch[i+1]; i+=2; st=i
          if(e=="u") { bad=1; return "" }
          if(e=="n") o=o "\n"; else if(e=="r") o=o "\r"; else if(e=="t") o=o "\t"
          else if(e=="\"" || e=="\\" || e=="/") o=o e
          else { bad=1; return "" }
          continue
        }
        i++
      }
      bad=1; return ""
    }
    function skip(   c) {
      i++
      while(i<=n) { c=ch[i++]; if(c=="\\") {i++; continue}; if(c=="\"") return }
      bad=1
    }
    {s=s $0 "\n"}
    END {
      n=split(s,ch,""); depth=0; val=0; hit=0
      for(i=1;i<=n;) {
        c=ch[i]
        if(c=="{" || c=="[") {depth++; val=0; hit=0; i++; continue}
        if(c=="}" || c=="]") {depth--; hit=0; i++; continue}
        if(c==",") {val=0; hit=0; i++; continue}
        if(c==":") {
          i++; val=1
          if(!hit) continue
          while(ch[i] ~ /[ \t\r\n]/) i++
          if(ch[i]=="\"") {v=string(); if(bad) exit 1; print v; exit 0}
          tail=substr(s,i,64)
          if(match(tail,/^(true|false|-?[0-9]+([.][0-9]+)?)/)) {print substr(tail,1,RLENGTH); exit 0}
          exit 1
        }
        if(c!="\"") {i++; continue}
        if(val) {skip(); if(bad) exit 1; val=0; continue}
        key=string(); if(bad) exit 1
        hit=(depth==1 && key==want)
      }
      exit 1
    }'
  fi
}
# Extract a known named array (or a bare array), then emit its immediate objects,
# one per line. Nested objects, escaped quotes, and braces inside strings do not
# split records. JSON strings cannot hold raw newlines, so the stream is cut into
# short chunks (linear in awk) and each record is printed back in pieces.
records() {
  if command -v jq >/dev/null 2>&1 && [ "${CONNECT_NO_JQ:-0}" != 1 ]; then
    jq -c --arg k "$1" '(if type == "array" then . else .[$k] end) | if type == "array" then .[] | select(type == "object") else error("missing") end' 2>/dev/null
    return
  fi
  tr -d '\r\n' | fold -b -w 256 | LC_ALL=C awk -v key="$1" '
  BEGIN {top=""; depth=0; instr=0; esc=0; keying=0; colon=0; lastkey=""; inarr=0; d=0; inrec=0; done=0}
  done {next}
  {
    n=split($0,ch,""); from=1
    for(i=1;i<=n;i++) {
      c=ch[i]
      if(instr) {
        if(esc) esc=0
        else if(c=="\\") esc=1
        else if(c=="\"") {instr=0; if(keying) {lastkey=kb; keying=0}}
        if(keying && instr && !esc && c!="\\") kb=kb c
        continue
      }
      if(c=="\"") {instr=1; if(!inarr && depth==1 && !colon) {keying=1; kb=""}; continue}
      if(c ~ /[ \t]/) continue
      if(!inarr) {
        if(top=="") {top=c; if(c=="[") {inarr=1; d=0; continue}}
        if(c=="{" || c=="[") {depth++; if(c=="[" && depth==2 && colon && lastkey==key) {inarr=1; d=0}; continue}
        if(c=="}" || c=="]") {depth--; continue}
        if(depth==1 && c==":") colon=1
        if(depth==1 && c==",") {colon=0; lastkey=""}
        continue
      }
      if(c=="{" || c=="[") {if(c=="{" && d==0) {inrec=1; from=i}; d++; continue}
      if(c=="}" || c=="]") {
        d--
        if(d<0) {done=1; break}
        if(d==0 && inrec && c=="}") {print substr($0,from,i-from+1); inrec=0}
      }
    }
    if(inrec) {printf "%s", substr($0,from)}
  }
  END {exit !done}'
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
    hec)
      [ -n "${HEC_CHANNEL:-}" ] || fail 'Missing private HEC request channel'
      printf 'Authorization: Splunk %s\nX-Splunk-Request-Channel: %s\n' "$TOKEN" "$HEC_CHANNEL" >> "$header" ;;
  esac
  printf 'Content-Type: application/json\n' >> "$header"
  printf '%s' "$body" > "$WORK/body"
  HTTP_CODE=$(curl --silent --show-error --connect-timeout 8 --max-time "${REQUEST_TIMEOUT:-25}" --proto '=http,https' \
    --request "$method" --header "@$header" --data-binary "@$WORK/body" \
    --output "$WORK/response" --write-out '%{http_code}' "$endpoint" 2> "$WORK/curl-error") || fail 'Request failed (network or TLS); response details withheld'
  RESPONSE=$(cat "$WORK/response")
  case "$HTTP_CODE" in 2??) return 0 ;; *) return 1 ;; esac
}
api() {
  request "$1" "$URL/api/$2" "${3:-}" && return 0
  if [ "$HTTP_CODE" = 403 ]; then
    fail "API permission denied: $2 (discovery needs log_sources:view; issuing, binding, rotating and revoking ingest tokens need settings:system; parser import needs parser_repositories:import, log_sources:create, source_configs:edit and log_sources:deploy; verification needs search:execute and visibility of the source)"
  fi
  fail "API request failed (HTTP $HTTP_CODE); check permissions and server version"
}
hec_channel() {
  local st=$1 value hex
  safe_id "$st"; private_dir "$STATE/channels"
  if [ -f "$STATE/channels/$st" ]; then
    value=$(cat "$STATE/channels/$st")
  else
    # Stock Unix entropy; optional openssl is unnecessary. UUID v4 bits.
    hex=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
    [ "${#hex}" = 32 ] || fail 'Cannot obtain HEC channel entropy'
    value=${hex:0:8}-${hex:8:4}-4${hex:13:3}-a${hex:17:3}-${hex:20:12}
    printf '%s' "$value" | atomic "$STATE/channels/$st"
  fi
  [[ "$value" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || fail 'Invalid stored HEC channel'
  HEC_CHANNEL=$value
}
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
  [ -n "$SEARCH_URL" ] || SEARCH_URL=$URL/api/search
  url_check "$SEARCH_URL"
  printf '%s' "$SEARCH_URL" | atomic "$STATE/search-url"
  # Only explicitly supplied ingest destinations are saved; discovered ones are
  # re-read every run so a newly configured ingest frontend takes effect.
  # A destination given on this run replaces saved ones: a new --ingest-base
  # is not overridden by an older saved --ingest-url.
  if [ -n "$INGEST_URL" ]; then url_check "$INGEST_URL"; printf '%s' "$INGEST_URL" | atomic "$STATE/ingest-$TRANSPORT-url"
  elif [ -n "$INGEST_BASE" ]; then rm -f "$STATE/ingest-$TRANSPORT-url"
  elif [ -f "$STATE/ingest-$TRANSPORT-url" ]; then INGEST_URL=$(cat "$STATE/ingest-$TRANSPORT-url")
  fi
  if [ -n "$INGEST_BASE" ]; then
    INGEST_BASE=${INGEST_BASE%/}; url_check "$INGEST_BASE"
    [ "$INGEST_BASE" = "$(origin_of "$INGEST_BASE")" ] || fail '--ingest-base takes an origin only (scheme://host[:port]), no path'
    printf '%s' "$INGEST_BASE" | atomic "$STATE/ingest-base"
  elif [ -f "$STATE/ingest-base" ]; then INGEST_BASE=$(cat "$STATE/ingest-base")
  fi
}
# scheme://authority of a checked URL, and the authority's host without port.
origin_of() { local rest=${1#*://}; printf '%s://%s' "${1%%://*}" "${rest%%/*}" | tr '[:upper:]' '[:lower:]'; }
host_of() {
  local authority=${1#*://}; authority=${authority%%/*}
  case "$authority" in \[*) authority=${authority%%]*}]; ;; *) authority=${authority%%:*} ;; esac
  printf '%s' "$authority" | tr '[:upper:]' '[:lower:]'
}
# Ingest destination. Enterprise deployments (self-hosted enterprise, k8s,
# BYOC, Civo) serve ingest from a dedicated frontend on its own hostname; open
# core serves /ingest on the app host. Precedence: --ingest-url (exact, per
# transport) > --ingest-base (origin) > the instance's configured ingest base
# (GET /api/log-sources/ingest-endpoint) > the app host, only when the instance
# reports no dedicated base. Events never go to the app host while a dedicated
# ingest base is configured.
resolve_ingest() {
  local app edition='' configured='' base='' hec='' discovered=0 dedicated='' from=''
  app=$(origin_of "$URL")
  if request GET "$URL/api/capabilities"; then edition=$(get edition "$RESPONSE" || :); fi
  if request GET "$URL/api/log-sources/ingest-endpoint"; then
    discovered=1
    configured=$(get configured "$RESPONSE" || :); base=$(get base_url "$RESPONSE" || :)
    hec=$(get hec_url "$RESPONSE" || :)
    [ -z "$base" ] || url_check "$base"; [ -z "$hec" ] || url_check "$hec"
    if [ "$configured" = true ] && [ -n "$base" ] && [ "$(origin_of "$base")" != "$app" ]; then dedicated=$(origin_of "$base"); fi
  elif [ "$HTTP_CODE" != 403 ] && [ "$HTTP_CODE" != 404 ]; then
    fail "Ingest endpoint discovery failed (HTTP $HTTP_CODE)"
  fi
  if [ -z "$INGEST_URL" ]; then
    if [ -n "$INGEST_BASE" ]; then from=$INGEST_BASE
    elif [ -n "$dedicated" ]; then from=$dedicated; note "Dedicated ingest frontend: $dedicated"
    elif [ "$discovered" = 0 ] && [ "$edition" != open ]; then
      fail 'Cannot read the ingest endpoint (GET /api/log-sources/ingest-endpoint needs log_sources:view). Enterprise deployments ingest on a dedicated host: pass --ingest-base https://ingest.<domain> (or --ingest-url)'
    else
      from=$app
      [ "$edition" != enterprise ] || note 'Enterprise instance reports no dedicated ingest base (NANO_INGEST_PUBLIC_BASE_URL); using the app host. Pass --ingest-base to use your ingest frontend'
    fi
    case "$TRANSPORT" in
      http) INGEST_URL=$from/ingest ;;
      otlp) INGEST_URL=$from/otlp ;;
      hec)
        if [ -n "$hec" ] && [ "$from" = "$(origin_of "$base")" ]; then INGEST_URL=$hec
        elif [ -n "$hec" ]; then
          # Same HEC listener scheme/port, on the chosen ingest host.
          INGEST_URL=${hec%%://*}://$(host_of "$from"):${hec##*:}
        else INGEST_URL=${from%%://*}://$(host_of "$from"):8088
        fi ;;
    esac
  fi
  INGEST_URL=${INGEST_URL%/}; url_check "$INGEST_URL"
  if [ -n "$dedicated" ]; then
    if [ "$(host_of "$dedicated")" != "$(host_of "$app")" ]; then
      [ "$(host_of "$INGEST_URL")" != "$(host_of "$app")" ] || fail "This instance ingests through a dedicated frontend ($dedicated); refusing to send events to the app host. Drop the app-host --ingest-url/--ingest-base"
    else
      [ "$(origin_of "$INGEST_URL")" != "$app" ] || fail "This instance ingests through a dedicated frontend ($dedicated); refusing to send events to the app origin"
    fi
  fi
  note "Ingest ($TRANSPORT): $INGEST_URL"
}
catalog() {
  printf '%s\n' 'cisco_asa 5514 udp' 'palo_alto 5515 tcp' 'fortinet 5516 udp' 'cisco_ios 5517 udp' 'juniper_srx 5518 udp' 'sonicwall 5519 udp' 'pfsense 5520 udp' 'linux_syslog 5521 udp' 'f5_bigip 5522 tcp'
}
# Log Sources discovery: every push-capable source a token can be bound to,
# and the issued tokens (never their values). GET needs log_sources:view.
load_tokens() {
  if ! request GET "$URL/api/ingest-tokens"; then
    case "$HTTP_CODE" in
      403) fail 'Source discovery denied: GET /api/ingest-tokens needs log_sources:view (issuing, binding, rotating and revoking tokens need settings:system)' ;;
      404) fail 'Server lacks the per-source ingest-token API (NAN-4907); upgrade nano' ;;
      *) fail "Ingest token discovery failed (HTTP $HTTP_CODE)" ;;
    esac
  fi
  LISTING=$RESPONSE
  printf '%s' "$LISTING" | records sources > "$WORK/sources" || fail 'Server lacks the source-bound credential API (NAN-4907); upgrade nano'
  printf '%s' "$LISTING" | records tokens > "$WORK/tokens" || fail 'Malformed token listing'
  DELIVERY=$(get delivery "$LISTING" || :)
}
require_delivery() {
  [ "$DELIVERY" != none ] || fail 'Ingest token delivery to Vector is not configured on this deployment (NANO_INGEST_TOKENS_DELIVERY); no token can be issued or bound'
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
  hec_channel "$st"
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
      require_delivery
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
    require_delivery
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
# An exact name wins (the registry's OCSF parsers are named <source>_ocsf),
# then any match value. Several parsers can share a match value (windows_event
# has JSON, XML and text variants); the <source>_ocsf JSON parser is preferred.
lookup_in() {
  local want=$1 file=$2 row name alias
  [ -f "$file" ] || return 1
  while IFS= read -r row; do
    [ "$(get kind "$row" || :)" != enrichment ] || continue
    name=$(get name "$row" || :)
    if [ "$name" = "$want" ] || [ "$name" = "${want}_ocsf" ]; then printf '%s' "$row"; return; fi
  done < "$file"
  while IFS= read -r row; do
    [ "$(get kind "$row" || :)" != enrichment ] || continue
    while IFS= read -r alias; do
      if [ "$alias" = "$want" ]; then printf '%s' "$row"; return; fi
    done < <(aliases "$row")
  done < "$file"
  return 1
}
# The route key nano gives a source made from this parser or log source row:
# its first match value, else its name.
parser_route() {
  local first
  first=$(aliases "$1" | sed -n '/./{p;q;}')
  if [ -n "$first" ]; then printf '%s' "$first"; else get name "$1"; fi
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
  [ -n "$row" ] || fail "No bindable source or registry parser for $st"
  [ "$DEPLOY_PARSERS" = 1 ] || confirm "Import and publish parser for $st?" || fail 'Deploy the parser first, or pass --deploy-parsers'
  path=$(get file_path "$row") || fail 'Parser file path missing'
  case "$path" in /*|*../*|*/..|..) fail 'Unsafe parser path' ;; esac
  path=$(printf '%s' "$path" | encode_path)
  # Import validates the parser and publish regenerates and reloads Vector's
  # configuration; both can take well over the default request timeout.
  REQUEST_TIMEOUT=180
  api POST "parser-repositories/$REPO_ID/parsers/import/$path" '{"import_type":"linked","ingestion_method":"routed"}'
  id=$(get log_source_id "$RESPONSE") || fail 'Import response missing log source id'; safe_id "$id"
  api POST "log-sources/$id/publish"
  REQUEST_TIMEOUT=25
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
  local st=$1 row item
  if source_id "$st" >/dev/null; then printf '%s' "$st"; return; fi
  # A bindable source listed by name (Log Source name, not route key).
  while IFS= read -r item; do
    if [ "$(get name "$item" || :)" = "$st" ] && [ "$(get enabled "$item" || :)" = true ]; then get route_key "$item"; return; fi
  done < "$WORK/sources"
  row=$(lookup_in "$st" "$WORK/deployed" || :)
  [ -z "$row" ] || { parser_route "$row"; return; }
  row=$(lookup_parser "$st" || :)
  if [ -n "$row" ]; then parser_route "$row"; else printf '%s' "$st"; fi
}
select_sources() {
  catalog > "$WORK/catalog"
  if [ -z "$SOURCES" ]; then
    if [ "$COMMAND" = add-source ]; then SOURCES=$(catalog | awk '{print $1}' | paste -sd, -); else SOURCES=; fi
    if [ "$NONINTERACTIVE" = 0 ]; then SOURCES=$(prompt 'Comma-separated sources (--sources; :udp/:tcp/:http)' "$SOURCES"); fi
  fi
  : > "$WORK/selected"
  local selector st mode hit row assigned=5600
  local selectors
  selectors=$(printf '%s' "$SOURCES" | tr ',' '\n')
  while IFS= read -r selector; do
    selector=$(printf '%s' "$selector" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')
    [ -n "$selector" ] || continue
    st=${selector%%:*}; safe_id "$st"; mode=
    case "$selector" in *:*) mode=${selector#*:}; case "$mode" in udp|tcp|http) ;; *) fail 'Use :udp, :tcp or :http' ;; esac ;; esac
    hit=$(awk -v st="$st" '$1==st {print}' "$WORK/catalog")
    if [ -z "$hit" ]; then st=$(canonical_source "$st"); safe_id "$st"; fi
    if awk -v st="$st" '$1==st {found=1} END {exit !found}' "$WORK/selected"; then continue; fi
    hit=$(awk -v st="$st" '$1==st {print}' "$WORK/catalog")
    if [ -z "$hit" ]; then
      local parser_row
      parser_row=$(lookup_parser "$st" || :)
      local default_mode=udp
      if source_id "$st" >/dev/null; then
        # Enabled tenant sources are connectable even for app/web parsers.
        # Unknown transport metadata defaults to an HTTP push listener.
        default_mode=http
        if [ -n "$parser_row" ] && syslog_collectable "$parser_row"; then default_mode=udp; fi
      else
        [ -n "$parser_row" ] || fail "Unknown source: $st"
        syslog_collectable "$parser_row" || fail 'This parser is not a syslog source; deploy/enable its source first or use its endpoint/cloud integration'
      fi
      # Stable checksum-based ports, collision probe within a separate range.
      assigned=$(hash_port "$st")
      local probes=0
      while awk -v p="$assigned" '$2==p {found=1} END {exit !found}' "$WORK/selected"; do
        assigned=$((5600 + (assigned - 5599) % 100))
        probes=$((probes + 1)); [ "$probes" -lt 100 ] || fail 'Discovered syslog port range exhausted'
      done
      hit="$st $assigned $default_mode"
    fi
    if [ -n "$mode" ]; then hit=$(printf '%s\n' "$hit" | awk -v m="$mode" '{print $1,$2,m}'); fi
    printf '%s\n' "$hit" >> "$WORK/selected"
  done <<< "$selectors"
}
render_socket() {
  local st=$1 port=$2 mode=$3
  if [ "$mode" = http ]; then
    cat <<EOF
[sources.$st]
type = "http_server"
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
    return
  fi
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
  # The edge /ingest source splits newline-delimited bodies and keeps each
  # text/plain line as the original message; HEC carries it as the event string.
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
# First start reads from now, like the Windows agent; afterwards the
# checkpoint resumes where it left off.
since_now = true
[transforms.tag]
type = "remap"
inputs = ["journald"]
source = '''
ident = downcase(string(.SYSLOG_IDENTIFIER) ?? "")
unit = downcase(string(._SYSTEMD_UNIT) ?? "")
source_type = "linux_journald"
if contains(ident, "sysmon") || contains(unit, "sysmon") { source_type = "linux_sysmon" }
if source_type == "linux_journald" {
  # The journald parser reads one `journalctl -o json` entry per event: send
  # the whole entry with journald's own field names, not just MESSAGE.
  # Sysmon for Linux keeps its raw XML MESSAGE for the sysmon parser.
  entry = .
  entry.MESSAGE = .message
  entry._HOSTNAME = .host
  del(entry.message)
  del(entry.host)
  del(entry.timestamp)
  del(entry.source_type)
  .message = encode_json(entry)
}
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
    while read -r st p m; do [ "$m" != http ] || m=tcp; printf '      - "%s:%s/%s"\n' "$p" "$p" "$m"; done < "$WORK/selected"
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
verify_evidence() {
  [ -f "$EVIDENCE_FILE" ] || fail 'Missing --evidence-file'
  local st marker extra start deadline remaining found row stored
  : > "$WORK/evidence"
  while read -r st marker extra || [ -n "$st" ]; do
    [ -n "$st" ] || continue
    safe_id "$st"
    [[ "$marker" =~ ^[A-Za-z0-9_-]{8,128}$ ]] || fail 'Evidence markers must be 8-128 ASCII letters, digits, underscores or hyphens'
    [ -z "$extra" ] || fail 'Evidence format: source marker (one request per line)'
    if awk -v m="$marker" '$2==m {found=1} END {exit !found}' "$WORK/evidence"; then fail 'Every evidence request needs a distinct marker'; fi
    printf '%s %s\n' "$st" "$marker" >> "$WORK/evidence"
  done < "$EVIDENCE_FILE"
  [ -s "$WORK/evidence" ] || fail 'Evidence file is empty'
  start=$(date +%s); deadline=$((start + WAIT_SECONDS))
  while :; do
    : > "$WORK/pending"
    while read -r st marker; do
      remaining=$((deadline - $(date +%s)))
      if [ "$WAIT_SECONDS" -gt 0 ] && [ "$remaining" -le 0 ]; then
        printf '%s %s\n' "$st" "$marker" >> "$WORK/pending"; continue
      fi
      REQUEST_TIMEOUT=25
      if [ "$WAIT_SECONDS" -gt 0 ] && [ "$remaining" -lt 25 ]; then REQUEST_TIMEOUT=$remaining; fi
      # Filter at the server so a busy source cannot hide evidence beyond 100 rows.
      search "metadata.log_source=\"$st\" AND \"$marker\""
      printf '%s' "$RESPONSE" | records results > "$WORK/evidence-results" || fail 'Malformed search evidence response'
      found=0
      while IFS= read -r row; do
        # Require canonical stored source evidence, never the claimed sourcetype.
        stored=$(get metadata.log_source "$row" || :)
        if [ -z "$stored" ]; then
          stored=$(printf '%s' "$row" | sed -n 's/.*"metadata"[[:space:]]*:[[:space:]]*{[^}]*"log_source"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p')
        fi
        if [ "$stored" = "$st" ] && printf '%s' "$row" | grep -Fq "$marker"; then found=1; break; fi
      done < "$WORK/evidence-results"
      if [ "$found" = 1 ]; then note "Evidence searchable under token source $st: $marker"
      else printf '%s %s\n' "$st" "$marker" >> "$WORK/pending"; fi
    done < "$WORK/evidence"
    REQUEST_TIMEOUT=25
    [ -s "$WORK/pending" ] || { note 'All request markers searchable under their token sources'; return; }
    if [ "$(date +%s)" -ge "$deadline" ]; then
      while read -r st marker; do note "Missing evidence under token source $st: $marker"; done < "$WORK/pending"
      fail "Delivery evidence incomplete within $WAIT_SECONDS seconds"
    fi
    cp "$WORK/pending" "$WORK/evidence"; sleep 1
  done
}
verify() {
  if [ -n "$EVIDENCE_FILE" ]; then verify_evidence; return; fi
  [ -n "$SOURCE" ] || SOURCE=$(prompt 'Source type (--source)' '')
  # Fresh events stored under the source (metadata.log_source is the token's
  # bound route, whatever the sender claimed), within --window minutes.
  safe_id "$SOURCE"; search "metadata.log_source=\"$SOURCE\""
  printf '%s' "$RESPONSE" | records results > "$WORK/results" || fail 'Malformed search response'
  local count generic failed row parsed key val cls
  count=$(wc -l < "$WORK/results" | tr -d ' '); generic=0; failed=0; parsed=0
  while IFS= read -r row; do
    if printf '%s' "$row" | grep -Eq '"parser_type"[[:space:]]*:[[:space:]]*"generic"'; then generic=$((generic+1))
    elif printf '%s' "$row" | grep -Eq '"(ext[.])?parse_error"[[:space:]]*:[[:space:]]*"[^" ]'; then failed=$((failed+1))
    elif cls=$(get class_uid "$row"); then
      # OCSF rows: a mapped class is normalized; class 0 (Base Event) is not.
      if [ "$cls" != 0 ]; then parsed=$((parsed+1)); else generic=$((generic+1)); fi
    else
      for key in src_ip dest_ip src_port dest_port protocol action user src_user dest_user process_name file_path file_name url query; do
        val=$(get "$key" "$row" || :)
        if [ -n "$val" ] && [ "$val" != 0 ]; then parsed=$((parsed+1)); break; fi
      done
    fi
  done < "$WORK/results"
  note "$count fresh events under metadata.log_source=$SOURCE in the last $WINDOW minutes ($parsed normalized, $generic generic, $failed parser failures; sample limit 100)"
  [ "$count" -gt 0 ] || return 1
}
connect_flow() {
  [ -n "$SOURCE" ] || SOURCE=$(prompt 'Existing source for connectivity test (--source)' '')
  safe_id "$SOURCE"; load_tokens
  api GET setup/status
  [ "$(get initialized "$RESPONSE")" = true ] || fail 'Complete initial server setup first'
  resolve_ingest
  credential "$SOURCE"
  local marker n=0
  marker=nano-connect-$(date +%s)-$$-$RANDOM
  if [ "$TRANSPORT" = hec ]; then
    request POST "${INGEST_URL%/}/services/collector/event" "{\"sourcetype\":$(q "$SOURCE"),\"event\":$(q "nano-connect connectivity test $marker")}" hec || fail "Ingest rejected (HTTP $HTTP_CODE)"
  else
    request POST "$INGEST_URL" "{\"message\":$(q "nano-connect connectivity test $marker")}" ingest || fail "Ingest rejected (HTTP $HTTP_CODE)"
  fi
  while [ "$n" -lt 23 ]; do
    search "metadata.log_source=\"$SOURCE\" AND \"$marker\""
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
Usage: bash connect.sh [connect|add-source|add-agent|add-aggregator|list-sources|sync-parsers|verify|rotate-token|revoke-token|otlp-config] [flags]
  --url URL / NANO_URL (the nano app)    --api-key KEY / NANO_API_KEY
  --email EMAIL / NANO_EMAIL            --password PASSWORD / NANO_PASSWORD
  --env-file FILE (read BASE_URL only; never execute)
  --transport http|hec / NANO_TRANSPORT (default http: <ingest>/ingest; hec: the HEC listener)
  --ingest-base ORIGIN / NANO_INGEST_BASE (dedicated ingest host, e.g. https://ingest.example.com)
  --ingest-url URL / NANO_INGEST_URL (exact URL for the transport)
  --search-url URL / NANO_SEARCH_URL
  --source TYPE / NANO_SOURCE           --sources a,b:tcp,c:http / NANO_SOURCES
  --token-dir DIR / NANO_TOKEN_DIR (one named source credential per file)
  --rotate (persist replacement before revocation)
  --os linux|windows / NANO_OS          --target HOST:PORT (trusted aggregator)
  --no-journald                        --files PATH --file-source TYPE
  --agent-port PORT (9000)              --out-dir DIR / NANO_OUT_DIR
  --deploy-parsers (import + publish matching registry parsers)
  --run (docker compose deployment)     --window MINUTES (15)
  --add-official                        --builtin-only
  --yes / NANO_YES=1                    --non-interactive / NANO_NON_INTERACTIVE=1
  --evidence-file FILE / NANO_EVIDENCE_FILE (source marker pairs; verify)
  --wait-seconds SECONDS / NANO_WAIT_SECONDS (120; evidence deadline)
  --version                            --help
Secrets are never shown. Prefer env variables/private files over secret flags.
Ingest: the instance's configured ingest base (Log Sources ingest endpoint) is used
when it is dedicated; the app host's /ingest only when none is configured. Events are
never sent to the app host while a dedicated ingest base is configured.
OTLP exporters (otlp-config) use the source-bound Bearer token at <ingest>/otlp/v1/*.
EOF
}
main() {
  URL=${NANO_URL:-}; API_KEY=${NANO_API_KEY:-}; EMAIL=${NANO_EMAIL:-}; PASSWORD=${NANO_PASSWORD:-}; JWT=
  INGEST_URL=${NANO_INGEST_URL:-}; INGEST_BASE=${NANO_INGEST_BASE:-}; DELIVERY=; SEARCH_URL=${NANO_SEARCH_URL:-}; ENV_FILE=
  SOURCE=${NANO_SOURCE:-}; SOURCES=${NANO_SOURCES:-}; OUT=${NANO_OUT_DIR:-}; OS=${NANO_OS:-}; TARGET=${NANO_TARGET:-}
  TRANSPORT=${NANO_TRANSPORT:-http}; TOKEN_DIR=${NANO_TOKEN_DIR:-}; ROTATE=0; RUN=0; JOURNALD=1; FILES=; FILE_SOURCE=application
  AGENT_PORT=9000; WINDOW=15; DEPLOY_PARSERS=0; NATIVE_INPUT=tag; ADD_OFFICIAL=0; BUILTIN=0; YES=${NANO_YES:-0}; NONINTERACTIVE=${NANO_NON_INTERACTIVE:-0}
  CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}/nano-connect-bash
  COMMAND=connect; UPSTREAM=tag; TOKEN=; HEC_CHANNEL=
  EVIDENCE_FILE=${NANO_EVIDENCE_FILE:-}; WAIT_SECONDS=${NANO_WAIT_SECONDS:-120}
  [ -t 0 ] || NONINTERACTIVE=1
  [ -z "${NANO_TOKEN_FILE:-}${NANO_CREDENTIAL_ID:-}" ] || fail 'NANO_TOKEN_FILE/NANO_CREDENTIAL_ID were lake-hosted credentials, removed in 0.5.0; use --token-dir or let connect issue a token'
  while [ "$#" -gt 0 ]; do
    case "$1" in
      connect|add-source|add-agent|add-aggregator|list-sources|list-devices|sync-parsers|verify|rotate-token|revoke-token|otlp-config) COMMAND=$1; shift ;;
      --help|-h) help_text; return ;; --version|-v) printf '%s\n' "$VERSION"; return ;;
      --yes) YES=1; NONINTERACTIVE=1; shift ;; --non-interactive) NONINTERACTIVE=1; shift ;;
      --run) RUN=1; shift ;; --rotate) ROTATE=1; shift ;; --no-journald) JOURNALD=0; shift ;;
      --add-official) ADD_OFFICIAL=1; shift ;; --builtin-only) BUILTIN=1; shift ;;
      --to-nano) TARGET=; shift ;;
      --url|--api-key|--email|--password|--env-file|--ingest-url|--search-url|--source|--sources|--devices|--out-dir|--os|--target|--transport|--token-dir|--ingest-base|--files|--file-source|--agent-port|--window|--evidence-file|--wait-seconds)
        [ "$#" -ge 2 ] || fail 'Flag requires a value'
        case "$1" in
          --url) URL=$2 ;; --api-key) API_KEY=$2 ;; --email) EMAIL=$2 ;; --password) PASSWORD=$2 ;; --env-file) ENV_FILE=$2 ;;
          --ingest-url) INGEST_URL=$2 ;; --search-url) SEARCH_URL=$2 ;; --source) SOURCE=$2 ;;
          --sources|--devices) SOURCES=$2 ;; --out-dir) OUT=$2 ;; --os) OS=$2 ;; --target) TARGET=$2 ;;
          --ingest-base) INGEST_BASE=$2 ;; --transport) TRANSPORT=$2 ;; --token-dir) TOKEN_DIR=$2 ;; --files) FILES=$2 ;; --file-source) FILE_SOURCE=$2 ;;
          --agent-port) AGENT_PORT=$2 ;; --window) WINDOW=$2 ;;
          --evidence-file) EVIDENCE_FILE=$2 ;; --wait-seconds) WAIT_SECONDS=$2 ;;
        esac; shift 2 ;;
      --token-file|--credential-id) fail 'Lake-hosted source credentials were removed in 0.5.0; connect issues a per-source ingest token, or use --token-dir' ;;
      --ingest-token) fail 'Shared ingest token removed; use --token-dir with one bound credential per source' ;;
      --mtls-dir|--vector-host|--vector-port) fail 'Direct native nano uplink bypasses source credentials; use HEC/HTTP' ;;
      --deploy-parsers) DEPLOY_PARSERS=1; shift ;;
      *) fail 'Unknown command or flag; see --help' ;;
    esac
  done
  case "$TRANSPORT" in hec|http) ;; *) fail 'Use http or hec; native nano uplink bypasses source-bound credentials' ;; esac
  # An OTLP exporter has its own destination (<ingest>/otlp); --ingest-url here
  # is the OTLP endpoint and is saved separately from the collector transports.
  [ "$COMMAND" != otlp-config ] || TRANSPORT=otlp
  if ! [[ "$WAIT_SECONDS" =~ ^[0-9]{1,3}$ ]] || [ "$WAIT_SECONDS" -gt 120 ]; then fail 'Evidence deadline must be 0-120 seconds'; fi
  WAIT_SECONDS=$((10#$WAIT_SECONDS))
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
      [ -n "$SOURCE" ] || fail 'Pass --source for this OTLP exporter'
      safe_id "$SOURCE"; load_tokens
      # OTLP goes through the ingest edge's /otlp (token checked per request).
      resolve_ingest
      [ -n "$OUT" ] || OUT=./onboarding/otlp-$SOURCE
      private_dir "$OUT"; private_dir "$OUT/secrets"
      credential "$SOURCE"
      printf '%s' "$TOKEN" | atomic "$OUT/secrets/$SOURCE"
      { printf 'OTEL_EXPORTER_OTLP_ENDPOINT=%s\n' "$INGEST_URL"; printf 'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\n'; printf "OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer %s'\n" "$TOKEN"; } | atomic "$OUT/otel.env"
      note 'Private OTLP exporter environment generated. Each source needs its own exporter and bound credential; the server enforces revocation per request'
      ;;
    revoke-token)
      [ -n "$SOURCE" ] || fail 'Pass --source'
      safe_id "$SOURCE"; load_tokens
      local store=$STATE/credentials/$SOURCE/current cid
      [ -f "$store" ] || fail 'No token issued by nano-connect for this source on this instance; revoke others in Log Sources → ingest tokens'
      IFS= read -r cid < "$store"; safe_id "$cid"
      find_credential credential_id "$cid" >/dev/null || fail 'Stored credential is not listed by this instance'
      api POST "ingest-tokens/$cid/revoke"
      rm -f "$store"; note "Ingest token for $SOURCE revoked; collectors using it are refused within seconds"
      ;;
    rotate-token)
      [ -n "$SOURCE" ] || fail 'Pass --source'
      [ -n "$OUT" ] || fail 'Pass --out-dir for the collector whose secret is rotated'
      private_dir "$OUT"; private_dir "$OUT/secrets"
      ROTATE=1; load_tokens; credential "$SOURCE"; note 'Credential rotated; reload the collector to use its new secret'
      ;;
    list-sources)
      catalog; load_tokens; load_catalog
      {
        while IFS= read -r row; do
          local route
          route=$(get route_key "$row" || :)
          [ -z "$route" ] || printf '%s (instance)\n' "$route"
        done < "$WORK/sources"
        while IFS= read -r row; do
          if syslog_collectable "$row" && [ "$(get kind "$row" || :)" != enrichment ]; then
            route=$(parser_route "$row")
            [ -z "$route" ] || printf '%s (registry)\n' "$route"
          fi
        done < "$WORK/parsers"
      } | awk '!seen[$1]++'
      ;;
    add-source|add-agent|add-aggregator)
      if [ -z "$TARGET" ]; then
        load_tokens
        load_catalog
        resolve_ingest
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
