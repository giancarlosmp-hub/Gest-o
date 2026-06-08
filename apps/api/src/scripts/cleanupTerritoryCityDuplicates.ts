import { prisma } from "../config/prisma.js";
import { normalizeState } from "../utils/normalize.js";

const SAFE_DATABASE_MARKERS = ["preview", "dev", "local", "localhost", "127.0.0.1", "test"];

const OFFICIAL_CITY_FIXTURES = new Map([
  ["PR::cascavel", { city: "Cascavel", state: "PR", ibgeCode: "4104808" }],
  ["PR::toledo", { city: "Toledo", state: "PR", ibgeCode: "4127700" }]
]);

const normalizeCityKey = (city: string) => city
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/['’]/g, "")
  .replace(/[^a-zA-Z0-9]+/g, " ")
  .trim()
  .replace(/\s+/g, " ")
  .toLowerCase();

const buildKey = (state: string, city: string) => `${normalizeState(state)}::${normalizeCityKey(city)}`;

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const isSafeDatabase = SAFE_DATABASE_MARKERS.some((marker) => databaseUrl.toLowerCase().includes(marker));

  if (!isSafeDatabase) {
    throw new Error("DATABASE_URL não parece ser preview/dev/local/test. Limpeza de duplicidades de território abortada por segurança.");
  }

  const cities = await prisma.sellerTerritoryCity.findMany({
    orderBy: [{ sellerId: "asc" }, { state: "asc" }, { city: "asc" }]
  });
  const groups = new Map<string, typeof cities>();

  for (const city of cities) {
    const key = `${city.sellerId}::${buildKey(city.state, city.city)}`;
    groups.set(key, [...(groups.get(key) ?? []), city]);
  }

  let removed = 0;
  let normalized = 0;

  for (const [key, group] of groups.entries()) {
    const officialKey = key.split("::").slice(1).join("::");
    const officialCity = OFFICIAL_CITY_FIXTURES.get(officialKey);
    const keeper = group.find((city) => officialCity && city.city === officialCity.city && city.state === officialCity.state) ?? group[0];
    const duplicates = group.filter((city) => city.id !== keeper.id);

    if (duplicates.length > 0) {
      await prisma.sellerTerritoryCity.deleteMany({ where: { id: { in: duplicates.map((city) => city.id) } } });
      removed += duplicates.length;
    }

    if (officialCity && (keeper.city !== officialCity.city || keeper.state !== officialCity.state || keeper.ibgeCode !== officialCity.ibgeCode)) {
      await prisma.sellerTerritoryCity.update({
        where: { id: keeper.id },
        data: officialCity
      });
      normalized += 1;
    }
  }

  console.log(`[territory-cleanup] Duplicidades removidas: ${removed}. Cidades padronizadas: ${normalized}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
