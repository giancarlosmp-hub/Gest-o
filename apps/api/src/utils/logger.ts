import { randomBytes } from "crypto";

type LogLevel = "INFO" | "WARN" | "ERROR";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const SENSITIVE_KEY_PATTERN = /(password|senha|token|authorization|jwt|secret|api[-_]?key|refresh[-_]?token)/i;

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
      } else {
        output[key] = redactSensitiveData(nestedValue);
      }
    }

    return output;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
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
