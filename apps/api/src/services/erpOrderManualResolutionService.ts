import { ErpOrderSyncStatus, Prisma, Role } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { decryptErpCredential } from "./erpCredentialCrypto.js";
import { classifyUltraFv3OrderLookup } from "./erpOrderService.js";
import { requestUltraFv3ReadOnlyWithCredentialsRetry } from "./ultraFv3SyncService.js";

const ERP_ORDER_ADVISORY_LOCK_NAMESPACE = 73_001;
export const MANUAL_NOT_FOUND_CATEGORY = "manual_verified_not_found";
export const MANUAL_RESOLUTION_TERMINAL_STATE = "manually_resolved_not_found";
export const MANUAL_RESOLUTION_CONFIRMATION_PHRASE = "CONFIRMEI QUE O PEDIDO NÃO EXISTE NO ERP";
export const MANUAL_REVIEW_CHECKBOX_TEXT = "Consultei o UltraFV3 pelo cliente, data, valor e identificador de importação e confirmo que o pedido não foi encontrado.";
export const MANUAL_REVIEW_SECOND_CONFIRMATION_TEXT = "Esta ação não apaga a tentativa anterior. Ela registra uma decisão operacional e permitirá nova tentativa controlada.";
const SENSITIVE_JUSTIFICATION_PATTERN = /authorization|bearer|token|password|senha|secret|cookie|cpf|cnpj|e-?mail|telefone|[\w.+-]+@[\w.-]+|\d{9,}/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateManualResolutionInput(input: {
  expectedImportIdSuffix: string;
  justification: string;
  originalCorrelationId: string;
  checkedNotFound: boolean;
  confirmedConsequence: boolean;
  confirmationPhrase: string;
}, pedidoIdImportacao: string) {
  if (!input.checkedNotFound || !input.confirmedConsequence) throw Object.assign(new Error("As duas confirmações explícitas são obrigatórias."), { status: 422 });
  if (input.confirmationPhrase.trim() !== MANUAL_RESOLUTION_CONFIRMATION_PHRASE) throw Object.assign(new Error("A frase de confirmação não confere."), { status: 422 });
  const suffix = input.expectedImportIdSuffix.trim().toLowerCase();
  if (suffix.length !== 8 || !pedidoIdImportacao.toLowerCase().endsWith(suffix)) throw Object.assign(new Error("Os últimos 8 caracteres do pedidoIdImportacao não conferem."), { status: 422 });
  const justification = input.justification.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (justification.length < 10 || justification.length > 240) throw Object.assign(new Error("A justificativa deve ter entre 10 e 240 caracteres."), { status: 422 });
  if (SENSITIVE_JUSTIFICATION_PATTERN.test(justification)) throw Object.assign(new Error("A justificativa não pode conter credenciais nem dados sensíveis."), { status: 422 });
  if (!UUID_PATTERN.test(input.originalCorrelationId)) throw Object.assign(new Error("correlationId original inválido."), { status: 422 });
  return { justification, originalCorrelationId: input.originalCorrelationId.toLowerCase() };
}

export function assertFreshUnknownStatusCheck(
  check: { outcome: string; checkedAt: Date },
  now = new Date(),
  maxAgeMs = 60_000,
) {
  const ageMs = now.getTime() - check.checkedAt.getTime();
  if (ageMs < 0 || ageMs > maxAgeMs) throw Object.assign(new Error("A consulta de status não é recente; consulte novamente antes de resolver."), { status: 409 });
  if (check.outcome !== "unknown") throw Object.assign(new Error("A resolução manual exige que a consulta fresca permaneça unknown."), { status: 409 });
}

export function isAmbiguousManualResolutionCandidate(attempt: { status: ErpOrderSyncStatus; syncErrors: unknown; erpResponse: unknown; lastStatusPayload: unknown }) {
  if (attempt.status !== ErpOrderSyncStatus.error) return false;
  const lastStatus = attempt.lastStatusPayload && typeof attempt.lastStatusPayload === "object" && !Array.isArray(attempt.lastStatusPayload)
    ? attempt.lastStatusPayload as Record<string, unknown>
    : null;
  if (lastStatus?.outcome === "unknown") return true;
  return /(timeout|"status":504|ECONNRESET|network|unavailable|inacessível|fora do ar)/i.test(JSON.stringify(attempt.syncErrors ?? attempt.erpResponse ?? {}));
}

export async function resolveAmbiguousErpOrderManually(params: {
  opportunityId: string;
  erpOrderSyncId: string;
  actor: { id: string; role: Role };
  input: Parameters<typeof validateManualResolutionInput>[0];
}) {
  if (params.actor.role !== Role.diretor) throw Object.assign(new Error("Somente diretor pode registrar verificação manual no ERP."), { status: 403 });

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ERP_ORDER_ADVISORY_LOCK_NAMESPACE}::integer, hashtext(${params.opportunityId})::integer)`;
    const attempt = await tx.erpOrderSync.findFirst({
      where: { id: params.erpOrderSyncId, opportunityId: params.opportunityId },
      include: {
        manualResolution: true,
        opportunity: { select: { id: true, clientId: true, ownerSellerId: true } },
        seller: { select: { erpLoginUsername: true, erpLoginPasswordEncrypted: true } },
      },
    });
    if (!attempt) throw Object.assign(new Error("Tentativa ERP não encontrada nesta oportunidade."), { status: 404 });
    const validated = validateManualResolutionInput(params.input, attempt.pedidoIdImportacao);
    if (attempt.manualResolution) return { resolution: attempt.manualResolution, idempotent: true };
    if (!isAmbiguousManualResolutionCandidate(attempt)) throw Object.assign(new Error("Somente tentativa com resultado unknown/timeout pode receber resolução manual."), { status: 409 });

    const correlationEvidence = await tx.timelineEvent.findFirst({
      where: {
        opportunityId: params.opportunityId,
        AND: [
          { description: { contains: validated.originalCorrelationId, mode: "insensitive" } },
          { description: { contains: attempt.pedidoIdImportacao, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });
    if (!correlationEvidence) throw Object.assign(new Error("correlationId não corresponde à auditoria da tentativa nesta oportunidade."), { status: 422 });

    const username = attempt.seller.erpLoginUsername?.trim();
    const encryptedPassword = attempt.seller.erpLoginPasswordEncrypted?.trim();
    if (!username || !encryptedPassword) throw Object.assign(new Error("Credencial UltraFV3 do vendedor indisponível para a consulta fresca obrigatória."), { status: 409 });
    const statusCheckCorrelationId = randomUUID();
    const statusResponse = await requestUltraFv3ReadOnlyWithCredentialsRetry<unknown>(
      `/orderStatus?pedido=${encodeURIComponent(attempt.pedidoIdImportacao)}`,
      { username, password: decryptErpCredential(encryptedPassword) },
      statusCheckCorrelationId,
    );
    const classification = classifyUltraFv3OrderLookup(statusResponse, attempt);
    const statusCheckedAt = new Date();
    assertFreshUnknownStatusCheck({ outcome: classification.outcome, checkedAt: statusCheckedAt });

    const resolution = await tx.erpOrderManualResolution.create({
      data: {
        erpOrderSyncId: attempt.id,
        opportunityId: attempt.opportunityId,
        resolvedById: params.actor.id,
        resolvedRole: Role.diretor,
        category: MANUAL_NOT_FOUND_CATEGORY,
        terminalState: MANUAL_RESOLUTION_TERMINAL_STATE,
        justification: validated.justification,
        originalPedidoIdImportacao: attempt.pedidoIdImportacao,
        originalCorrelationId: validated.originalCorrelationId,
        statusCheckedAt,
        statusCheckCorrelationId,
      },
    });
    await tx.timelineEvent.create({
      data: {
        type: "status",
        description: `Pedido ERP permaneceu unknown após consulta fresca e recebeu resolução manual autorizada (${MANUAL_RESOLUTION_TERMINAL_STATE}). Tentativa original preservada; pedidoIdImportacao=${attempt.pedidoIdImportacao}; correlationId=${validated.originalCorrelationId}.`,
        clientId: attempt.opportunity.clientId,
        opportunityId: attempt.opportunity.id,
        ownerSellerId: attempt.opportunity.ownerSellerId,
      },
    });
    return { resolution, idempotent: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
