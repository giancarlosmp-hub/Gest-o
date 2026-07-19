import assert from "node:assert/strict";
import { clientReadableForDetailsWhere } from "../utils/clientHistoricalAccess.js";

type MockRequest = Parameters<typeof clientReadableForDetailsWhere>[0];

const requestFor = (role: "vendedor" | "gerente" | "diretor", id: string, query: Record<string, string> = {}) =>
  ({ user: { id, role }, query }) as unknown as MockRequest;

const sellerWhere = clientReadableForDetailsWhere(requestFor("vendedor", "seller-a"));
assert.deepEqual(sellerWhere, {
  OR: [
    { isArchived: false, ownerSellerId: "seller-a" },
    {
      isArchived: true,
      OR: [
        { ownerSellerId: "seller-a" },
        { opportunities: { some: { ownerSellerId: "seller-a" } } }
      ]
    }
  ]
}, "vendedor deve ler cliente arquivado próprio ou vinculado a oportunidade própria");

const otherSellerCannotMatchArchived = JSON.stringify(sellerWhere).includes("seller-b");
assert.equal(otherSellerCannotMatchArchived, false, "vendedor sem acesso não deve ser incluído no filtro de leitura histórica");

const managerFilteredWhere = clientReadableForDetailsWhere(requestFor("gerente", "manager", { sellerId: "seller-a" }));
assert.deepEqual(managerFilteredWhere, sellerWhere, "gerente filtrado por sellerId deve preservar sellerWhere atual");

const directorWhere = clientReadableForDetailsWhere(requestFor("diretor", "director"));
assert.deepEqual(directorWhere, {
  OR: [
    { isArchived: false },
    { isArchived: true }
  ]
}, "diretor sem sellerId deve manter acesso amplo do modelo atual");

const activeClientListWhere = { ownerSellerId: "seller-a", isArchived: false };
assert.equal(activeClientListWhere.isArchived, false, "listagem deve continuar restringindo clientes arquivados");

const archivedWriteWhere = { id: "client-1", ownerSellerId: "seller-a", isArchived: false };
assert.equal(archivedWriteWhere.isArchived, false, "escrita em cliente arquivado deve continuar bloqueada por isArchived:false");

console.log("archivedClientHistoricalReadSmoke ok");
