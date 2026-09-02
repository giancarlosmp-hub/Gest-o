#!/usr/bin/env bash
set -Eeuo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export PR827_BACKUP_PROOF_ROOT="$tmp/backup"
export PR827_BACKUP_PROOF_EXPECTED_OWNER="$(id -un):$(id -gn)"
result=$PR827_BACKUP_PROOF_ROOT/latest/result.tsv
source "$repo/scripts/lib/pr827-backup-proof.sh"
sha=124e52e13fb941a27acfc806aab479fa2ae77d6c
other=224e52e13fb941a27acfc806aab479fa2ae77d6c
printf '%s\nCREATE TABLE proof(id integer);\n' 'PostgreSQL database dump' >"$tmp/source.sql"
gzip -c "$tmp/source.sql" >"$tmp/source.sql.gz"
publish(){ pr827_backup_proof_publish "$tmp/source.sql.gz" "$sha" "$result" 3600; }
validate(){ pr827_backup_proof_validate "$result" "$sha" 3600; }
reject(){ if validate >/dev/null 2>&1; then echo "accepted negative: $1" >&2; exit 1; fi; }

# FORMAT=1 is intentionally unsafe and fails closed. Failed publication leaves no pointer.
mkdir -p "$PR827_BACKUP_PROOF_ROOT/latest" "$PR827_BACKUP_PROOF_ROOT/bundles"; chmod 700 "$PR827_BACKUP_PROOF_ROOT"/{latest,bundles}; printf 'FORMAT\t1\n' >"$result"; chmod 600 "$result"; reject format1
rm -rf "$PR827_BACKUP_PROOF_ROOT/latest"
PR827_BACKUP_TEST_FAIL_PUBLICATION=true; ! publish; unset PR827_BACKUP_TEST_FAIL_PUBLICATION
[[ ! -e "$PR827_BACKUP_PROOF_ROOT/latest" ]]
publish; validate
producer_identity=$PR827_BACKUP_RESOLVED_IDENTITY; producer_digest=$PR827_BACKUP_RESOLVED_SHA256
validate
[[ "$PR827_BACKUP_RESOLVED_IDENTITY" == "$producer_identity" && "$PR827_BACKUP_RESOLVED_SHA256" == "$producer_digest" ]]
[[ $(stat -c %h "$PR827_BACKUP_RESOLVED_DUMP") == 1 ]]

save="$tmp/result"; cp "$result" "$save"
sed -i "s/^SHA.*/SHA\t$other/" "$result"; reject sha_divergent; cp "$save" "$result"
sed -i 's/^BUNDLE_ID.*/BUNDLE_ID\tbad/' "$result"; reject bundle_id; cp "$save" "$result"
sed -i 's#^DUMP_PATH.*#DUMP_PATH\t../../etc/passwd#' "$result"; reject traversal; cp "$save" "$result"
sed -i 's#^MANIFEST_PATH.*#MANIFEST_PATH\tbundles/bad/dump.sql.gz.sha256#' "$result"; reject other_manifest; cp "$save" "$result"
sed -i 's/^DUMP_SHA256.*/DUMP_SHA256\t0000000000000000000000000000000000000000000000000000000000000000/' "$result"; reject checksum_proof; cp "$save" "$result"
chmod 644 "$result"; reject result_mode; chmod 600 "$result"
bundle=$(dirname "$PR827_BACKUP_RESOLVED_DUMP"); dump=$bundle/dump.sql.gz; manifest=$dump.sha256
cp "$dump" "$tmp/dump"; rm "$dump"; ln -s "$tmp/dump" "$dump"; reject symlink; rm "$dump"; cp "$tmp/dump" "$dump"; chmod 600 "$dump"
# Replacement has a different inode even with identical bytes and protected mtime.
touch -d "@$(awk -F'\t' '$1=="MTIME_EPOCH"{print $2}' "$result")" "$dump"; reject replaced_inode
rm -rf "$PR827_BACKUP_PROOF_ROOT"; publish; validate; bundle=$(dirname "$PR827_BACKUP_RESOLVED_DUMP"); dump=$bundle/dump.sql.gz; manifest=$dump.sha256
ln "$dump" "$tmp/hardlink"; reject hardlink; rm "$tmp/hardlink"
printf x >>"$dump"; reject checksum_mismatch
rm -rf "$PR827_BACKUP_PROOF_ROOT"; publish; validate; bundle=$(dirname "$PR827_BACKUP_RESOLVED_DUMP"); dump=$bundle/dump.sql.gz; manifest=$dump.sha256
rm "$manifest"; reject missing
rm -rf "$PR827_BACKUP_PROOF_ROOT"; publish; validate; bundle=$(dirname "$PR827_BACKUP_RESOLVED_DUMP"); touch "$bundle/extra"; chmod 600 "$bundle/extra"; reject extra_file
rm -rf "$PR827_BACKUP_PROOF_ROOT"; publish; validate
created=$(awk -F'\t' '$1=="CREATED_AT_EPOCH"{print $2}' "$result")
sed -i "s/^CREATED_AT_EPOCH.*/CREATED_AT_EPOCH\t$((created+7200))/" "$result"; reject future
cp "$save" "$result" 2>/dev/null || true
# Static regression: preflight may not bind or mention the historical fixed pair.
! grep -Eq 'backup_bind_canonical_pair|production\.sql\.gz' "$repo/scripts/production-preflight.sh"
grep -Fq 'pr827_backup_proof_validate "$BACKUP_RESULT_FILE"' "$repo/scripts/production-preflight.sh"
echo PR827_BACKUP_PROOF_CONTRACT_TEST=PASS
