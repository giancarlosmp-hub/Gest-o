export function orderStatusGroup(sync: string, operational: string | null, fulfillment: string | null) {
  if (sync === "error") return "error";
  if (sync === "pending") return "pending";
  const raw = (operational || "").toUpperCase();
  if (raw === "CANCELADO" || fulfillment === "cancelado") return "cancelled";
  if (raw === "FINALIZADO" || fulfillment === "entregue") return "finished";
  if (raw === "PARCIAL" || fulfillment === "parcial") return "partial";
  if (["DIGITADO", "ACEITO", "EXPEDINDO", "FATURAR", "SUSPENSO"].includes(raw)) return "processing";
  return "unknown";
}
