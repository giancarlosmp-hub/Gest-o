export const expectedForeignKeys = Object.freeze({
  TenantMembership_tenantId_fkey: Object.freeze({ source_schema: "public", source: "TenantMembership", source_columns: "tenantId", target_schema: "public", target: "Tenant", target_columns: "id", delete: "RESTRICT", update: "CASCADE", validated: "true" }),
  TenantMembership_userId_fkey: Object.freeze({ source_schema: "public", source: "TenantMembership", source_columns: "userId", target_schema: "public", target: "User", target_columns: "id", delete: "RESTRICT", update: "CASCADE", validated: "true" })
});

export const parseForeignKeyDetail = detail => {
  const fields = Object.fromEntries(detail.split(";").map(part => {
    const separator = part.indexOf("=");
    if (separator < 1) throw new Error("CATALOG_FK_INCOMPLETE_TSV");
    return [part.slice(0, separator), part.slice(separator + 1)];
  }));
  const required = ["source_schema", "source", "source_columns", "target_schema", "target", "target_columns", "delete", "update", "validated", "definition"];
  if (required.some(field => !(field in fields))) throw new Error("CATALOG_FK_INCOMPLETE_TSV");
  return fields;
};

const diagnostic = (name, expected, actual) => {
  console.error("===== EXPECTED FK =====");
  console.error(JSON.stringify({ name, ...expected }, null, 2));
  console.error("===== ACTUAL FK =====");
  console.error(JSON.stringify(actual ? { name, ...actual } : { name, state: "MISSING" }, null, 2));
};

export function validateForeignKeys(candidateRows) {
  const fkRows = candidateRows.filter(row => row.kind === "fk");
  const expectedNames = Object.keys(expectedForeignKeys).sort();
  const actualNames = fkRows.map(row => row.object).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    for (const name of expectedNames) {
      const row = fkRows.find(candidate => candidate.object === name);
      let actual;
      try { actual = row && parseForeignKeyDetail(row.detail); } catch (error) { actual = { parseError: error.message }; }
      diagnostic(name, expectedForeignKeys[name], actual);
    }
    throw new Error("CATALOG_FK_SET_MISMATCH");
  }
  for (const name of expectedNames) {
    let actual;
    try { actual = parseForeignKeyDetail(fkRows.find(row => row.object === name).detail); }
    catch (error) { diagnostic(name, expectedForeignKeys[name], { parseError: error.message }); throw error; }
    const semantic = Object.fromEntries(Object.keys(expectedForeignKeys[name]).map(field => [field, actual[field]]));
    if (JSON.stringify(semantic) !== JSON.stringify(expectedForeignKeys[name]) || /UNKNOWN:/.test(actual.delete) || /UNKNOWN:/.test(actual.update)) {
      diagnostic(name, expectedForeignKeys[name], actual);
      throw new Error(`CATALOG_FK_SEMANTIC_MISMATCH:${name}`);
    }
  }
}
