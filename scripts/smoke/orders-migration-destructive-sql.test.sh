#!/usr/bin/env bash
set -euo pipefail
pattern='^[[:space:]]*(delete[[:space:]]+from|truncate([[:space:]]+table)?|drop[[:space:]]+table)[[:space:]]'
for safe in \
  'CONSTRAINT "fk" FOREIGN KEY ("id") REFERENCES "Parent"("id") ON DELETE CASCADE' \
  'CONSTRAINT "fk" FOREIGN KEY ("id") REFERENCES "Parent"("id") ON DELETE RESTRICT'; do
  if printf '%s\n' "$safe" | grep -Eiq "$pattern"; then exit 1; fi
done
for destructive in 'DELETE FROM "Order";' 'TRUNCATE TABLE "Order";' 'DROP TABLE "Order";'; do
  printf '%s\n' "$destructive" | grep -Eiq "$pattern"
done
echo 'orders migration destructive SQL classifier: PASS'
