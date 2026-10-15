/** Aviso da rodada de status de pedidos: separa pedido não localizado no ERP de falha na chamada. */
export function formatOrderStatusSyncWarning(diagnostics?: Record<string, number>): string | null {
  const notFound = diagnostics?.orderStatusNotFound ?? 0;
  const callFailures = diagnostics?.orderStatusCallFailures ?? 0;
  const parts = [
    ...(notFound > 0 ? [`${notFound} pedido(s) não localizado(s) no ERP`] : []),
    ...(callFailures > 0 ? [`${callFailures} consulta(s) com falha na chamada ao ERP`] : []),
  ];
  if (!parts.length) return null;
  return `Status de pedidos: ${parts.join("; ")}. Tratado como aviso operacional.`;
}
