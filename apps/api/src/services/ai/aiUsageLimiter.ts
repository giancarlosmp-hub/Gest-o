import { z } from "zod";
import { prisma } from "../../config/prisma.js";
import { brazilDayKeyOf } from "../../utils/dateRange.js";
import { logApiEvent } from "../../utils/logger.js";

// Teto diário de chamadas ao provedor de IA por usuário, contado no dia de Brasília. Acima dele o AiService
// devolve null e cada fluxo usa o seu fallback determinístico, sem erro. O teto fica no AppConfig (não em
// variável de ambiente: o Compose de produção só repassa as variáveis que já declara).
// A contagem fica em memória do processo da API: reinício zera o dia e mais de uma réplica contaria em separado.
export const AI_USAGE_CONFIG_KEY = "ai.usage";
export const DEFAULT_AI_DAILY_CALL_LIMIT_PER_USER = 50;
// Chamadas sem usuário (ex.: IA Comercial da gestão, cacheada para todos) dividem um mesmo balde.
export const AI_SYSTEM_USAGE_BUCKET = "sistema";

const LIMIT_CACHE_MS = 60_000;

export const aiUsageConfigSchema = z.object({
  dailyCallLimitPerUser: z.number().int().min(1).max(1000)
}).strict();
export type AiUsageConfig = z.infer<typeof aiUsageConfigSchema>;

export const parseAiUsageConfig = (value: string | null | undefined): AiUsageConfig => {
  if (!value) return { dailyCallLimitPerUser: DEFAULT_AI_DAILY_CALL_LIMIT_PER_USER };
  try {
    const parsed = aiUsageConfigSchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
  } catch {
    // Valor inválido gravado: vale o padrão.
  }
  return { dailyCallLimitPerUser: DEFAULT_AI_DAILY_CALL_LIMIT_PER_USER };
};

const loadStoredDailyLimit = async () => {
  const stored = await prisma.appConfig.findUnique({ where: { key: AI_USAGE_CONFIG_KEY }, select: { value: true } });
  return parseAiUsageConfig(stored?.value).dailyCallLimitPerUser;
};

export const saveAiUsageConfig = async (config: AiUsageConfig) => {
  const value = JSON.stringify(aiUsageConfigSchema.parse(config));
  await prisma.appConfig.upsert({ where: { key: AI_USAGE_CONFIG_KEY }, update: { value }, create: { key: AI_USAGE_CONFIG_KEY, value } });
  return parseAiUsageConfig(value);
};

type Bucket = { calls: number; usage: number };
export type AiUsageReservation = { allowed: boolean; dayKey: string; callsToday: number; limit: number };

export class AiUsageLimiter {
  private dayKey = "";
  private readonly buckets = new Map<string, Bucket>();
  private cachedLimit: { value: number; expiresAt: number } | null = null;

  constructor(
    private readonly loadDailyLimit: () => Promise<number> = loadStoredDailyLimit,
    private readonly now: () => Date = () => new Date()
  ) {}

  private todayBuckets() {
    const dayKey = brazilDayKeyOf(this.now());
    if (dayKey !== this.dayKey) {
      this.dayKey = dayKey;
      this.buckets.clear();
    }
    return this.buckets;
  }

  private bucketOf(userId: string | null | undefined) {
    const buckets = this.todayBuckets();
    const key = userId || AI_SYSTEM_USAGE_BUCKET;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { calls: 0, usage: 0 };
      buckets.set(key, bucket);
    }
    return bucket;
  }

  async getDailyLimit() {
    const nowMs = this.now().getTime();
    if (this.cachedLimit && this.cachedLimit.expiresAt > nowMs) return this.cachedLimit.value;
    let value = DEFAULT_AI_DAILY_CALL_LIMIT_PER_USER;
    try {
      value = await this.loadDailyLimit();
    } catch {
      logApiEvent("WARN", "[AI] usage-limit-config-unavailable", { fallbackLimit: value });
    }
    this.cachedLimit = { value, expiresAt: nowMs + LIMIT_CACHE_MS };
    return value;
  }

  invalidateDailyLimit() {
    this.cachedLimit = null;
  }

  // Reserva uma chamada: depois do await do teto, conferir e somar é síncrono, então chamadas simultâneas
  // do mesmo usuário não passam juntas do teto.
  async reserve(userId: string | null | undefined): Promise<AiUsageReservation> {
    const limit = await this.getDailyLimit();
    const bucket = this.bucketOf(userId);
    if (bucket.calls >= limit) return { allowed: false, dayKey: this.dayKey, callsToday: bucket.calls, limit };
    bucket.calls += 1;
    return { allowed: true, dayKey: this.dayKey, callsToday: bucket.calls, limit };
  }

  recordUsage(userId: string | null | undefined, usage: number) {
    const bucket = this.bucketOf(userId);
    bucket.usage += Math.max(0, Math.round(usage));
    return { callsToday: bucket.calls, usageToday: bucket.usage };
  }
}
