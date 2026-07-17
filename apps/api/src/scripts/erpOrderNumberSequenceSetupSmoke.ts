import assert from "node:assert/strict";
import { prisma } from "../config/prisma.js";
import { ensureErpOrderNumberSequence } from "../services/erpOrderNumberSequenceSetup.js";

const SEQUENCE_NAME = "public.erp_order_number_seq";

type SequenceExistsRow = { exists: boolean };
type SequenceBoundsRow = { last_value: bigint; is_called: boolean };

async function sequenceExists() {
  const [row] = await prisma.$queryRaw<SequenceExistsRow[]>`SELECT to_regclass('public.erp_order_number_seq') IS NOT NULL AS "exists"`;
  return row?.exists === true;
}

async function readSequenceBounds() {
  const [row] = await prisma.$queryRawUnsafe<SequenceBoundsRow[]>(`SELECT last_value, is_called FROM ${SEQUENCE_NAME}`);
  return row;
}

async function main() {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL é obrigatório para executar o smoke real da sequence");

  await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS ${SEQUENCE_NAME}`);
  assert.equal(await sequenceExists(), false, "pré-condição: sequence deve iniciar inexistente");

  await ensureErpOrderNumberSequence();
  assert.equal(await sequenceExists(), true, "setup deve criar sequence inexistente");
  const afterCreate = await readSequenceBounds();
  assert.equal(afterCreate.last_value, 900001n, "sequence criada deve iniciar em 900001");
  assert.equal(afterCreate.is_called, false, "sequence recém-criada não deve consumir número");

  await ensureErpOrderNumberSequence();
  assert.equal(await sequenceExists(), true, "setup deve aceitar sequence já existente");
  const afterSecondRun = await readSequenceBounds();
  assert.equal(afterSecondRun.last_value, afterCreate.last_value, "segunda execução não deve avançar a sequence");
  assert.equal(afterSecondRun.is_called, afterCreate.is_called, "segunda execução deve preservar is_called");

  await ensureErpOrderNumberSequence();
  assert.equal(await sequenceExists(), true, "terceira execução consecutiva deve permanecer idempotente");

  console.log("ERP order sequence setup smoke passed");
}

main()
  .catch((error) => {
    console.error("ERP order sequence setup smoke failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
