import { prisma } from "../config/prisma.js";
import { normalizeCnpj, normalizeText } from "../utils/normalize.js";

const BATCH_SIZE = 500;

type ClientBatchItem = {
  id: string;
  cnpj: string | null;
  cnpjNormalized: string | null;
  name: string;
  nameNormalized: string | null;
  city: string | null;
  cityNormalized: string | null;
};

const shouldUpdateField = (current: string | null, next: string) => (current ?? "") !== next;

async function backfillClientNormalized() {
  let cursor: string | undefined;
  let processed = 0;
  let updated = 0;

  console.log(`[backfill] Iniciando backfill de campos normalizados (lote=${BATCH_SIZE})`);

  while (true) {
    const clients: ClientBatchItem[] = await prisma.client.findMany({
      select: {
        id: true,
        cnpj: true,
        cnpjNormalized: true,
        name: true,
        nameNormalized: true,
        city: true,
        cityNormalized: true
      },
      take: BATCH_SIZE,
      ...(cursor
        ? {
            skip: 1,
            cursor: { id: cursor }
          }
        : {}),
      orderBy: { id: "asc" }
    });

    if (!clients.length) {
      break;
    }

    for (const client of clients) {
      const nextCnpjNormalized = normalizeCnpj(client.cnpj);
      const nextNameNormalized = normalizeText(client.name);
      const nextCityNormalized = normalizeText(client.city);

      const updateData: {
        cnpjNormalized?: string;
        nameNormalized?: string;
        cityNormalized?: string;
      } = {};

      if (shouldUpdateField(client.cnpjNormalized, nextCnpjNormalized)) {
        updateData.cnpjNormalized = nextCnpjNormalized;
      }

      if (shouldUpdateField(client.nameNormalized, nextNameNormalized)) {
        updateData.nameNormalized = nextNameNormalized;
      }

      if (shouldUpdateField(client.cityNormalized, nextCityNormalized)) {
        updateData.cityNormalized = nextCityNormalized;
      }

      if (Object.keys(updateData).length > 0) {
        await prisma.client.update({
          where: { id: client.id },
          data: updateData
        });
        updated += 1;
      }

      processed += 1;
    }

    cursor = clients[clients.length - 1]?.id;
    console.log(`[backfill] Processados: ${processed} | Atualizados: ${updated}`);
  }

  console.log(`[backfill] Concluído. Total processados: ${processed} | Total atualizados: ${updated}`);
}

backfillClientNormalized()
  .catch((error) => {
    console.error("[backfill] Erro ao executar backfill de clientes", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
