#!/usr/bin/env bash
set -Eeuo pipefail
root=/var/log/gest-o/backup
result=$root/latest/result.tsv
[[ ! -e "$root" && ! -L "$root" ]] || { echo 'test requires an absent canonical backup proof root' >&2; exit 1; }
tmp=$(mktemp -d); cleanup(){ rm -rf -- "$root" "$tmp"; }; trap cleanup EXIT
source scripts/lib/pr827-backup-proof.sh
sha=124e52e13fb941a27acfc806aab479fa2ae77d6c
printf '%s\nCREATE TABLE proof(id integer);\n' 'PostgreSQL database dump' >"$tmp/source.sql"
gzip -c "$tmp/source.sql" >"$tmp/source.sql.gz"

# Producer and apply consumer are pinned to one literal path.
grep -Fq 'BACKUP_RESULT_FILE=/var/log/gest-o/backup/latest/result.tsv' .github/workflows/prepare-production-recovery-backup.yml
grep -Fq 'BACKUP_RESULT_FILE=/var/log/gest-o/backup/latest/result.tsv' .github/workflows/production-schema-pr827.yml
! pr827_backup_proof_validate "$result" "$sha" 3600

PR827_BACKUP_TEST_FAIL_PUBLICATION=true
! pr827_backup_proof_publish "$tmp/source.sql.gz" "$sha" "$result" 3600
[[ ! -e "$root/latest" ]] && ! find "$root" -mindepth 1 -name '.latest.*' -print -quit | grep -q .
unset PR827_BACKUP_TEST_FAIL_PUBLICATION
pr827_backup_proof_publish "$tmp/source.sql.gz" "$sha" "$result" 3600
pr827_backup_proof_validate "$result" "$sha" 3600

cp "$root/latest/dump.sql.gz.sha256" "$tmp/manifest"
printf '%064d  dump.sql.gz\n' 0 >"$root/latest/dump.sql.gz.sha256"
! pr827_backup_proof_validate "$result" "$sha" 3600
cp "$tmp/manifest" "$root/latest/dump.sql.gz.sha256"; chmod 600 "$root/latest/dump.sql.gz.sha256"
chmod 644 "$result"; ! pr827_backup_proof_validate "$result" "$sha" 3600; chmod 600 "$result"
chown nobody:nogroup "$result"; ! pr827_backup_proof_validate "$result" "$sha" 3600; chown root:root "$result"
mv "$root/latest/dump.sql.gz" "$tmp/dump"; ln -s "$tmp/dump" "$root/latest/dump.sql.gz"
! pr827_backup_proof_validate "$result" "$sha" 3600
rm "$root/latest/dump.sql.gz"; mv "$tmp/dump" "$root/latest/dump.sql.gz"; chmod 600 "$root/latest/dump.sql.gz"

# A new approved publication replaces the prior bundle and cleanup retains no
# staging/previous bundle. Unrelated historical result.tsv paths are rejected.
pr827_backup_proof_publish "$tmp/source.sql.gz" "$sha" "$result" 3600
[[ "$(find "$root" -mindepth 1 -maxdepth 1 -printf '%f\n')" == latest ]]
! pr827_backup_proof_validate /var/log/gest-o/tenancy/latest/result.tsv "$sha" 3600
! pr827_backup_proof_validate /var/log/gest-o/control-plane/latest/result.tsv "$sha" 3600
echo PR827_BACKUP_PROOF_CONTRACT_TEST=PASS
