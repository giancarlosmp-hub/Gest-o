export const formatOrderDate = (value?: string | null) => {
  if (!value) return "Não informado";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Não informado"
    : new Intl.DateTimeFormat("pt-BR").format(parsed);
};

export const formatOrderQuantity = (value: number | null) =>
  value === null ? "Não informado" : String(value);
