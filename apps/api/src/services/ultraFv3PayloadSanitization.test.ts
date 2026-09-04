import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeUltraFv3PayloadForLog } from "./ultraFv3PayloadSanitization.js";

test("redacts PII and secrets from inferred partner payload aliases", () => {
  const sanitized = sanitizeUltraFv3PayloadForLog({
    TELEFONE: "synthetic-phone",
    email: "synthetic-email",
    RAZAO_SOCIAL: "synthetic-name",
    ENDERECO: "synthetic-address",
    CPF_CNPJ: "synthetic-document",
    password: "synthetic-secret",
    status: "ACTIVE",
    nested: { celular: "synthetic-mobile", count: 1 },
  });

  assert.deepEqual(sanitized, {
    TELEFONE: "***",
    email: "***",
    RAZAO_SOCIAL: "***",
    ENDERECO: "***",
    CPF_CNPJ: "***",
    password: "***",
    status: "ACTIVE",
    nested: { celular: "***", count: 1 },
  });
  assert.doesNotMatch(JSON.stringify(sanitized), /synthetic-(phone|email|name|address|document|secret|mobile)/);
});

test("bounds arrays, strings and recursion in diagnostics", () => {
  const sanitized = sanitizeUltraFv3PayloadForLog({
    rows: [1, 2, 3, 4],
    description: "x".repeat(200),
    level1: { level2: { level3: { level4: "not logged" } } },
  }) as Record<string, unknown>;

  assert.deepEqual(sanitized.rows, [1, 2, 3]);
  assert.equal(String(sanitized.description).length, 163);
  assert.match(JSON.stringify(sanitized), /max-depth/);
});
