import assert from "node:assert/strict";
import { classifyPortfolioStatus, isVisibleInRanking, rankingSellerName } from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";
import { loadLastSentCrmOrderByClient, portfolioStatusOf } from "./clientPortfolioStatus.js";

// Dados fictícios. "Agora" = 18/10/2026 09:00 em Brasília (12:00 UTC).
const now = new Date("2026-10-18T12:00:00.000Z");

// As 4 faixas.
assert.equal(classifyPortfolioStatus(new Date("2026-09-01T15:00:00.000Z"), null, now), "ativo");
assert.equal(classifyPortfolioStatus(new Date("2025-04-10T15:00:00.000Z"), null, now), "inativoRecente");
assert.equal(classifyPortfolioStatus(new Date("2023-01-10T15:00:00.000Z"), null, now), "exCliente");
assert.equal(classifyPortfolioStatus(null, null, now), "prospect");
assert.equal(classifyPortfolioStatus("data-invalida", undefined, now), "prospect", "data ilegível conta como sem compra");
assert.equal(classifyPortfolioStatus(new Date("2026-10-25T15:00:00.000Z"), null, now), "ativo", "data futura conta como ativo");

// Borda de 12 meses, no dia de Brasília: 18/10/2025 00:00 BRT ainda é ativo; 17/10/2025 23:59 BRT já não.
assert.equal(classifyPortfolioStatus(new Date("2025-10-18T03:00:00.000Z"), null, now), "ativo", "exatamente 12 meses");
assert.equal(classifyPortfolioStatus(new Date("2025-10-18T02:59:00.000Z"), null, now), "inativoRecente", "18/10 em UTC, mas 17/10 em Brasília");
// Borda de 24 meses: exatamente 24 meses ainda é inativo recente; um dia a mais é ex-cliente.
assert.equal(classifyPortfolioStatus(new Date("2024-10-18T03:00:00.000Z"), null, now), "inativoRecente", "exatamente 24 meses");
assert.equal(classifyPortfolioStatus(new Date("2024-10-18T02:59:00.000Z"), null, now), "exCliente", "24 meses e 1 dia em Brasília");
// "Agora" perto da meia-noite: 19/10 02:30 UTC ainda é 18/10 em Brasília.
assert.equal(classifyPortfolioStatus(new Date("2025-10-18T03:00:00.000Z"), null, new Date("2026-10-19T02:30:00.000Z")), "ativo");
assert.equal(classifyPortfolioStatus(new Date("2025-10-18T03:00:00.000Z"), null, new Date("2026-10-19T03:00:00.000Z")), "inativoRecente");
// 29/02: 12 meses antes vira 28/02.
assert.equal(classifyPortfolioStatus(new Date("2027-02-28T15:00:00.000Z"), null, new Date("2028-02-29T15:00:00.000Z")), "ativo");
assert.equal(classifyPortfolioStatus(new Date("2027-02-27T15:00:00.000Z"), null, new Date("2028-02-29T15:00:00.000Z")), "inativoRecente");

// Pedido enviado ao ERP mais recente que a data do ERP conta como compra; o mais antigo não muda nada.
assert.equal(classifyPortfolioStatus(new Date("2023-01-10T15:00:00.000Z"), new Date("2026-10-01T15:00:00.000Z"), now), "ativo");
assert.equal(classifyPortfolioStatus(null, new Date("2025-04-10T15:00:00.000Z"), now), "inativoRecente");
assert.equal(classifyPortfolioStatus(new Date("2026-09-01T15:00:00.000Z"), new Date("2023-01-10T15:00:00.000Z"), now), "ativo");

// Só pedido sent conta: pending e error ficam fora da consulta.
type OrderRow = { clientId: string; status: "pending" | "sent" | "error"; sentAt: Date | null; createdAt: Date };
const orders: OrderRow[] = [
  { clientId: "cliente-pedido-enviado", status: "sent", sentAt: new Date("2026-10-10T15:00:00.000Z"), createdAt: new Date("2026-10-10T14:00:00.000Z") },
  { clientId: "cliente-pedido-enviado", status: "sent", sentAt: new Date("2026-08-10T15:00:00.000Z"), createdAt: new Date("2026-08-10T14:00:00.000Z") },
  { clientId: "cliente-pedido-pendente", status: "pending", sentAt: null, createdAt: new Date("2026-10-15T14:00:00.000Z") },
  { clientId: "cliente-pedido-pendente", status: "error", sentAt: null, createdAt: new Date("2026-10-16T14:00:00.000Z") },
  { clientId: "cliente-sem-sentAt", status: "sent", sentAt: null, createdAt: new Date("2026-10-12T14:00:00.000Z") },
];
let capturedWhere: any = null;
(prisma as any).erpOrderSync.findMany = async ({ where }: any) => {
  capturedWhere = where;
  return orders
    .filter((order) => order.status === where.status)
    .map((order) => ({ sentAt: order.sentAt, createdAt: order.createdAt, opportunity: { clientId: order.clientId } }));
};

const lastSent = await loadLastSentCrmOrderByClient({ ownerSellerId: "vendedor-ficticio", isArchived: false });
assert.equal(capturedWhere.status, "sent");
assert.deepEqual(capturedWhere.opportunity, { client: { ownerSellerId: "vendedor-ficticio", isArchived: false } });
assert.equal(lastSent.get("cliente-pedido-enviado")?.toISOString(), "2026-10-10T15:00:00.000Z", "o mais recente dos enviados");
assert.equal(lastSent.has("cliente-pedido-pendente"), false, "pending/error não contam");
assert.equal(lastSent.get("cliente-sem-sentAt")?.toISOString(), "2026-10-12T14:00:00.000Z", "sem sentAt usa createdAt");

const erpExCliente = new Date("2023-01-10T15:00:00.000Z");
assert.equal(portfolioStatusOf({ id: "cliente-pedido-enviado", lastPurchaseDate: erpExCliente, financialProfile: null }, lastSent, now), "ativo");
assert.equal(portfolioStatusOf({ id: "cliente-pedido-pendente", lastPurchaseDate: erpExCliente, financialProfile: null }, lastSent, now), "exCliente");
// Fallback do perfil financeiro (DATA_ULTFATURA), como em commercialAutomationsService.
assert.equal(portfolioStatusOf({ id: "cliente-perfil", lastPurchaseDate: null, financialProfile: { DATA_ULTFATURA: "2025-06-01T03:00:00.000Z" } }, lastSent, now), "inativoRecente");
assert.equal(portfolioStatusOf({ id: "cliente-perfil", lastPurchaseDate: null, financialProfile: {} }, lastSent, now), "prospect");

// Rankings.
assert.equal(isVisibleInRanking(true, 0), true);
assert.equal(isVisibleInRanking(false, 0), false);
assert.equal(isVisibleInRanking(false, 10), true);
assert.equal(isVisibleInRanking(false, -5), false);
assert.equal(rankingSellerName("Vendedora Ficticia", true), "Vendedora Ficticia");
assert.equal(rankingSellerName("Vendedora Ficticia", false), "Vendedora Ficticia (desligado)");

await (prisma as any).$disconnect?.();
console.log("CLIENT_PORTFOLIO_STATUS=PASS bands=PASS borders_brasilia=PASS sent_order=PASS pending_error_ignored=PASS ranking_helpers=PASS");
