import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  PRISMA_FOREIGN_KEY_MESSAGE,
  PRISMA_NOT_FOUND_MESSAGE,
  PRISMA_UNIQUE_MESSAGE,
  resolveApiErrorResponse,
} from "./apiErrorResponse.js";

// Erros fictícios: o ramo genérico do handler final nunca devolve detalhe interno.
const known = (code: string) => new Prisma.PrismaClientKnownRequestError(`detalhe interno ${code} tabela_ficticia`, {
  code,
  clientVersion: "test",
  meta: { target: ["coluna_ficticia"] },
});

assert.deepEqual(resolveApiErrorResponse(known("P2002"), "req-teste01"), { status: 409, body: { message: PRISMA_UNIQUE_MESSAGE } });
assert.deepEqual(resolveApiErrorResponse(known("P2003"), "req-teste01"), { status: 409, body: { message: PRISMA_FOREIGN_KEY_MESSAGE } });
assert.deepEqual(resolveApiErrorResponse(known("P2025"), "req-teste01"), { status: 404, body: { message: PRISMA_NOT_FOUND_MESSAGE } });

const generic500 = { status: 500, body: { message: "Erro interno. Informe o código req-teste01 ao suporte.", requestId: "req-teste01" } };
assert.deepEqual(resolveApiErrorResponse(known("P2010"), "req-teste01"), generic500, "outros códigos Prisma ficam 500 genérico");
assert.deepEqual(
  resolveApiErrorResponse(new Prisma.PrismaClientValidationError("Argument `campoFicticio` is missing.", { clientVersion: "test" }), "req-teste01"),
  generic500,
  "PrismaClientValidationError não expõe o schema",
);
assert.deepEqual(resolveApiErrorResponse(new Error("detalhe interno fictício"), "req-teste01"), generic500);
assert.deepEqual(resolveApiErrorResponse("texto solto", undefined), { status: 500, body: { message: "Erro interno. Tente novamente em instantes." } });

const zodFailure = z.object({ nome: z.string({ required_error: "Nome é obrigatório" }) }).safeParse({});
assert.equal(zodFailure.success, false);
if (!zodFailure.success) {
  assert.deepEqual(resolveApiErrorResponse(zodFailure.error, "req-teste01"), { status: 400, body: { message: "Nome é obrigatório" } });
}
const foreignZod = Object.assign(new Error("[]"), { name: "ZodError", issues: [] });
assert.deepEqual(resolveApiErrorResponse(foreignZod, "req-teste01"), { status: 400, body: { message: "Payload inválido" } });

// body-parser (http-errors): 4xx com expose=true.
const parseError = Object.assign(new SyntaxError("Unexpected token f in JSON at position 1"), { status: 400, expose: true, type: "entity.parse.failed" });
assert.deepEqual(resolveApiErrorResponse(parseError, "req-teste01"), { status: 400, body: { message: "Requisição inválida." } });
const tooLarge = Object.assign(new Error("request entity too large"), { status: 413, expose: true });
assert.deepEqual(resolveApiErrorResponse(tooLarge, "req-teste01"), { status: 413, body: { message: "Conteúdo muito grande." } });
const notExposed = Object.assign(new Error("status sem expose"), { status: 404 });
assert.deepEqual(resolveApiErrorResponse(notExposed, "req-teste01"), generic500, "status sem expose=true não é confiável");

for (const response of [resolveApiErrorResponse(known("P2002")), resolveApiErrorResponse(new Error("detalhe interno fictício"), "req-teste01")]) {
  const text = JSON.stringify(response.body);
  assert.ok(!/detalhe interno|coluna_ficticia|tabela_ficticia|P20\d\d|stack/i.test(text), `sem detalhe interno: ${text}`);
}

console.log("apiErrorResponse.test.ts: ok");
