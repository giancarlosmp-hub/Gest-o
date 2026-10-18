import type { PortfolioStatus } from "@salesforce-pro/shared";

// Cores do selo da situação da carteira, iguais no detalhe e na lista de clientes.
export const portfolioStatusBadgeClass: Record<PortfolioStatus, string> = {
  ativo: "bg-emerald-50 text-emerald-800 ring-emerald-300",
  inativoRecente: "bg-amber-50 text-amber-800 ring-amber-300",
  exCliente: "bg-red-50 text-red-800 ring-red-300",
  prospect: "bg-slate-100 text-slate-700 ring-slate-300"
};
