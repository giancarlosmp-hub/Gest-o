type Client = {
  id: string;
  code?: string | null;
  cnpjNormalized?: string | null;
  name: string;
  nameNormalized: string;
  city: string;
  cityNormalized: string;
  state: string;
  ownerSellerId: string;
  isArchived?: boolean;
  financialProfile?: Record<string, unknown> | null;
  partnerTitles?: Record<string, unknown>[] | null;
  overdueTitlesTotal?: number;
  opportunities: string[];
  opportunityOwners?: Record<string, string>;
  timelineEvents: string[];
  timelineOwners?: Record<string, string>;
};

type PartnerRow = {
  code?: string;
  cnpjNormalized?: string;
  name: string;
  city: string;
  state: string;
  ownerSellerId: string;
};

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

const findCandidates = (clients: Client[], row: PartnerRow) => {
  const byCode = row.code ? clients.filter((client) => client.code === row.code) : [];
  const byDocument = row.cnpjNormalized ? clients.filter((client) => client.cnpjNormalized === row.cnpjNormalized) : [];
  if (byCode.length || byDocument.length) return Array.from(new Map([...byCode, ...byDocument].map((item) => [item.id, item])).values());
  return clients.filter((client) => client.nameNormalized === normalize(row.name) && client.cityNormalized === normalize(row.city) && client.state === row.state);
};

const upsertPartner = (clients: Client[], row: PartnerRow) => {
  const candidates = findCandidates(clients, row);
  const primary = candidates.sort((a, b) => (b.opportunities.length + b.timelineEvents.length) - (a.opportunities.length + a.timelineEvents.length))[0];
  if (!primary) {
    clients.push({
      id: `c${clients.length + 1}`,
      code: row.code,
      cnpjNormalized: row.cnpjNormalized,
      name: row.name,
      nameNormalized: normalize(row.name),
      city: row.city,
      cityNormalized: normalize(row.city),
      state: row.state,
      ownerSellerId: row.ownerSellerId,
      isArchived: false,
      opportunities: [],
      opportunityOwners: {},
      timelineEvents: [],
      timelineOwners: {},
    });
    return { created: 1, updated: 0, merged: 0, sellerChanged: 0, cityCorrected: 0 };
  }
  const duplicates = candidates.filter((candidate) => candidate.id !== primary.id);
  for (const duplicate of duplicates) {
    primary.opportunities.push(...duplicate.opportunities);
    primary.timelineEvents.push(...duplicate.timelineEvents);
    primary.opportunityOwners = { ...(primary.opportunityOwners || {}), ...(duplicate.opportunityOwners || {}) };
    primary.timelineOwners = { ...(primary.timelineOwners || {}), ...(duplicate.timelineOwners || {}) };
    duplicate.code = `${duplicate.code || duplicate.id}__MERGED__TEST`;
    duplicate.cnpjNormalized = null;
    duplicate.isArchived = true;
  }
  const sellerChanged = primary.ownerSellerId !== row.ownerSellerId ? 1 : 0;
  const cityCorrected = normalize(primary.city) !== normalize(row.city) ? 1 : 0;
  Object.assign(primary, {
    code: row.code || primary.code,
    cnpjNormalized: row.cnpjNormalized || primary.cnpjNormalized,
    name: row.name,
    nameNormalized: normalize(row.name),
    city: row.city,
    cityNormalized: normalize(row.city),
    state: row.state,
    ownerSellerId: row.ownerSellerId,
    isArchived: false,
  });
  return { created: 0, updated: 1, merged: duplicates.length, sellerChanged, cityCorrected };
};

const clients: Client[] = [
  { id: "old-city", code: "2000", cnpjNormalized: "12345678901", name: "FERNANDO FREIRE CIOLA", nameNormalized: normalize("FERNANDO FREIRE CIOLA"), city: "Não informado", cityNormalized: normalize("Não informado"), state: "PR", ownerSellerId: "edirlei", opportunities: ["opp-1"], timelineEvents: [] },
  { id: "dup-code", code: "2000", cnpjNormalized: "12345678901", name: "FERNANDO FREIRE CIOLA", nameNormalized: normalize("FERNANDO FREIRE CIOLA"), city: "CHOPINZINHO", cityNormalized: normalize("CHOPINZINHO"), state: "PR", ownerSellerId: "edirlei", opportunities: [], timelineEvents: ["timeline-1"] },
  { id: "dup-doc", code: "9999", cnpjNormalized: "99887766000155", name: "CLIENTE DOC", nameNormalized: normalize("CLIENTE DOC"), city: "A", cityNormalized: normalize("A"), state: "PR", ownerSellerId: "seller-a", opportunities: [], timelineEvents: ["timeline-doc"] },
  { id: "joao", code: "5001", cnpjNormalized: null, name: "JOÃO DA SILVA", nameNormalized: normalize("JOÃO DA SILVA"), city: "C", cityNormalized: normalize("C"), state: "PR", ownerSellerId: "seller-a", opportunities: [], timelineEvents: [] },
  { id: "joao-filho", code: "5002", cnpjNormalized: null, name: "JOÃO DA SILVA FILHO", nameNormalized: normalize("JOÃO DA SILVA FILHO"), city: "C", cityNormalized: normalize("C"), state: "PR", ownerSellerId: "seller-b", opportunities: [], timelineEvents: [] },
];
clients[0].opportunityOwners = { "opp-1": "criador-original" };
clients[1].timelineOwners = { "timeline-1": "autor-timeline-original" };

const result = upsertPartner(clients, { code: "2000", cnpjNormalized: "12345678901", name: "FERNANDO FREIRE CIOLA", city: "CHOPINZINHO", state: "PR", ownerSellerId: "jeferson" });
const fernando = clients.find((client) => client.id === "old-city")!;
assert(result.updated === 1, "cliente existente por código ERP deveria ser atualizado");
assert(result.merged === 1, "duplicado por mesmo código ERP deveria ser consolidado");
assert(result.sellerChanged === 1 && fernando.ownerSellerId === "jeferson", "troca de vendedor deveria atualizar carteira");
assert(result.cityCorrected === 1 && fernando.city === "CHOPINZINHO", "cidade Não informado deveria ser corrigida");
assert(fernando.opportunities.includes("opp-1") && fernando.timelineEvents.includes("timeline-1"), "histórico deveria ser preservado na mesclagem por código ERP");
assert(fernando.opportunityOwners?.["opp-1"] === "criador-original" && fernando.timelineOwners?.["timeline-1"] === "autor-timeline-original", "troca de carteira não deve alterar autores históricos de oportunidade/timeline");
assert(clients.filter((client) => !client.isArchived && client.code === "2000").length === 1, "cliente com mesmo código ERP não deve duplicar quando muda vendedor");
assert(!clients.filter((client) => !client.isArchived).some((client) => client.name.startsWith("[ARQUIVADO ERP DUP]")), "duplicado arquivado não deve aparecer em pesquisa/lista normal");
assert(clients.filter((client) => client.ownerSellerId === "edirlei" && !client.isArchived).length === 0, "duplicado arquivado não deve bloquear manutenção do vendedor antigo");

const docResult = upsertPartner(clients, { code: "9999", cnpjNormalized: "99887766000155", name: "CLIENTE DOC", city: "A", state: "PR", ownerSellerId: "seller-b" });
const docClient = clients.find((client) => client.id === "dup-doc")!;
assert(docResult.updated === 1 && docClient.timelineEvents.includes("timeline-doc"), "duplicado por CNPJ deveria preservar linha do tempo");
assert(docClient.ownerSellerId === "seller-b", "cliente por CNPJ deveria trocar vendedor");
assert(findCandidates(clients, { name: "JOÃO DA SILVA", city: "C", state: "PR", ownerSellerId: "seller-x" }).length === 1, "nome+cidade+UF só deve unir correspondência exata e segura");
assert(findCandidates(clients, { name: "JOÃO DA SILVA FILHO", city: "C", state: "PR", ownerSellerId: "seller-x" }).length === 1, "nomes semelhantes sem documento válido não podem ser fundidos automaticamente");

const allSellerResults = [() => upsertPartner(clients, { code: "3000", cnpjNormalized: "3000", name: "OK", city: "X", state: "PR", ownerSellerId: "seller-ok" }), () => { throw new Error("falha Jeferson simulada"); }, () => upsertPartner(clients, { code: "4000", cnpjNormalized: "4000", name: "OK2", city: "Y", state: "PR", ownerSellerId: "seller-ok2" })];
let success = 0;
let errors = 0;
for (const run of allSellerResults) {
  try {
    run();
    success += 1;
  } catch {
    errors += 1;
  }
}
assert(success === 2 && errors === 1, "sync de todos vendedores deve continuar após falha isolada");
assert(clients.some((client) => client.code === "4000"), "vendedor após falha isolada deveria continuar sincronizando");

const financialClient = clients.find((client) => client.code === "4000")!;
financialClient.financialProfile = { VALOR_MEDIO: 5499.9, DATA_ULTFATURA: "2019-03-09T03:00:00.000Z", DIAS_MEDIAATRASO: 4 };
financialClient.partnerTitles = [{ DOCTO: 9766, DATA_VENCIMENTO: "2026-05-13T03:00:00.000Z", SALDO_CAPITAL: 2400 }];
financialClient.overdueTitlesTotal = 2400;
assert(financialClient.financialProfile.VALOR_MEDIO === 5499.9, "financialProfiles deve sincronizar e ficar disponível para Cliente 360");
assert(financialClient.partnerTitles.length === 1, "partnerTitles deve sincronizar e ficar disponível para Cliente 360");
assert((financialClient.overdueTitlesTotal ?? 0) > 0, "cliente com título vencido deve disparar alerta financeiro na Nova Oportunidade");

const legacyArchivedClient = {
  id: "legacy-archived-flag",
  code: "7000",
  cnpjNormalized: "7000",
  name: "[ARQUIVADO ERP DUP] CLIENTE LEGADO",
  nameNormalized: normalize("[ARQUIVADO ERP DUP] CLIENTE LEGADO"),
  city: "C",
  cityNormalized: normalize("C"),
  state: "PR",
  ownerSellerId: "old-seller",
  isArchived: false,
  opportunities: [],
  timelineEvents: [],
};
clients.push(legacyArchivedClient);
const fixLegacyArchivedFlags = (items: Client[]) => {
  let fixed = 0;
  for (const client of items) {
    if (client.name.startsWith("[ARQUIVADO ERP DUP]") && client.isArchived === false) {
      client.isArchived = true;
      fixed += 1;
    }
  }
  return fixed;
};
const visibleClientSearch = (items: Client[], term: string) => items.filter((client) => !client.isArchived && client.name.includes(term));
const sellerWallet = (items: Client[], sellerId: string) => items.filter((client) => client.ownerSellerId === sellerId && !client.isArchived);
const userDeletionBlockedByClients = (items: Client[], sellerId: string) => items.some((client) => client.ownerSellerId === sellerId && !client.isArchived);
assert(fixLegacyArchivedFlags(clients) === 1, "rotina complementar deve corrigir cliente legado com prefixo e isArchived=false");
assert(legacyArchivedClient.isArchived === true, "cliente legado com prefixo deve ficar isArchived=true");
assert(visibleClientSearch(clients, "CLIENTE LEGADO").length === 0, "cliente legado arquivado deve desaparecer das buscas");
assert(sellerWallet(clients, "old-seller").length === 0, "cliente legado arquivado deve desaparecer da carteira");
assert(!userDeletionBlockedByClients(clients, "old-seller"), "cliente legado arquivado não deve bloquear exclusão de usuário");

const findSyncCandidatesIgnoringLegacyArchivedNames = (items: Client[], row: PartnerRow) =>
  findCandidates(items, row).filter((client) => !client.name.startsWith("[ARQUIVADO ERP DUP]"));
const legacyOnlyCandidate = {
  id: "legacy-only-sync",
  code: "8000",
  cnpjNormalized: "8000",
  name: "[ARQUIVADO ERP DUP] CLIENTE SOMENTE ARQUIVADO",
  nameNormalized: normalize("[ARQUIVADO ERP DUP] CLIENTE SOMENTE ARQUIVADO"),
  city: "C",
  cityNormalized: normalize("C"),
  state: "PR",
  ownerSellerId: "old-seller",
  isArchived: true,
  opportunities: [],
  timelineEvents: [],
};
clients.push(legacyOnlyCandidate);
assert(
  findSyncCandidatesIgnoringLegacyArchivedNames(clients, { code: "8000", cnpjNormalized: "8000", name: "CLIENTE SOMENTE ARQUIVADO", city: "C", state: "PR", ownerSellerId: "new-seller" }).length === 0,
  "sync UltraFV3 não deve reativar cadastro com prefixo [ARQUIVADO ERP DUP] por engano"
);

console.log("UltraFV3 partner dedup rules smoke passed");
