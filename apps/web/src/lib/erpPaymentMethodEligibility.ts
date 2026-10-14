// A API só lista formas de pagamento liberadas (LIBERAR_INTERNET = "S" e ATIVO = "S").
// Forma já selecionada que não está na lista não está liberada: a tela bloqueia o envio.
export const getPaymentMethodNotAllowedReason = (
  paymentMethodCode: string,
  allowedOptions: Array<{ code: string; value: string }>,
): string | null => {
  const code = paymentMethodCode.trim();
  if (!code) return null;
  if (allowedOptions.some((option) => option.code === code || option.value === code)) return null;
  return `Pedido ERP indisponível: a forma de pagamento ${code} não está liberada para uso no CRM (LIBERAR_INTERNET=S e ATIVO=S). Selecione outra forma de pagamento.`;
};
