#!/usr/bin/env bash
set -euo pipefail
sentinel=$(mktemp -u); trap 'rm -f "$sentinel"' EXIT
secret='Strong ; "single'"'"' $dollar !bang (paren) \backslash `backtick` ; touch '"$sentinel"' ; spaces =+/ value'
encoded=$(printf '%s' "$secret" | base64 -w 0)
case "$encoded" in *[!A-Za-z0-9+/=]*) exit 1;; esac
decoded=$(printf '%s' "$encoded" | base64 --decode)
test "$decoded" = "$secret"
expected_hash=$(printf '%s' "$secret" | sha256sum | cut -d' ' -f1)
PREVIEW_SEED_PASSWORD="$decoded" node -e 'const c=require("crypto");const actual=c.createHash("sha256").update(process.env.PREVIEW_SEED_PASSWORD).digest("hex");if(actual!==process.argv[1])process.exit(1)' "$expected_hash" > /tmp/preview-secret-test.log
test ! -e "$sentinel"
! grep -Fq "$secret" /tmp/preview-secret-test.log
rm -f /tmp/preview-secret-test.log
echo 'BASH_SYNTAX_VALID=YES'
echo 'ADDITIONAL_COMMAND_EXECUTED=NO'
echo 'SENTINEL_FILE_CREATED=NO'
echo 'SECRET_REACHES_SEED_UNCHANGED=YES'
echo 'SECRET_LOGGED=NO'
