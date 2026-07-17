import { PrismaClient } from "@prisma/client";

export function sanitizeDatabaseUrl(value: string | undefined) {
  if (!value) return value;
  const trimmed = value.trim();
  if (/schema=public[}]+($|[&#])/.test(trimmed)) {
    return trimmed.replace(/schema=public[}]+/g, "schema=public");
  }
  return trimmed;
}

const sanitizedDatabaseUrl = sanitizeDatabaseUrl(process.env.DATABASE_URL);
if (sanitizedDatabaseUrl && sanitizedDatabaseUrl !== process.env.DATABASE_URL) {
  console.warn("[database-url] corrected malformed schema suffix in DATABASE_URL");
  process.env.DATABASE_URL = sanitizedDatabaseUrl;
}

export const prisma = new PrismaClient();
