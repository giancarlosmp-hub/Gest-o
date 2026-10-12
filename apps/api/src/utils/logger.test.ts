import assert from "node:assert/strict";
import test from "node:test";
import { sanitizePayload } from "./logger.js";

test("redacts RG, birth date and state registration keys", () => {
  const sanitized = sanitizePayload({
    RG: "synthetic-rg",
    NUM_RG: "synthetic-rg",
    rgNumber: "synthetic-rg",
    clienteRg: "synthetic-rg",
    DATA_NASCIMENTO: "synthetic-birth",
    dtNascimento: "synthetic-birth",
    birthDate: "synthetic-birth",
    IE: "synthetic-ie",
    INSCESTADUAL: "synthetic-ie",
    INSCRICAO_ESTADUAL: "synthetic-ie",
    INSCRICAO: "synthetic-ie",
    inscricaoEstadual: "synthetic-ie",
    inscEstadual: "synthetic-ie",
    stateRegistration: "synthetic-ie",
    nested: { DT_NASC: "synthetic-birth", rg: "synthetic-rg" },
    status: "ACTIVE",
    cargo: "Comprador",
    progress: 3
  }) as Record<string, unknown>;

  assert.doesNotMatch(JSON.stringify(sanitized), /synthetic-(rg|birth|ie)/);
  assert.equal(sanitized.status, "ACTIVE");
  assert.equal(sanitized.cargo, "Comprador");
  assert.equal(sanitized.progress, 3);
});
