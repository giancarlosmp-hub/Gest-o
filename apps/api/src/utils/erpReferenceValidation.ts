export function readRecordField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) {
      const text = String(value).trim();
      if (text !== "") return text;
    }
  }
  return null;
}

export function isErpReferenceEligible(
  scope: string,
  record: Record<string, unknown>,
): boolean {
  if (!record || typeof record !== "object") return false;

  // 1. Check ATIVO (if present, must be active)
  const ativoKeys = ["ATIVO", "ativo", "ACTIVE", "active", "IS_ACTIVE", "isActive"];
  const rawAtivo = readRecordField(record, ativoKeys);
  if (rawAtivo !== null) {
    const normAtivo = rawAtivo.toUpperCase();
    if (["N", "0", "FALSE", "INATIVO"].includes(normAtivo)) {
      return false;
    }
  }

  // 2. For operations & receivingConditions, check LIBERAR_INTERNET (fail closed: must be "S")
  if (scope === "operations" || scope === "receivingConditions") {
    const liberarInternetKeys = [
      "LIBERAR_INTERNET",
      "LIBERARINTERNET",
      "liberarInternet",
      "liberar_internet",
    ];
    const rawLiberarInternet = readRecordField(record, liberarInternetKeys);
    if (!rawLiberarInternet || rawLiberarInternet.toUpperCase() !== "S") {
      return false;
    }
  }

  // 3. For operations, check VENDAS (must be "S" for commercial sales operations in CRM)
  if (scope === "operations") {
    const vendasKeys = ["VENDAS", "vendas", "IS_VENDAS", "isVendas"];
    const rawVendas = readRecordField(record, vendasKeys);
    if (!rawVendas || rawVendas.toUpperCase() !== "S") {
      return false;
    }
  }

  return true;
}
