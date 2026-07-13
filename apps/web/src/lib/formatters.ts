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
  // remove espaços que alguns browsers colocam no formato compact (ex.: "1,2 mil")
  return compactNumberFormatter
    .format(value ?? 0)
    .replace(/\s/g, "")
    .toLowerCase();
}

export function formatPercentBR(value: number, digits = 1) {
  return `${(value ?? 0).toFixed(digits).replace(".", ",")}%`;
}

export function formatDateBR(value: string | Date) {
  if (!value) return "-";
  if (typeof value === "string") {
    const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
    if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  }
  return new Intl.DateTimeFormat("pt-BR").format(new Date(value));
}
