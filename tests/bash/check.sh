#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
bash -n connect.sh
shellcheck -s bash connect.sh tests/bash/unit.sh tests/bash/check.sh
bash tests/bash/unit.sh
python3 tests/bash/test.py
# Guard remains useful even when an actual Bash 3.2 interpreter is unavailable.
if LC_ALL=C grep -En 'declare -A|local -A|mapfile|readarray|\$\{[^}]*,,|\|&|&>>|\b(coproc|globstar)\b' connect.sh; then
  printf 'Bash 3.2 incompatible syntax detected\n' >&2; exit 1
fi
bash --posix tests/bash/unit.sh
