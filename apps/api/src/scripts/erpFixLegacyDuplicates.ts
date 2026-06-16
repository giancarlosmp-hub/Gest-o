import { EventType, Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { normalizeCnpj, normalizeText } from "../utils/normalize.js";

const ARCHIVED_PREFIX = "[ARQUIVADO ERP DUP]";
const CLEANUP_REASON = "legacy_duplicate_cleanup";

type Candidate = {
  id: string;
  code: string | null;
  cnpj: string | null;
  cnpjNormalized: string | null;
  name: string;
  nameNormalized: string | null;
  city: string;
  cityNormalized: string | null;
  state: string;
  ownerSellerId: string;
  isArchived: boolean;
  archiveReason: string | null;
  erpUpdatedAt: Date | null;
  createdAt: Date;
  _count: {
    activities: number;
    opportunities: number;
    timelineEvents: number;
    contacts: number;
    agendaEvents: number;
    agendaStops: number;
  };
};

type CleanupSummary = {
  groupsFound: number;
  groupsChanged: number;
  conflictsFound: number;
  relationshipsMoved: number;
  duplicatesArchived: number;
  archivedFlagFixed: number;
  visibleAfterCleanup: Record<string, number>;
};

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

const normalizeCode = (value?: string | null) => String(value ?? "").trim().replace(/^0+(?=\d)/, "");
const isNeutralizedCode = (value?: string | null) => /__(LEGACY_DUP|MERGED)__/.test(String(value ?? ""));
const normalizeStrongCode = (value?: string | null) => (value && !isNeutralizedCode(value) ? normalizeCode(value) : "");
const normalizeValidDocument = (value?: string | null) => {
  const digits = normalizeCnpj(value);
  return (digits.length === 11 || digits.length === 14) && !/^(\d)\1+$/.test(digits) ? digits : "";
};
const isLegacyArchivedName = (name: string) => normalizeText(name).startsWith(normalizeText(ARCHIVED_PREFIX));
const stripLegacyPrefix = (name: string) => name.replace(/^\s*\[ARQUIVADO ERP DUP\]\s*/i, "").trim();
const identityNameKey = (client: Candidate) => [normalizeText(stripLegacyPrefix(client.name)), client.cityNormalized || normalizeText(client.city), client.state].join("|");

class DisjointSet {
  private parent = new Map<string, string>();

  add(id: string) {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    const current = this.parent.get(id) ?? id;
    if (current === id) return id;
    const root = this.find(current);
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string) {
    this.add(a);
    this.add(b);
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }

  groups() {
    const grouped = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      grouped.set(root, [...(grouped.get(root) ?? []), id]);
    }
    return [...grouped.values()];
  }
}

const choosePrimary = (clients: Candidate[]) =>
  [...clients].sort((a, b) => {
    const aVisible = !a.isArchived && !isLegacyArchivedName(a.name) ? 1 : 0;
    const bVisible = !b.isArchived && !isLegacyArchivedName(b.name) ? 1 : 0;
    if (aVisible !== bVisible) return bVisible - aVisible;
    const aNotLegacyName = isLegacyArchivedName(a.name) ? 0 : 1;
    const bNotLegacyName = isLegacyArchivedName(b.name) ? 0 : 1;
    if (aNotLegacyName !== bNotLegacyName) return bNotLegacyName - aNotLegacyName;
    if (a._count.activities !== b._count.activities) return b._count.activities - a._count.activities;
    if (a._count.opportunities !== b._count.opportunities) return b._count.opportunities - a._count.opportunities;
    const aRecent = (a.erpUpdatedAt ?? a.createdAt).getTime();
    const bRecent = (b.erpUpdatedAt ?? b.createdAt).getTime();
    return bRecent - aRecent;
  })[0];

async function moveRelationships(tx: Prisma.TransactionClient, duplicateId: string, primaryId: string) {
  const results = await Promise.all([
    tx.activity.updateMany({ where: { clientId: duplicateId }, data: { clientId: primaryId } }),
    tx.opportunity.updateMany({ where: { clientId: duplicateId }, data: { clientId: primaryId } }),
    tx.timelineEvent.updateMany({ where: { clientId: duplicateId }, data: { clientId: primaryId } }),
    tx.contact.updateMany({ where: { clientId: duplicateId }, data: { clientId: primaryId } }),
    tx.agendaEvent.updateMany({ where: { clientId: duplicateId }, data: { clientId: primaryId } }),
    tx.agendaStop.updateMany({ where: { clientId: duplicateId }, data: { clientId: primaryId } }),
  ]);
  return results.reduce((total, result) => total + result.count, 0);
}

const createCleanupAuditEvent = (
  tx: Prisma.TransactionClient,
  params: { clientId: string; ownerSellerId: string; description: string },
) =>
  tx.timelineEvent.create({
    data: {
      type: EventType.status,
      clientId: params.clientId,
      ownerSellerId: params.ownerSellerId,
      description: params.description,
    },
  });

async function loadCandidates() {
  const clients = await prisma.client.findMany({
    where: {
      OR: [
        { name: { startsWith: ARCHIVED_PREFIX, mode: "insensitive" } },
        { code: { not: null } },
        { cnpjNormalized: { not: null } },
        { cnpj: { not: null } },
      ],
    },
    select: {
      id: true,
      code: true,
      cnpj: true,
      cnpjNormalized: true,
      name: true,
      nameNormalized: true,
      city: true,
      cityNormalized: true,
      state: true,
      ownerSellerId: true,
      isArchived: true,
      archiveReason: true,
      erpUpdatedAt: true,
      createdAt: true,
      _count: { select: { activities: true, opportunities: true, timelineEvents: true, contacts: true, agendaEvents: true, agendaStops: true } },
    },
  });
  return clients;
}

function buildDuplicateGroups(clients: Candidate[]) {
  const dsu = new DisjointSet();
  const byCode = new Map<string, Candidate[]>();
  const byDocument = new Map<string, Candidate[]>();
  const byNameCityState = new Map<string, Candidate[]>();

  for (const client of clients) {
    dsu.add(client.id);
    const code = normalizeStrongCode(client.code);
    const doc = normalizeValidDocument(client.cnpjNormalized || client.cnpj);
    if (code) byCode.set(code, [...(byCode.get(code) ?? []), client]);
    if (doc) byDocument.set(doc, [...(byDocument.get(doc) ?? []), client]);
    byNameCityState.set(identityNameKey(client), [...(byNameCityState.get(identityNameKey(client)) ?? []), client]);
  }

  const legacyNameGroups = [...byNameCityState.values()].filter((group) => group.some((client) => isLegacyArchivedName(client.name)));
  for (const group of [...byCode.values(), ...byDocument.values(), ...legacyNameGroups]) {
    if (group.length < 2) continue;
    const [first, ...rest] = group;
    for (const item of rest) dsu.union(first.id, item.id);
  }

  const byId = new Map(clients.map((client) => [client.id, client]));
  return dsu.groups()
    .map((ids) => ids.map((id) => byId.get(id)).filter((client): client is Candidate => Boolean(client)))
    .filter((group) => group.length > 1 || group.some((client) => isLegacyArchivedName(client.name)));
}

async function visibleCountBySearchTerm(term: string) {
  return prisma.client.count({
    where: {
      isArchived: false,
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        { fantasyName: { contains: term, mode: "insensitive" } },
        { code: { contains: term, mode: "insensitive" } },
      ],
    },
  });
}

async function cleanupLegacyDuplicates(): Promise<CleanupSummary> {
  const candidates = await loadCandidates();
  const groups = buildDuplicateGroups(candidates);
  const summary: CleanupSummary = { groupsFound: groups.length, groupsChanged: 0, conflictsFound: 0, relationshipsMoved: 0, duplicatesArchived: 0, archivedFlagFixed: 0, visibleAfterCleanup: {} };
  const now = Date.now();

  for (const group of groups) {
    const primary = choosePrimary(group);
    const duplicates = group.filter((client) => client.id !== primary.id);
    const legacyFlagFixTargets = group.filter((client) => isLegacyArchivedName(client.name) && (!client.isArchived || client.archiveReason !== CLEANUP_REASON));
    const singleLegacyArchived = group.length === 1 && legacyFlagFixTargets.some((target) => target.id === primary.id);
    if (!primary || (!duplicates.length && !singleLegacyArchived && !legacyFlagFixTargets.length)) continue;
    const strongCodes = new Set(group.map((client) => normalizeStrongCode(client.code)).filter(Boolean));
    const validDocuments = new Set(group.map((client) => normalizeValidDocument(client.cnpjNormalized || client.cnpj)).filter(Boolean));
    summary.groupsChanged += 1;
    console.log(`[erp:fix-duplicates] Grupo com ${group.length} cliente(s). Principal=${primary.id} ${primary.name}`);

    if (legacyFlagFixTargets.length) {
      if (dryRun) {
        for (const target of legacyFlagFixTargets) console.log(`  [dry-run] Corrigiria flag arquivada ${target.id} ${target.name}`);
      } else {
        const result = await prisma.client.updateMany({
          where: { id: { in: legacyFlagFixTargets.map((target) => target.id) } },
          data: { isArchived: true, archiveReason: CLEANUP_REASON },
        });
        summary.archivedFlagFixed += result.count;
      }
    }

    if (strongCodes.size > 1 || validDocuments.size > 1) {
      summary.conflictsFound += 1;
      console.warn(`[erp:fix-duplicates] Conflito ignorado por múltiplas identidades fortes. Apenas flags legadas com prefixo foram corrigidas. codes=${[...strongCodes].join(",") || "-"} docs=${[...validDocuments].join(",") || "-"} ids=${group.map((client) => client.id).join(",")}`);
      continue;
    }

    if (dryRun) {
      for (const duplicate of duplicates) console.log(`  [dry-run] Arquivaria ${duplicate.id} ${duplicate.name}`);
      continue;
    }

    await prisma.$transaction(async (tx) => {
      if (!isLegacyArchivedName(primary.name)) {
        await tx.client.update({ where: { id: primary.id }, data: { isArchived: false, archiveReason: null } });
      }
      if (singleLegacyArchived) {
        await tx.client.update({
          where: { id: primary.id },
          data: { isArchived: true, archiveReason: CLEANUP_REASON },
        });
        await createCleanupAuditEvent(tx, {
          clientId: primary.id,
          ownerSellerId: primary.ownerSellerId,
          description: "Duplicado legado arquivado automaticamente pelo saneamento UltraFV3.",
        });
        summary.duplicatesArchived += 1;
        return;
      }
      for (const duplicate of duplicates) {
        summary.relationshipsMoved += await moveRelationships(tx, duplicate.id, primary.id);
        await createCleanupAuditEvent(tx, {
          clientId: primary.id,
          ownerSellerId: primary.ownerSellerId,
          description: `Cadastro legado duplicado ${duplicate.name} (${duplicate.code || duplicate.id}) fundido ao cliente principal pelo saneamento UltraFV3. Histórico, oportunidades, atividades e timeline foram preservados no cliente principal.`,
        });
        await tx.client.update({
          where: { id: duplicate.id },
          data: {
            isArchived: true,
            archiveReason: CLEANUP_REASON,
            code: duplicate.code ? `${duplicate.code}__LEGACY_DUP__${now}` : null,
            cnpjNormalized: null,
            cnpj: duplicate.cnpj ? `${duplicate.cnpj} [LEGACY DUP ${primary.id}]` : null,
            name: isLegacyArchivedName(duplicate.name) ? duplicate.name : `${ARCHIVED_PREFIX} ${duplicate.name}`,
            nameNormalized: normalizeText(`${ARCHIVED_PREFIX} ${stripLegacyPrefix(duplicate.name)}`),
          },
        });
        await createCleanupAuditEvent(tx, {
          clientId: primary.id,
          ownerSellerId: primary.ownerSellerId,
          description: `Duplicado legado arquivado automaticamente pelo saneamento UltraFV3: ${duplicate.name}.`,
        });
        summary.duplicatesArchived += 1;
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  summary.visibleAfterCleanup = {
    "LAIZE DE SOUZA AGROPECUARIA": dryRun ? -1 : await visibleCountBySearchTerm("LAIZE DE SOUZA AGROPECUARIA"),
    "3950": dryRun ? -1 : await visibleCountBySearchTerm("3950"),
    "EMPREENDIMENTOS EMR LTDA": dryRun ? -1 : await visibleCountBySearchTerm("EMPREENDIMENTOS EMR LTDA"),
    [ARCHIVED_PREFIX]: dryRun ? -1 : await visibleCountBySearchTerm(ARCHIVED_PREFIX),
  };
  return summary;
}

cleanupLegacyDuplicates()
  .then((summary) => {
    console.log(`[erp:fix-duplicates] Concluído${dryRun ? " (dry-run)" : ""}.`);
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    console.error("[erp:fix-duplicates] Falha no saneamento de duplicados legados", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
