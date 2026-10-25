import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

// Territórios comerciais: cidades sem tenantId aparecem na configuração (um único tenant ativo), a importação KML
// nunca falha por duplicidade, nomes repetidos entre UFs e transferência de vendedor inativo. Dados fictícios;
// Prisma simulado em memória com o índice único (sellerId, state, city) do banco.
type Row = Record<string, any>;

const TENANT = "tenant-ficticio";
const tenants: Row[] = [{ id: TENANT, status: "active" }];
const users: Row[] = [
  { id: "diretor-ficticio", role: "diretor", name: "Diretor Ficticio", region: null, isActive: true },
  { id: "vendedor-a", role: "vendedor", name: "Vendedor Ficticio A", region: null, isActive: true },
  { id: "vendedor-destino", role: "vendedor", name: "Vendedor Ficticio Destino", region: null, isActive: true },
  { id: "vendedor-terceiro", role: "vendedor", name: "Vendedor Ficticio Terceiro", region: null, isActive: true },
  { id: "vendedor-desligado", role: "vendedor", name: "Vendedor Ficticio Desligado", region: null, isActive: false }
];
const memberships: Row[] = users.filter((user) => user.isActive).map((user) => ({ userId: user.id, tenantId: TENANT, status: "active" }));

let sequence = 0;
const city = (sellerId: string, name: string, state: string, ibgeCode: string, tenantId: string | null = null): Row =>
  ({ id: `cidade-${++sequence}`, sellerId, city: name, state, ibgeCode, tenantId, createdAt: new Date("2026-10-01T12:00:00.000Z"), updatedAt: new Date("2026-10-01T12:00:00.000Z") });
const cities: Row[] = [
  // Vendedor A: gravadas pelas rotas antigas, sem tenant.
  city("vendedor-a", "Cascavel", "PR", "4104808"),
  city("vendedor-a", "Toledo", "PR", "4127700"),
  city("vendedor-a", "Joinville", "SC", "4209102"),
  // Destino: já tem duas cidades, com tenant.
  city("vendedor-destino", "Palotina", "PR", "4117909", TENANT),
  city("vendedor-destino", "Amambai", "MS", "5000609", TENANT),
  // Terceiro ativo.
  city("vendedor-terceiro", "Medianeira", "PR", "4115804", TENANT),
  // Desligado: duas que o destino já tem, uma livre e uma do terceiro; todas sem tenant.
  city("vendedor-desligado", "Palotina", "PR", "4117909"),
  city("vendedor-desligado", "Amambai", "MS", "5000609"),
  city("vendedor-desligado", "Guaíra", "PR", "4108809"),
  city("vendedor-desligado", "Medianeira", "PR", "4115804")
];
const timeline: Row[] = [];
const userOf = (id: string) => users.find((user) => user.id === id) ?? null;

const matchValue = (value: unknown, condition: any): boolean => {
  if (condition === null) return value === null || value === undefined;
  if (typeof condition !== "object") return value === condition;
  if ("in" in condition) return condition.in.includes(value);
  if ("notIn" in condition) return !condition.notIn.includes(value);
  if ("not" in condition) return value !== condition.not;
  if ("contains" in condition) return typeof value === "string" && value.toLowerCase().includes(String(condition.contains).toLowerCase());
  if ("equals" in condition) return condition.mode === "insensitive" ? String(value).toLowerCase() === String(condition.equals).toLowerCase() : value === condition.equals;
  throw new Error(`condição não suportada no teste: ${JSON.stringify(condition)}`);
};
const matchCity = (row: Row, where: Row = {}): boolean => Object.entries(where).every(([key, condition]) => {
  if (condition === undefined) return true;
  if (key === "AND") return ([] as Row[]).concat(condition).every((part) => matchCity(row, part));
  if (key === "OR") return (condition as Row[]).some((part) => matchCity(row, part));
  if (key === "seller") return matchUser(userOf(row.sellerId)!, condition);
  return matchValue(row[key], condition);
});
const matchUser = (user: Row, where: Row = {}): boolean => Object.entries(where).every(([key, condition]) => {
  if (condition === undefined) return true;
  if (key === "OR") return (condition as Row[]).some((part) => matchUser(user, part));
  if (key === "tenantMemberships") {
    const own = memberships.filter((membership) => membership.userId === user.id);
    if (condition.none) return !own.some((membership) => Object.entries(condition.none).every(([field, value]) => membership[field] === value));
    return own.some((membership) => Object.entries(condition.some).every(([field, value]) => membership[field] === value));
  }
  if (key === "territoryCities") return cities.some((row) => row.sellerId === user.id && matchCity(row, condition.some));
  return matchValue(user[key], condition);
});
const project = (row: Row, select?: Row): Row => {
  if (!select) return { ...row };
  return Object.fromEntries(Object.entries(select).map(([key, value]) => {
    if (key === "seller") return [key, project(userOf(row.sellerId)!, (value as Row).select)];
    return [key, row[key]];
  }));
};
const sortCities = (rows: Row[], orderBy: any) => {
  const orders = ([] as Row[]).concat(orderBy ?? []);
  return [...rows].sort((a, b) => {
    for (const order of orders) {
      const [field, direction] = Object.entries(order)[0] as [string, string];
      const compared = String(a[field]).localeCompare(String(b[field]), "pt-BR") * (direction === "desc" ? -1 : 1);
      if (compared) return compared;
    }
    return 0;
  });
};
const uniqueViolation = (data: Row) => cities.some((row) => row.sellerId === data.sellerId && row.state === data.state && row.city === data.city && row.id !== data.id);
const p2002 = () => Object.assign(new Error("Unique constraint failed on the fields: (`sellerId`,`state`,`city`)"), { code: "P2002" });

const territoryModel = {
  findMany: async ({ where, select, orderBy }: any = {}) => sortCities(cities.filter((row) => matchCity(row, where)), orderBy).map((row) => project(row, select)),
  findFirst: async ({ where, select }: any = {}) => { const row = cities.find((candidate) => matchCity(candidate, where)); return row ? project(row, select) : null; },
  findUnique: async ({ where }: any) => cities.find((row) => row.id === where.id) ?? null,
  count: async ({ where }: any = {}) => cities.filter((row) => matchCity(row, where)).length,
  create: async ({ data }: any) => {
    if (uniqueViolation(data)) throw p2002();
    const row = { ...city(data.sellerId, data.city, data.state, data.ibgeCode, data.tenantId ?? null) };
    cities.push(row);
    return row;
  },
  createMany: async ({ data, skipDuplicates }: any) => {
    let count = 0;
    for (const item of data) {
      if (uniqueViolation(item)) { if (skipDuplicates) continue; throw p2002(); }
      cities.push(city(item.sellerId, item.city, item.state, item.ibgeCode, item.tenantId ?? null));
      count += 1;
    }
    return { count };
  },
  update: async ({ where, data }: any) => {
    const row = cities.find((candidate) => candidate.id === where.id)!;
    const next = { ...row, ...data };
    if (uniqueViolation(next)) throw p2002();
    Object.assign(row, data, { updatedAt: new Date() });
    return row;
  },
  updateMany: async ({ where, data }: any) => {
    const rows = cities.filter((row) => matchCity(row, where));
    for (const row of rows) { if (uniqueViolation({ ...row, ...data })) throw p2002(); Object.assign(row, data, { updatedAt: new Date() }); }
    return { count: rows.length };
  },
  deleteMany: async ({ where }: any) => {
    const removed = cities.filter((row) => matchCity(row, where));
    for (const row of removed) cities.splice(cities.indexOf(row), 1);
    return { count: removed.length };
  },
  delete: async ({ where }: any) => { const row = cities.find((candidate) => candidate.id === where.id)!; cities.splice(cities.indexOf(row), 1); return row; }
};

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
setModel("sellerTerritoryCity", territoryModel);
setModel("user", {
  findFirst: async ({ where, select }: any) => {
    const user = users.find((row) => matchUser(row, where));
    if (!user) return null;
    return select ? Object.fromEntries(Object.keys(select).map((key) => [key, key === "email" ? `${user.id}@test.invalid` : user[key]])) : user;
  },
  findUnique: async ({ where }: any) => userOf(where.id),
  findMany: async ({ where, select }: any) => users.filter((user) => matchUser(user, where)).sort((a, b) => a.name.localeCompare(b.name)).map((user) => ({
    ...Object.fromEntries(Object.keys(select).filter((key) => key !== "_count").map((key) => [key, user[key]])),
    ...(select._count ? { _count: { territoryCities: cities.filter((row) => row.sellerId === user.id && matchCity(row, select._count.select.territoryCities.where)).length } } : {})
  }))
});
setModel("tenant", { findMany: async ({ where, take }: any) => tenants.filter((tenant) => tenant.status === where.status).slice(0, take).map((tenant) => ({ id: tenant.id })) });
setModel("tenantMembership", {
  findMany: async ({ where }: any) => memberships.filter((membership) => membership.userId === where.userId && membership.status === "active").map((membership) => ({ tenantId: membership.tenantId })),
  findFirst: async ({ where }: any) => memberships.find((membership) => membership.userId === where.userId && membership.tenantId === where.tenantId && membership.status === where.status) ? { id: "membership-ficticio" } : null,
  createMany: async () => ({ count: 0 })
});
setModel("timelineEvent", { create: async ({ data }: any) => { timeline.push(data); return data; } });
// Transação simulada: em erro, desfaz as cidades e a timeline.
(prisma as any).$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
  const snapshot = cities.map((row) => ({ ...row }));
  const timelineLength = timeline.length;
  try {
    return await fn(prisma);
  } catch (error) {
    cities.splice(0, cities.length, ...snapshot);
    timeline.splice(timelineLength);
    throw error;
  }
};
(prisma as any).$executeRaw = async () => 0;

const originalInfo = console.info;
console.info = () => undefined;
const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const token = signAccessToken({ id: "diretor-ficticio", email: "diretor-ficticio@test.invalid", role: "diretor" });
const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
};
const kmlPreview = async (sellerId: string, fileName: string, placemarks: string[]) => {
  const kml = `<?xml version="1.0" encoding="UTF-8"?><kml><Document>${placemarks.map((name) => `<Placemark><name>${name}</name></Placemark>`).join("")}</Document></kml>`;
  const form = new FormData();
  form.append("sellerId", sellerId);
  form.append("file", new Blob([kml], { type: "application/vnd.google-earth.kml+xml" }), fileName);
  const response = await fetch(`${baseUrl}/territories/config/import-kml-preview`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: response.status, json: (await response.json()) as any };
};
const citiesOf = (sellerId: string) => cities.filter((row) => row.sellerId === sellerId).map((row) => `${row.city}/${row.state}`).sort();

try {
  const routes = readFileSync(new URL("./crudRoutes.ts", import.meta.url), "utf8");
  assert.doesNotMatch(routes, /ibgeCode: city\.ibgeCode \|\| undefined/, "sem filtro OR com undefined (casaria qualquer linha)");
  assert.doesNotMatch(routes, /cdn\.jsdelivr|geodata-br/, "catálogo não depende de rede");

  // 1. Configuração enxerga as cidades sem tenant quando há um único tenant ativo.
  {
    const sellers = await call("GET", "/territories/config/sellers");
    assert.equal(sellers.status, 200);
    const byId = Object.fromEntries(sellers.json.map((seller: Row) => [seller.id, seller]));
    assert.equal(byId["vendedor-a"].territoryCount, 3, "cidades sem tenant contam");
    assert.equal(byId["vendedor-desligado"].territoryCount, 4, "desligado aparece como origem com as cidades sem tenant");
    const list = await call("GET", "/territories/config/cities?sellerId=vendedor-a");
    assert.deepEqual(list.json.map((row: Row) => `${row.city}/${row.state}`), ["Cascavel/PR", "Toledo/PR", "Joinville/SC"]);
    const links = await call("GET", "/territories/config/city-links");
    assert.equal(links.json.length, cities.length);
  }

  // 2. Com mais de um tenant ativo, só o tenantId exato vale (nada sem tenant é lido).
  {
    tenants.push({ id: "tenant-ficticio-2", status: "active" });
    const list = await call("GET", "/territories/config/cities?sellerId=vendedor-a");
    assert.deepEqual(list.json, []);
    const sellers = await call("GET", "/territories/config/sellers");
    assert.equal(sellers.json.find((seller: Row) => seller.id === "vendedor-destino").territoryCount, 2);
    assert.equal(sellers.json.some((seller: Row) => seller.id === "vendedor-desligado"), false);
    tenants.pop();
  }

  // 3. Prévia KML: nome do arquivo com acento, já vinculadas reconhecidas, município recente, ambíguo pela maioria.
  {
    const preview = await kmlPreview("vendedor-a", "Região Fictícia.kml", ["Cascavel", "TOLEDO", "Pescaria Brava", "Irati", "Palmeira - SC", "Corbélia", "Cidade Inexistente Ficticia"]);
    assert.equal(preview.status, 200);
    assert.equal(preview.json.fileName, "Região Fictícia.kml");
    const statusOf = (name: string) => preview.json.items.find((item: Row) => item.sourceName === name);
    assert.equal(statusOf("Cascavel").status, "already_seller");
    assert.equal(statusOf("TOLEDO").status, "already_seller");
    assert.equal(statusOf("Pescaria Brava").status, "to_add");
    assert.deepEqual([statusOf("Irati").status, statusOf("Irati").state], ["to_add", "PR"], "maioria PR no arquivo");
    assert.deepEqual([statusOf("Palmeira - SC").status, statusOf("Palmeira - SC").state], ["to_add", "SC"], "UF escrita no marcador");
    assert.equal(statusOf("Cidade Inexistente Ficticia").status, "not_found");
    assert.equal(preview.json.summary.alreadySeller, 2);
    assert.equal(preview.json.summary.toAdd, 4);
    assert.equal(preview.json.summary.ambiguous, 0);
  }

  // 4. Empate de UF: fica "ambiguous" com candidatos classificados para escolha.
  {
    const preview = await kmlPreview("vendedor-a", "empate.kml", ["Irati", "Joinville", "Cascavel"]);
    const irati = preview.json.items.find((item: Row) => item.sourceName === "Irati");
    assert.equal(irati.status, "ambiguous");
    assert.match(irati.message, /Ambígua \(PR\/SC\)/);
    assert.deepEqual(irati.candidates.map((candidate: Row) => `${candidate.state}:${candidate.status}`).sort(), ["PR:to_add", "SC:to_add"]);
    assert.equal(preview.json.summary.ambiguous, 1);
  }

  // 5. Confirmação nunca falha por duplicidade: já vinculadas são puladas, novas recebem tenantId.
  {
    const preview = await kmlPreview("vendedor-a", "Região Fictícia.kml", ["Cascavel", "Pescaria Brava", "Irati - PR"]);
    const confirm = await call("POST", "/territories/config/import-kml-confirm", {
      sellerId: "vendedor-a",
      // A cidade já vinculada vai junto de propósito: antes, isso causava o erro de índice único.
      cities: [...preview.json.citiesToAdd, { city: "Cascavel", state: "PR", ibgeCode: "4104808" }],
      transferableCityIds: preview.json.transferableCityIds,
      snapshotToken: preview.json.snapshotToken
    });
    assert.equal(confirm.status, 201, JSON.stringify(confirm.json));
    assert.deepEqual([confirm.json.created, confirm.json.alreadyLinked, confirm.json.transferred], [2, 1, 0]);
    assert.deepEqual(citiesOf("vendedor-a"), ["Cascavel/PR", "Irati/PR", "Joinville/SC", "Pescaria Brava/SC", "Toledo/PR"]);
    assert.ok(cities.filter((row) => row.sellerId === "vendedor-a" && ["Irati", "Pescaria Brava"].includes(row.city)).every((row) => row.tenantId === TENANT));
    assert.equal(confirm.json.cities.length, 5, "resposta lista todas, inclusive as sem tenant");
  }

  // 6. Cadastro manual passa a gravar o tenantId.
  {
    const created = await call("POST", "/territories/config/cities", { sellerId: "vendedor-a", city: "Balneário Rincão", state: "SC" });
    assert.equal(created.status, 201);
    assert.equal(cities.find((row) => row.id === created.json.id)!.tenantId, TENANT);
  }

  // 7. Transferência do desligado: já do destino sai da origem, terceiro ativo fica, a livre muda de dono.
  const desligadoIds = cities.filter((row) => row.sellerId === "vendedor-desligado").map((row) => row.id);
  const guairaId = cities.find((row) => row.sellerId === "vendedor-desligado" && row.city === "Guaíra")!.id;
  {
    const preview = await call("POST", "/territories/config/transfers/preview", { sourceSellerId: "vendedor-desligado", destinationSellerId: "vendedor-destino", cityIds: desligadoIds });
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    assert.deepEqual(preview.json.transferable.map((row: Row) => row.city), ["Guaíra"]);
    assert.deepEqual(preview.json.alreadyDestination.map((row: Row) => row.city).sort(), ["Amambai", "Palotina"]);
    assert.deepEqual(preview.json.conflicts.map((row: Row) => [row.city, row.sellerName]), [["Medianeira", "Vendedor Ficticio Terceiro"]]);

    // Algo muda depois da prévia (o terceiro solta a cidade): a confirmação recusa e nada é aplicado.
    const medianeira = cities.find((row) => row.sellerId === "vendedor-terceiro")!;
    cities.splice(cities.indexOf(medianeira), 1);
    const stale = await call("POST", "/territories/config/transfers/confirm", { sourceSellerId: "vendedor-desligado", destinationSellerId: "vendedor-destino", cityIds: preview.json.cityIds, snapshotToken: preview.json.snapshotToken });
    assert.equal(stale.status, 409);
    assert.equal(citiesOf("vendedor-desligado").length, 4, "nada aplicado");
    cities.push(medianeira);

    const fresh = await call("POST", "/territories/config/transfers/preview", { sourceSellerId: "vendedor-desligado", destinationSellerId: "vendedor-destino", cityIds: desligadoIds });
    const confirm = await call("POST", "/territories/config/transfers/confirm", { sourceSellerId: "vendedor-desligado", destinationSellerId: "vendedor-destino", cityIds: fresh.json.cityIds, snapshotToken: fresh.json.snapshotToken });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.json));
    assert.deepEqual([confirm.json.moved, confirm.json.removedAlreadyDestination, confirm.json.keptConflicts], [1, 2, 1]);
    assert.deepEqual(citiesOf("vendedor-desligado"), ["Medianeira/PR"], "origem fica só com o conflito");
    assert.deepEqual(citiesOf("vendedor-destino"), ["Amambai/MS", "Guaíra/PR", "Palotina/PR"]);
    const guaira = cities.find((row) => row.id === guairaId)!;
    assert.deepEqual([guaira.sellerId, guaira.tenantId], ["vendedor-destino", TENANT], "mesma linha, novo dono e tenant preenchido");
    assert.match(timeline.at(-1)!.description, /Auditoria de transferência territorial \[[^\]]+\]: 1 cidade\(s\) .*; 2 retirada\(s\) da origem por já serem do destino; 1 conflito\(s\) com terceiro ativo mantido\(s\) na origem; ator=diretor-ficticio\./);

    const again = await call("POST", "/territories/config/transfers/confirm", { sourceSellerId: "vendedor-desligado", destinationSellerId: "vendedor-destino", cityIds: fresh.json.cityIds, snapshotToken: fresh.json.snapshotToken });
    assert.equal(again.status, 409, "repetir a confirmação não aplica nada de novo");
  }

  // 8. Conflito sozinho não muda nada nem gera auditoria.
  {
    const timelineBefore = timeline.length;
    const medianeiraId = cities.find((row) => row.sellerId === "vendedor-desligado")!.id;
    const preview = await call("POST", "/territories/config/transfers/preview", { sourceSellerId: "vendedor-desligado", destinationSellerId: "vendedor-destino", cityIds: [medianeiraId] });
    const confirm = await call("POST", "/territories/config/transfers/confirm", { sourceSellerId: "vendedor-desligado", destinationSellerId: "vendedor-destino", cityIds: preview.json.cityIds, snapshotToken: preview.json.snapshotToken });
    assert.equal(confirm.status, 200);
    assert.deepEqual([confirm.json.moved, confirm.json.removedAlreadyDestination, confirm.json.keptConflicts, confirm.json.idempotent], [0, 0, 1, true]);
    assert.equal(timeline.length, timelineBefore);
  }

  console.log("TERRITORY_CONFIG=PASS unscoped_read=PASS multi_tenant_strict=PASS kml_preview=PASS ambiguous=PASS kml_confirm_no_duplicate=PASS manual_tenant=PASS transfer_rules=PASS transfer_stale=PASS");
} finally {
  console.info = originalInfo;
  server.close();
}
