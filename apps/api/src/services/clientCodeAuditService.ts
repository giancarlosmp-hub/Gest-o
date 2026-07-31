import type { Prisma } from "@prisma/client";

export const CLIENT_CODE_AUDIT_ORIGINS = [
  "UltraFV3 Partner Sync", "Importador", "API", "Interface Administrativa", "Script", "CLI", "Outro",
] as const;
export type ClientCodeAuditOrigin = typeof CLIENT_CODE_AUDIT_ORIGINS[number];

export type ClientCodeAuditContext = {
  origin: ClientCodeAuditOrigin;
  actorUserId?: string | null;
  actorEmail?: string | null;
  requestIp?: string | null;
  requestId: string;
  partnerErp?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export const normalizeAuditedCode = (value: unknown): string | null => {
  const normalized = String(value ?? "").trim();
  return normalized || null;
};

export const buildClientCodeAuditData = (params: ClientCodeAuditContext & {
  clientId: string;
  oldValue: unknown;
  newValue: unknown;
}) => {
  const oldValue = normalizeAuditedCode(params.oldValue);
  const newValue = normalizeAuditedCode(params.newValue);
  if (oldValue === newValue) return null;
  return {
    clientId: params.clientId,
    partnerErp: normalizeAuditedCode(params.partnerErp),
    oldValue,
    newValue,
    origin: params.origin,
    actorUserId: params.actorUserId ?? null,
    actorEmail: params.actorEmail ?? null,
    requestIp: params.requestIp ?? null,
    requestId: params.requestId,
    metadata: params.metadata,
  } satisfies Prisma.ClientCodeAuditUncheckedCreateInput;
};

export async function recordClientCodeChange(
  tx: Prisma.TransactionClient,
  params: ClientCodeAuditContext & { clientId: string; oldValue: unknown; newValue: unknown },
) {
  const data = buildClientCodeAuditData(params);
  return data ? tx.clientCodeAudit.create({ data }) : null;
}
