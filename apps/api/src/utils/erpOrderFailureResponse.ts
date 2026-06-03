const SENSITIVE_TEXT_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+\/-]+|(authorization|token|password|senha|secret|credential|api[-_]?key)\s*[:=]\s*[^,;\s]+/gi;
const DOCUMENT_TEXT_PATTERN = /\b(\d{3})\d{6}(\d{2})\b|\b(\d{2})\d{12}(\d{2})\b/g;

export type ErpOrderFailureStage =
  | "ingress"
  | "body-parser"
  | "auth"
  | "rate-limit"
  | "handler"
  | "load-opportunity"
  | "validate-payload"
  | "resolve-salesman"
  | "submit-order"
  | "persist-timeline"
  | "timeout"
  | "serialize-response"
  | "express-error";

type ControlledErpOrderFailureInput = {
  correlationId?: string | null;
  status: number;
  etapa: ErpOrderFailureStage | string;
  message: unknown;
  details?: Record<string, unknown>;
};

export const isErpOrderEndpointPath = (method: string, path: string) =>
  method === "POST" && /^\/(?:api\/)?opportunities\/[^/]+\/erp\/orders\/?$/.test(path);

export const sanitizeErpOrderTechnicalMessage = (value: unknown) => {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : safeStringify(value);
  const trimmed = String(raw || "Falha controlada no envio ao ERP.").trim();
  return trimmed
    .replace(SENSITIVE_TEXT_PATTERN, (match, bearerPrefix, sensitiveKey) => {
      if (bearerPrefix) return `${bearerPrefix}***`;
      if (sensitiveKey) return `${sensitiveKey}=***`;
      return "***";
    })
    .replace(DOCUMENT_TEXT_PATTERN, (...args) => {
      const match = String(args[0] || "");
      if (match.length >= 14) return `${match.slice(0, 2)}***${match.slice(-2)}`;
      return `${match.slice(0, 3)}***${match.slice(-2)}`;
    });
};

export const buildControlledErpOrderFailurePayload = ({
  correlationId,
  status,
  etapa,
  message,
  details,
}: ControlledErpOrderFailureInput) => ({
  correlationId: correlationId || "unavailable",
  status,
  etapa,
  message: sanitizeErpOrderTechnicalMessage(message),
  mensagemTecnica: sanitizeErpOrderTechnicalMessage(message),
  ...(details ? sanitizeDetails(details) : {}),
});

export const safeJsonStringify = (payload: unknown) => safeStringify(payload);

const safeStringify = (value: unknown) => {
  if (typeof value === "string") return value;
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, nestedValue) => {
      if (typeof nestedValue === "bigint") return nestedValue.toString();
      if (nestedValue && typeof nestedValue === "object") {
        if (seen.has(nestedValue)) return "[Circular]";
        seen.add(nestedValue);
      }
      return nestedValue;
    });
  } catch {
    return String(value);
  }
};

const sanitizeDetails = (details: Record<string, unknown>) => {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
    if (/authorization|token|password|senha|secret|credential|api[-_]?key/i.test(key)) {
      sanitized[key] = "***";
    } else if (typeof value === "string") {
      sanitized[key] = sanitizeErpOrderTechnicalMessage(value);
    } else if (value && typeof value === "object") {
      sanitized[key] = JSON.parse(safeStringify(value));
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
};
