#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const roots = ["KnowledgeDocument","Client","AgendaEvent","Goal","ActivityKPI","Sale","SellerTerritoryCity","AppConfig","Product","ErpSyncRun","ErpSyncLock"];
export const tenancyExpandRoots = Object.freeze(roots);
export function validateCatalogText(text) {
  const lines = text.trim().split(/\n/).filter(Boolean);
  if (lines.length !== 33) throw new Error(`CATALOG_NOT_EXACT:${lines.length}`);
  const rows = new Map(lines.map(line => { const p=line.split("\t"); if(p.length!==3) throw new Error("CATALOG_FORMAT"); return [`${p[0]}:${p[1]}`,p[2]]; }));
  if (rows.size !== 33) throw new Error("CATALOG_DUPLICATE_OBJECT");
  for (const root of roots) {
    const col=rows.get(`column:${root}.tenantId`);
    const idx=rows.get(`index:${root}_tenantId_idx`);
    const fk=rows.get(`fk:${root}_tenantId_fkey`);
    if (col !== "text|nullable=YES|default=") throw new Error(`COLUMN_DIVERGENT:${root}`);
    if (!idx?.includes(`CREATE INDEX \"${root}_tenantId_idx\" ON public.\"${root}\" USING btree (\"tenantId\")`)) throw new Error(`INDEX_DIVERGENT:${root}`);
    const expected=`source=${root};source_columns=tenantId;target=Tenant;target_columns=id;delete=NO_ACTION;update=NO_ACTION;validated=TRUE`;
    if (fk !== expected) throw new Error(`FK_DIVERGENT:${root}`);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateCatalogText(readFileSync(process.argv[2], "utf8"));
  console.log("TENANCY_EXPAND_ROOTS_CATALOG=EXACT");
}
