import { PLATFORM_HEALTH_API_PATH, platformHealthSnapshotSchema, type PlatformHealthSnapshot } from "@salesforce-pro/shared";
import api from "./apiClient";

export const PLATFORM_HEALTH_TIMEOUT_MS = 12_000;

export const platformHealthSnapshotUrl = (days: 7 | 30 | 90, refresh = false) =>
  `${PLATFORM_HEALTH_API_PATH}/snapshot?days=${days}${refresh ? "&refresh=true" : ""}`;

export async function fetchPlatformHealthSnapshot(days: 7 | 30 | 90, refresh: boolean, signal?: AbortSignal): Promise<PlatformHealthSnapshot> {
  const response = await api.get(platformHealthSnapshotUrl(days, refresh), { signal, timeout: PLATFORM_HEALTH_TIMEOUT_MS });
  const parsed = platformHealthSnapshotSchema.safeParse(response.data);
  if (!parsed.success) throw Object.assign(new Error("Resposta incompatível da Saúde da Plataforma"), { code: "INVALID_PLATFORM_HEALTH_CONTRACT" });
  return parsed.data;
}

export const platformHealthAuditUrl = (query: string) => `${PLATFORM_HEALTH_API_PATH}/audit?${query}`;
