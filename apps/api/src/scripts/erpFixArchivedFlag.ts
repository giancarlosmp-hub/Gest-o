import { prisma } from "../config/prisma.js";

const ARCHIVED_PREFIX = "[ARQUIVADO ERP DUP]";
const CLEANUP_REASON = "legacy_duplicate_cleanup";

async function fixArchivedFlag() {
  const before = await prisma.client.count({
    where: {
      name: { startsWith: ARCHIVED_PREFIX, mode: "insensitive" },
      OR: [
        { isArchived: false },
        { archiveReason: null },
        { archiveReason: { not: CLEANUP_REASON } },
      ],
    },
  });

  const result = await prisma.client.updateMany({
    where: {
      name: { startsWith: ARCHIVED_PREFIX, mode: "insensitive" },
      OR: [
        { isArchived: false },
        { archiveReason: null },
        { archiveReason: { not: CLEANUP_REASON } },
      ],
    },
    data: {
      isArchived: true,
      archiveReason: CLEANUP_REASON,
    },
  });

  const remaining = await prisma.client.count({
    where: {
      name: { startsWith: ARCHIVED_PREFIX, mode: "insensitive" },
      OR: [
        { isArchived: false },
        { archiveReason: null },
        { archiveReason: { not: CLEANUP_REASON } },
      ],
    },
  });

  console.log(`[erp:fix-archived-flag] Registros elegíveis antes da correção: ${before}`);
  console.log(`[erp:fix-archived-flag] Registros corrigidos: ${result.count}`);
  console.log(`[erp:fix-archived-flag] Validação final pendente: ${remaining}`);
  if (remaining !== 0) {
    throw new Error("Ainda existem clientes com prefixo de arquivado sem isArchived=true/archiveReason correto.");
  }
}

fixArchivedFlag()
  .catch((error) => {
    console.error("[erp:fix-archived-flag] Falha ao corrigir flag de arquivamento", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
