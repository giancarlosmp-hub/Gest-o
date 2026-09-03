export type ManualResolutionConfirmation = {
  checked: boolean;
  consequenceAccepted: boolean;
  importIdSuffix: string;
  justification: string;
  confirmationPhrase: string;
};

export const ERP_MANUAL_RESOLUTION_PHRASE =
  "CONFIRMEI QUE O PEDIDO NÃO EXISTE NO ERP";

export function canConfirmErpManualResolution(
  confirmation: ManualResolutionConfirmation,
) {
  return (
    confirmation.checked &&
    confirmation.consequenceAccepted &&
    confirmation.importIdSuffix.length === 8 &&
    confirmation.justification.trim().length >= 10 &&
    confirmation.confirmationPhrase === ERP_MANUAL_RESOLUTION_PHRASE
  );
}
