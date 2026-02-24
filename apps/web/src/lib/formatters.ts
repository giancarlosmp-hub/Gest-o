const brlFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat("pt-BR");

const compactNumberFormatter = new Intl.NumberFormat("pt-BR", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1,
});

export function formatCurrencyBRL(value: number) {
  return brlFormatter.format(value ?? 0);
}

export function formatNumberBR(value: number) {
  return numberFormatter.format(value ?? 0);
}

export function formatCompactNumberBR(value: number) {
  return compactNumberFormatter.format(value ?? 0);
}

export function formatPercentBR(value: number, digits = 1) {
  return `${(value ?? 0).toFixed(digits).replace(".", ",")}%`;
}
