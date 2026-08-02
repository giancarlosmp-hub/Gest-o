export type TenancyMode = "disabled" | "default-only";

/** Parsed only by tenancy components; legacy runtime does not import this module. */
export function readTenancyMode(value = process.env.TENANCY_MODE): TenancyMode {
  if (value === "disabled" || value === "default-only") return value;
  throw new Error("TENANCY_MODE must be explicitly disabled or default-only");
}
