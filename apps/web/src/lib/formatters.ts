const ptBrNumberFormatter = new Intl.NumberFormat("pt-BR");

const ptBrCompactFormatter = new Intl.NumberFormat("pt-BR", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const ptBrCurrencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatCompactNumber(value: number) {
  return ptBrCompactFormatter.format(value).replace(/\s/g, "").toLowerCase();
}

export function formatNumber(value: number) {
  return ptBrNumberFormatter.format(value);
}

export function formatCurrency(value: number) {
  return ptBrCurrencyFormatter.format(value);
}

export function formatPercent(value: number) {
  return `${value.toFixed(1).replace('.', ',')}%`;
}
