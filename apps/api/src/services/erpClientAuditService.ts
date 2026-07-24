import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { normalizeCnpj, normalizeText } from "../utils/normalize.js";

const hashValue = (value: unknown) => {
  const text = String(value ?? "").trim();
  return text ? createHash("sha256").update(text).digest("hex").slice(0, 12) : null;
};

const normalizeCode = (value: unknown) => String(value ?? "").trim().replace(/^0+(?=\d)/, "");
const maskId = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`;

const legacyPrefixes = ["[ARQUIVADO ERP DUP]", "[RECUPERADO]", "[RESTAURADO]", "[RESTORE]", "[LEGADO]"];

type AuditOptions = { erpCode: unknown; ownerSellerId?: string | null; searchName?: string | null };

export async function auditErpClientReadOnly(options: AuditOptions) {
  const erpCode = normalizeCode(options.erpCode || "5050");
  if (!erpCode) throw new Error("Informe --erp-code para a auditoria.");

  const direct = await prisma.client.findMany({
    where: { OR: [{ code: erpCode }, { code: String(options.erpCode ?? "").trim() }] },
    include: { ownerSeller: { select: { id: true, name: true } }, _count: { select: { opportunities: true, activities: true, contacts: true, agendaEvents: true, agendaStops: true } } },
    orderBy: [{ isArchived: "asc" }, { erpUpdatedAt: "desc" }, { createdAt: "desc" }]
  });

  const docs = [...new Set(direct.map((c) => normalizeCnpj(c.cnpj)).filter(Boolean))];
  const names = [...new Set(direct.flatMap((c) => [c.nameNormalized || normalizeText(c.name), c.fantasyName ? normalizeText(c.fantasyName) : null]).filter(Boolean) as string[])];

  const related = await prisma.client.findMany({
    where: {
      OR: [
        { id: { in: direct.map((c) => c.id) } },
        ...(docs.length ? [{ cnpjNormalized: { in: docs } }, { cnpj: { in: docs } }] : []),
        ...(names.length ? [{ nameNormalized: { in: names } }] : []),
        { name: { startsWith: "[RECUPERADO]", mode: "insensitive" } },
        { name: { startsWith: "[ARQUIVADO ERP DUP]", mode: "insensitive" } },
      ]
    },
    include: { ownerSeller: { select: { id: true, name: true } }, _count: { select: { opportunities: true, activities: true, contacts: true, agendaEvents: true, agendaStops: true } } },
    orderBy: [{ isArchived: "asc" }, { erpUpdatedAt: "desc" }, { createdAt: "desc" }]
  });

  const byId = new Map([...direct, ...related].map((c) => [c.id, c]));
  const recordsRaw = [...byId.values()];
  const oppIds = (await prisma.opportunity.findMany({ where: { clientId: { in: recordsRaw.map((c) => c.id) } }, select: { id: true, clientId: true } }));
  const ordersByClient = new Map<string, number>();
  if (oppIds.length) {
    const grouped = await prisma.erpOrderSync.groupBy({ by: ["opportunityId"], where: { opportunityId: { in: oppIds.map((o) => o.id) } }, _count: { _all: true } });
    const oppClient = new Map(oppIds.map((o) => [o.id, o.clientId]));
    for (const row of grouped) ordersByClient.set(oppClient.get(row.opportunityId) || "", (ordersByClient.get(oppClient.get(row.opportunityId) || "") || 0) + row._count._all);
  }

  const lastRun = await prisma.erpSyncRun.findFirst({ where: { scope: "partners", sellerId: options.ownerSellerId || undefined }, orderBy: { startedAt: "desc" } });
  const active = recordsRaw.filter((c) => !c.isArchived);
  const archived = recordsRaw.filter((c) => c.isArchived);
  const lastUpdated = recordsRaw[0] ?? null;

  const records = recordsRaw.map((c) => {
    const visibleInClientsApi = !c.isArchived && (!options.ownerSellerId || c.ownerSellerId === options.ownerSellerId);
    const exclusionReason = c.isArchived ? "IS_ARCHIVED_FILTER" : options.ownerSellerId && c.ownerSellerId !== options.ownerSellerId ? "OWNER_FILTER" : null;
    const legacyPrefix = legacyPrefixes.find((prefix) => c.name.toUpperCase().startsWith(prefix.toUpperCase())) || null;
    return {
      clientId: maskId(c.id), clientIdHash: hashValue(c.id), erpCodeField: c.code ? (normalizeCode(c.code) === erpCode ? "code" : "code_legacy_or_different") : null,
      erpCode: c.code ? hashValue(c.code) : null, isArchived: c.isArchived, archiveReason: c.archiveReason || null,
      ownerUserId: maskId(c.ownerSellerId), ownerUserIdHash: hashValue(c.ownerSellerId), ownerNameSanitized: c.ownerSeller.name ? `${c.ownerSeller.name.slice(0, 2)}***` : null,
      createdAt: c.createdAt.toISOString(), updatedAt: (c.erpUpdatedAt ?? c.createdAt).toISOString(), lastErpSyncTimestamp: c.erpUpdatedAt?.toISOString() ?? null,
      recoveryOrigin: legacyPrefix, opportunitiesCount: c._count.opportunities, activitiesCount: c._count.activities + c._count.agendaEvents + c._count.agendaStops,
      ordersCount: ordersByClient.get(c.id) || 0, contactsCount: c._count.contacts, documentHash: hashValue(c.cnpjNormalized || normalizeCnpj(c.cnpj)),
      visibleInClientsApi, exclusionReason, wouldBePrimary: !c.isArchived && active[0]?.id === c.id
    };
  });

  return {
    mode: "READ_ONLY_SANITIZED", correlationId: randomUUID(), erpCode, recordsFound: records.length, activeCount: active.length, archivedCount: archived.length, records,
    syncEvidence: { lastUpdatedRecordId: lastUpdated ? maskId(lastUpdated.id) : null, lastUpdatedRecordIdHash: lastUpdated ? hashValue(lastUpdated.id) : null, ownerChanged: null, updatedAtChanged: null, lastPartnersRun: lastRun ? { id: maskId(lastRun.id), startedAt: lastRun.startedAt.toISOString(), finishedAt: lastRun.finishedAt?.toISOString() ?? null, syncedCount: lastRun.syncedCount, metrics: lastRun.metrics } : null },
    clientsApiAudit: { defaultExcludesArchived: true, searchFields: ["name", "fantasyName", "code", "cnpj", "city", "state", "region", "segment"], ownerFilterParams: ["ownerSellerId", "vendedorId"], visibleCountForOwner: records.filter((r) => r.visibleInClientsApi).length },
    answers: { multipleActive5050: active.filter((c) => normalizeCode(c.code) === erpCode).length > 1, legacyField5050Found: false, duplicatedDocument: docs.some((doc) => recordsRaw.filter((c) => normalizeCnpj(c.cnpj) === doc || c.cnpjNormalized === doc).length > 1), recoveredWithoutErpCodeSameClient: recordsRaw.some((c) => !c.code && legacyPrefixes.some((prefix) => c.name.toUpperCase().startsWith(prefix.toUpperCase()))) },
    diagnosis: records.length === 0 ? "Nenhum registro CRM relacionado encontrado por código ERP, documento/nome derivado ou prefixos de recuperação." : archived.length && !active.length ? "Registros relacionados existem, mas todos estão arquivados e são excluídos por GET /clients padrão." : active.length > 1 ? "Há ambiguidade ativa; não reparar automaticamente." : "Auditoria read-only concluída; reparar dados somente após validação humana do dry-run."
  };
}

export async function repairErpClientDryRun(options: AuditOptions & { apply?: boolean }) {
  const audit = await auditErpClientReadOnly(options);
  const actions: string[] = [];
  if (audit.activeCount > 1) actions.push("ABORT_AMBIGUOUS_ACTIVE_RECORDS");
  else if (audit.recordsFound === 0) actions.push("NO_MUTATION_NO_RECORD_FOUND_DO_NOT_CREATE_AUTOMATICALLY");
  else actions.push("NO_SAFE_REPAIR_PROVEN_BY_LOCAL_READ_ONLY_AUDIT");
  if (options.apply) throw new Error("--apply bloqueado nesta PR: apresente o dry-run e obtenha autorização explícita antes de mutações de produção.");
  return { mode: "DRY_RUN_ONLY", erpCode: audit.erpCode, wouldMutate: false, actions, before: audit, after: null, rollbackPlan: "Sem mutação executada; rollback não aplicável ao dry-run." };
}
