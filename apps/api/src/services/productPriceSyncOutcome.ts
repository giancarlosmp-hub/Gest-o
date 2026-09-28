export type ProductPriceSyncOutcome = {
  received: number;
  productFoundRows: number;
  matchedProducts: number;
  explicitZeroRows: number;
  invalidPrice: number;
  missingProduct: number;
  persistedPriceRows: number;
  rejectedRows: number;
  updatedPrices: number;
  createdPrices: number;
};

export const assertUsefulProductPriceSync = (diagnostics: ProductPriceSyncOutcome) => {
  if (diagnostics.received > 0 && diagnostics.productFoundRows === 0) {
    throw Object.assign(
      new Error(`ERP retornou ${diagnostics.received} preços, mas nenhum produto foi encontrado; atualização comercial não concluída.`),
      { status: 422 },
    );
  }
  if (diagnostics.rejectedRows > 0) {
    throw Object.assign(
      new Error(`ERP retornou ${diagnostics.received} linhas: ${diagnostics.productFoundRows} com produto encontrado, ${diagnostics.missingProduct} sem produto e ${diagnostics.invalidPrice} com preço inválido; ${diagnostics.rejectedRows} rejeitadas após possíveis gravações parciais.`),
      { status: 422 },
    );
  }
  return diagnostics.persistedPriceRows;
};

export const opportunityProductRefreshFailureMessage = (stockProcessed: number, priceError: string) =>
  `Estoque processado (${stockProcessed}); atualização de preços falhou após possíveis gravações parciais: ${priceError}`;

export const runProductAndPriceRefresh = async <P extends { syncedCount: number }, R>(
  runProducts: () => Promise<P>,
  runPrices: () => Promise<R>,
) => {
  const products = await runProducts();
  try {
    const prices = await runPrices();
    return { products, prices };
  } catch (error) {
    throw Object.assign(new Error(opportunityProductRefreshFailureMessage(
      products.syncedCount,
      error instanceof Error ? error.message : String(error),
    )), { cause: error, products });
  }
};
