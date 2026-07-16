import { randomBytes } from "crypto";

type LogLevel = "INFO" | "WARN" | "ERROR";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const SENSITIVE_KEY_PATTERN = /(password|senha|token|authorization|jwt|secret|api[-_]?key|refresh[-_]?token|cookie|credential|credencial)/i;
const PERSONAL_KEY_PATTERN = /(cpf|cnpj|documento|document|email|e-mail|telefone|phone|celular|endereco|address|cliente|razao|fantasia)/i;
const PERSON_NAME_KEY_PATTERN = /(^|_)(nome|name|vendedor|salesman|seller)(_|$)/i;

const maskName = (value: unknown) => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const firstToken = text.split(/\s+/)[0] ?? text;
  if (firstToken.length <= 3) return `${firstToken[0] ?? "*"}***`;
  return `${firstToken.slice(0, 3).toUpperCase()}***`;
};

const redactSensitiveText = (value: string) => value
  .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, "Bearer [REDACTED]")
  .replace(/("?(?:authorization|token|password|senha|secret|cookie)"?\s*[:=]\s*)("[^"]*"|[^,;}\s]+)/gi, "$1\"[REDACTED]\"")
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED]")
  .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[REDACTED]")
  .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "[REDACTED]");

const redactSensitiveData = (value: unknown): JsonValue => {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item));
  }

  if (typeof value === "object") {
    const output: { [key: string]: JsonValue } = {};

    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        output[key] = "[REDACTED]";
      } else if (PERSONAL_KEY_PATTERN.test(key)) {
        output[key] = "[REDACTED]";
      } else if (PERSON_NAME_KEY_PATTERN.test(key) && typeof nestedValue !== "object") {
        output[key] = maskName(nestedValue);
      } else {
        output[key] = redactSensitiveData(nestedValue);
      }
    }

    return output;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "string" ? redactSensitiveText(value) : value;
  }

  return String(value);
};

export const createRequestId = (): string => `req-${randomBytes(4).toString("hex")}`;

export const getLogLevelFromStatus = (statusCode: number): LogLevel => {
  if (statusCode >= 500) return "ERROR";
  if (statusCode >= 400) return "WARN";
  return "INFO";
};

export const logApiEvent = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
  const payload = {
    level,
    source: "api",
    message,
    ...(meta ? { meta: redactSensitiveData(meta) } : {}),
  };

  if (level === "ERROR") {
    console.error(payload);
    return;
  }

  if (level === "WARN") {
    console.warn(payload);
    return;
  }

  console.info(payload);
};

export const sanitizePayload = (payload: unknown) => redactSensitiveData(payload);
