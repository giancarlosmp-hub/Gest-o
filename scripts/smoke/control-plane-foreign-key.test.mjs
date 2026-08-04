#!/usr/bin/env node
import assert from "node:assert/strict";
import { validateForeignKeys } from "../control-plane-foreign-key.mjs";

const detail = (overrides={}, definition='FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT') => ({
  source_schema:"public", source:"TenantMembership", source_columns:"tenantId", target_schema:"public", target:"Tenant", target_columns:"id",
  delete:"RESTRICT", update:"CASCADE", validated:"true", definition, ...overrides
});
const encode = fields => Object.entries(fields).map(([key,value])=>`${key}=${value}`).join(";");
const rows = (tenant=detail(), user=detail({source_columns:"userId",target:"User"},'FOREIGN KEY (userId) REFERENCES public.User ( id ) ON DELETE RESTRICT ON UPDATE CASCADE')) => [
  {kind:"fk",object:"TenantMembership_tenantId_fkey",position:0,detail:encode(tenant)},
  {kind:"fk",object:"TenantMembership_userId_fkey",position:0,detail:encode(user)}
];
const rejects = candidate => {
  const original=console.error; console.error=()=>{};
  try { assert.throws(()=>validateForeignKeys(candidate),/CATALOG_FK/); } finally { console.error=original; }
};

// Human-readable pg_get_constraintdef formatting is deliberately irrelevant to semantic authority.
validateForeignKeys(rows());
validateForeignKeys(rows(detail({},'FOREIGN KEY ( tenantId ) REFERENCES public."Tenant" ( "id" ) ON DELETE RESTRICT ON UPDATE CASCADE')));
validateForeignKeys(rows(detail({},'  FOREIGN   KEY ("tenantId")  REFERENCES "public"."Tenant"("id")  ')));

rejects(rows(detail({source:"Other"})));
rejects(rows(detail({source_columns:"other"})));
rejects(rows(detail({target:"Other"})));
rejects(rows(detail({target_columns:"other"})));
rejects(rows(detail({delete:"CASCADE"})));
rejects(rows(detail({delete:"NO ACTION"})));
rejects(rows(detail({update:"NO ACTION"})));
rejects(rows(detail({validated:"false"})));
rejects(rows().slice(0,1));
rejects([...rows(),{kind:"fk",object:"TenantMembership_extra_fkey",position:0,detail:encode(detail())}]);
rejects(rows().map((row,index)=>index?row:{...row,object:"TenantMembership_wrong_fkey"}));
rejects(rows(detail({source_columns:"tenantId,other",target_columns:"id,id"})));
rejects(rows(detail({source_columns:"other,tenantId",target_columns:"id,id"})));
rejects(rows().map((row,index)=>index?row:{...row,detail:"source=TenantMembership"}));
rejects(rows(detail({delete:"UNKNOWN:x"})));
console.log("control-plane foreign-key semantic tests passed");
