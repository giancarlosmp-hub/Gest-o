#!/usr/bin/env node
import { tenancyExpandRoots as roots, validateCatalogText } from "../tenancy-expand-roots-catalog-validate.mjs";

function catalog(overrides = new Map(), omitted = new Set()) {
  const lines=[];
  for (const root of roots) {
    lines.push(`column\t${root}.tenantId\ttext|nullable=YES|default=`);
    lines.push(`index\t${root}_tenantId_idx\tCREATE INDEX \"${root}_tenantId_idx\" ON public.\"${root}\" USING btree (\"tenantId\")`);
    const key=`fk:${root}`;
    if (!omitted.has(key)) lines.push(`fk\t${root}_tenantId_fkey\t${overrides.get(key) ?? `source=${root};source_columns=tenantId;target=Tenant;target_columns=id;delete=NO_ACTION;update=NO_ACTION;validated=TRUE`}`);
  }
  return lines.join("\n")+"\n";
}
validateCatalogText(catalog());
const base="source=KnowledgeDocument;source_columns=tenantId;target=Tenant;target_columns=id;delete=NO_ACTION;update=NO_ACTION;validated=TRUE";
const negatives = [
  ["CASCADE", base.replace("delete=NO_ACTION", "delete=CASCADE")],
  ["SET_NULL", base.replace("delete=NO_ACTION", "delete=SET_NULL")],
  ["RESTRICT", base.replace("update=NO_ACTION", "update=RESTRICT")],
  ["target", base.replace("target=Tenant", "target=User")],
  ["source column", base.replace("source_columns=tenantId", "source_columns=id")],
  ["target column", base.replace("target_columns=id", "target_columns=tenantId")],
  ["not validated", base.replace("validated=TRUE", "validated=FALSE")]
];
for (const [name, detail] of negatives) {
  try { validateCatalogText(catalog(new Map([["fk:KnowledgeDocument", detail]]))); throw new Error(`${name} accepted`); }
  catch (error) { if (!String(error.message).startsWith("FK_DIVERGENT:")) throw error; }
}
try { validateCatalogText(catalog(new Map(), new Set(["fk:KnowledgeDocument"]))); throw new Error("absent FK accepted"); }
catch (error) { if (!String(error.message).startsWith("CATALOG_NOT_EXACT:")) throw error; }
console.log("TENANCY_EXPAND_ROOTS_FK_NEGATIVE_CASES=PASS");
