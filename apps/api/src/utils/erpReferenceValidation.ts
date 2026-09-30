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

  // 1. Check ATIVO (if present, must strictly equal "S")
  const ativoKeys = ["ATIVO", "ativo", "ACTIVE", "active", "IS_ACTIVE", "isActive"];
  const rawAtivo = readRecordField(record, ativoKeys);
  if (rawAtivo !== null) {
    const normAtivo = rawAtivo.toUpperCase();
    if (normAtivo !== "S") {
      return false;
    }
  }

  // 2. For paymentMethods, receivingConditions, and operations:
  // If LIBERAR_INTERNET field is present in the record, it must equal "S"
  const liberarInternetKeys = [
    "LIBERAR_INTERNET",
    "LIBERARINTERNET",
    "liberarInternet",
    "liberar_internet",
  ];
  const rawLiberarInternet = readRecordField(record, liberarInternetKeys);

  if (scope === "operations" || scope === "receivingConditions") {
    if (!rawLiberarInternet || rawLiberarInternet.toUpperCase() !== "S") {
      return false;
    }
  } else if (scope === "paymentMethods") {
    // If LIBERAR_INTERNET field is present on paymentMethods payload, enforce "S" (fail closed).
    // If absent on paymentMethods payload, enforce ATIVO = "S" (already checked above).
    if (rawLiberarInternet !== null && rawLiberarInternet.toUpperCase() !== "S") {
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
