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
  opportunities: string[];
  timelineEvents: string[];
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
      opportunities: [],
      timelineEvents: [],
    });
    return { created: 1, updated: 0, merged: 0, sellerChanged: 0, cityCorrected: 0 };
  }
  const duplicates = candidates.filter((candidate) => candidate.id !== primary.id);
  for (const duplicate of duplicates) {
    primary.opportunities.push(...duplicate.opportunities);
    primary.timelineEvents.push(...duplicate.timelineEvents);
    duplicate.code = `${duplicate.code || duplicate.id}__MERGED__TEST`;
    duplicate.cnpjNormalized = null;
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
  });
  return { created: 0, updated: 1, merged: duplicates.length, sellerChanged, cityCorrected };
};

const clients: Client[] = [
  { id: "old-city", code: "2000", cnpjNormalized: "12345678901", name: "FERNANDO FREIRE CIOLA", nameNormalized: normalize("FERNANDO FREIRE CIOLA"), city: "Não informado", cityNormalized: normalize("Não informado"), state: "PR", ownerSellerId: "edirlei", opportunities: ["opp-1"], timelineEvents: [] },
  { id: "dup-code", code: "2000", cnpjNormalized: "12345678901", name: "FERNANDO FREIRE CIOLA", nameNormalized: normalize("FERNANDO FREIRE CIOLA"), city: "CHOPINZINHO", cityNormalized: normalize("CHOPINZINHO"), state: "PR", ownerSellerId: "edirlei", opportunities: [], timelineEvents: ["timeline-1"] },
  { id: "dup-doc", code: "9999", cnpjNormalized: "99887766000155", name: "CLIENTE DOC", nameNormalized: normalize("CLIENTE DOC"), city: "A", cityNormalized: normalize("A"), state: "PR", ownerSellerId: "seller-a", opportunities: [], timelineEvents: ["timeline-doc"] },
];

const result = upsertPartner(clients, { code: "2000", cnpjNormalized: "12345678901", name: "FERNANDO FREIRE CIOLA", city: "CHOPINZINHO", state: "PR", ownerSellerId: "jeferson" });
const fernando = clients.find((client) => client.id === "old-city")!;
assert(result.updated === 1, "cliente existente por código ERP deveria ser atualizado");
assert(result.merged === 1, "duplicado por mesmo código ERP deveria ser consolidado");
assert(result.sellerChanged === 1 && fernando.ownerSellerId === "jeferson", "troca de vendedor deveria atualizar carteira");
assert(result.cityCorrected === 1 && fernando.city === "CHOPINZINHO", "cidade Não informado deveria ser corrigida");
assert(fernando.opportunities.includes("opp-1") && fernando.timelineEvents.includes("timeline-1"), "histórico deveria ser preservado na mesclagem por código ERP");

const docResult = upsertPartner(clients, { code: "9999", cnpjNormalized: "99887766000155", name: "CLIENTE DOC", city: "A", state: "PR", ownerSellerId: "seller-b" });
const docClient = clients.find((client) => client.id === "dup-doc")!;
assert(docResult.updated === 1 && docClient.timelineEvents.includes("timeline-doc"), "duplicado por CNPJ deveria preservar linha do tempo");
assert(docClient.ownerSellerId === "seller-b", "cliente por CNPJ deveria trocar vendedor");

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

console.log("UltraFV3 partner dedup rules smoke passed");
