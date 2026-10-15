export const formatOrderDate = (value?: string | null) => {
  if (!value) return "Não informado";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Não informado"
    : new Intl.DateTimeFormat("pt-BR").format(parsed);
};

export const formatOrderQuantity = (value: number | null) =>
  value === null ? "Não informado" : String(value);

export const REJECTED_BY_ERP_LABEL = "Recusado pelo ERP";

// Tentativa recusada não é pedido: nunca exibe situação do ERP, mesmo que tenha sido gravada.
export const orderSituationLabel = (order: {
  syncStatus: string;
  statusGroup: string;
  operationalStatus: string | null;
}) => {
  if (order.syncStatus === "error") return REJECTED_BY_ERP_LABEL;
  if (order.statusGroup === "cancelled") return "CANCELADO";
  return order.operationalStatus || "NÃO INFORMADO";
};
