import { Prisma } from "@prisma/client";
import { z } from "zod";

// Resposta do ramo genérico do handler de erro final. Nunca leva stack, código Prisma, meta ou texto interno:
// o detalhe completo fica só no log do servidor, ligado pelo requestId.
export type ApiErrorResponse = { status: number; body: Record<string, unknown> };

export const PRISMA_UNIQUE_MESSAGE = "Já existe um registro com esses dados.";
export const PRISMA_FOREIGN_KEY_MESSAGE = "Operação bloqueada: há registros vinculados.";
export const PRISMA_NOT_FOUND_MESSAGE = "Registro não encontrado.";
export const INVALID_PAYLOAD_MESSAGE = "Payload inválido";

const CLIENT_ERROR_MESSAGES: Record<number, string> = {
  413: "Conteúdo muito grande.",
  415: "Tipo de conteúdo não suportado.",
};

const isZodError = (error: unknown): error is z.ZodError =>
  error instanceof z.ZodError
  // Schemas do pacote shared podem vir de outra cópia do zod.
  || (error instanceof Error && error.name === "ZodError" && Array.isArray((error as { issues?: unknown }).issues));

// Erros do body-parser e afins (http-errors) marcam com expose=true os 4xx que podem ser mostrados ao cliente.
const exposedClientErrorStatus = (error: unknown) => {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { expose?: unknown; status?: unknown; statusCode?: unknown };
  if (candidate.expose !== true) return null;
  const status = Number(candidate.status ?? candidate.statusCode);
  return Number.isInteger(status) && status >= 400 && status < 500 ? status : null;
};

export const internalErrorMessage = (requestId?: string) =>
  requestId ? `Erro interno. Informe o código ${requestId} ao suporte.` : "Erro interno. Tente novamente em instantes.";

export function resolveApiErrorResponse(error: unknown, requestId?: string): ApiErrorResponse {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") return { status: 409, body: { message: PRISMA_UNIQUE_MESSAGE } };
    if (error.code === "P2003") return { status: 409, body: { message: PRISMA_FOREIGN_KEY_MESSAGE } };
    if (error.code === "P2025") return { status: 404, body: { message: PRISMA_NOT_FOUND_MESSAGE } };
  }

  if (isZodError(error)) {
    return { status: 400, body: { message: error.issues[0]?.message || INVALID_PAYLOAD_MESSAGE } };
  }

  const clientStatus = exposedClientErrorStatus(error);
  if (clientStatus) {
    return { status: clientStatus, body: { message: CLIENT_ERROR_MESSAGES[clientStatus] ?? "Requisição inválida." } };
  }

  // Inclui PrismaClientValidationError: o texto dele descreve o schema, então fica 500 genérico.
  return { status: 500, body: { message: internalErrorMessage(requestId), ...(requestId ? { requestId } : {}) } };
}
