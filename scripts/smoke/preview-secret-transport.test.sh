#!/usr/bin/env bash
set -euo pipefail
secret='Strong ; "single'"'"' $dollar !bang and spaces =+/ value'
encoded=$(printf '%s' "$secret" | base64 -w 0)
case "$encoded" in *[!A-Za-z0-9+/=]*) exit 1;; esac
decoded=$(printf '%s' "$encoded" | base64 --decode)
test "$decoded" = "$secret"
echo 'preview secret transport: PASS'
