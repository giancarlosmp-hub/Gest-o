import assert from "node:assert/strict";

const validate = (output) => {
  if (output.length === 0) return false;
  const lines = output.split("\n");
  return lines.length === 1 && lines[0] === "BLOCKED_EXPECTED";
};

assert.equal(validate("BLOCKED_EXPECTED"), true);
assert.equal(validate("BEGIN\nBLOCKED_EXPECTED\nCOMMIT"), false, "psql command tags must never enter result");
assert.equal(validate("BLOCKED_EXPECTED\nEXTRA"), false);
assert.equal(validate(""), false);
assert.equal(validate("READY"), false);
console.log("TENANT_DATA_READINESS_OUTPUT_CONTRACT=PASS");
