const SENSITIVE_ERP_LOG_KEY =
  /(token|password|authorization|senha|secret|credential|usuario|username|login|phone|telefone|fone|celular|email|e-mail|cnpj|cpf|cgc|document|endereco|address|logradouro|bairro|complement|razao|fantasia|nome|name|partner.?id|client.?id)/i;

/** Produces structural diagnostics without copying ERP personal data or secrets. */
export const sanitizeUltraFv3PayloadForLog = (value: unknown, depth = 0): unknown => {
  if (value === null || value === undefined) return value;
  if (depth > 3) return "[max-depth]";
  if (Array.isArray(value))
    return value.slice(0, 3).map((item) => sanitizeUltraFv3PayloadForLog(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 15)
        .map(([key, raw]) => [
          key,
          SENSITIVE_ERP_LOG_KEY.test(key)
            ? "***"
            : sanitizeUltraFv3PayloadForLog(raw, depth + 1),
        ]),
    );
  }
  if (typeof value === "string")
    return value.length > 160 ? `${value.slice(0, 160)}...` : value;
  return value;
};
