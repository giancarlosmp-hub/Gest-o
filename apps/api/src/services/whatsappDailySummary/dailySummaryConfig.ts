import { Prisma } from "@prisma/client";
import {
  DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG,
  WHATSAPP_DAILY_SUMMARY_SELLER_STATUSES,
  WHATSAPP_DAILY_SUMMARY_TIPS_MODELS,
  whatsappDailySummaryConfigSchema,
  type WhatsAppDailySummaryConfig,
  type WhatsAppDailySummaryRunState,
  type WhatsAppDailySummarySellerDay,
  type WhatsAppDailySummarySellerStatus
} from "@salesforce-pro/shared";
import { prisma as defaultPrisma } from "../../config/prisma.js";

// WhatsApp Fase D: configuração e controle diário do resumo, tudo no AppConfig (sem migration):
// - "whatsappDailySummary.config": a configuração (desligada por padrão);
// - "whatsappDailySummary.lastRun": situação do último dia (só contagens e código);
// - "whatsappDailySummary.day.<AAAA-MM-DD>.<userId>": situação de cada vendedor no dia. A chave do AppConfig
//   é única: criar a linha antes de enviar é a trava de "uma vez por vendedor por dia".

export const DAILY_SUMMARY_CONFIG_KEY = "whatsappDailySummary.config";
export const DAILY_SUMMARY_RUN_KEY = "whatsappDailySummary.lastRun";
export const DAILY_SUMMARY_SELLER_DAY_PREFIX = "whatsappDailySummary.day.";
export const sellerDayConfigKey = (dayKey: string, sellerId: string) => `${DAILY_SUMMARY_SELLER_DAY_PREFIX}${dayKey}.${sellerId}`;

/** Janela de envio a partir do horário configurado: depois disso o dia fecha sem novas tentativas. */
export const DAILY_SUMMARY_WINDOW_MINUTES = 180;
/** Linhas de controle diário mais antigas que isso são apagadas. */
export const DAILY_SUMMARY_RETENTION_DAYS = 30;

const BRAZIL_UTC_OFFSET_MS = 3 * 3_600_000;

/** Relógio de Brasília (UTC-3 fixo): dia, minutos desde 00:00 e dia da semana (0 = domingo). */
export function brazilClock(now: Date) {
  const local = new Date(now.getTime() - BRAZIL_UTC_OFFSET_MS);
  return { dayKey: local.toISOString().slice(0, 10), minutes: local.getUTCHours() * 60 + local.getUTCMinutes(), weekday: local.getUTCDay() };
}

export const sendTimeMinutes = (sendTime: string) => {
  const [hours, minutes] = sendTime.split(":").map(Number);
  return hours * 60 + minutes;
};

export function parseDailySummaryConfig(value: string | null | undefined): WhatsAppDailySummaryConfig {
  if (!value) return DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG;
  try {
    const parsed = JSON.parse(value);
    const merged = {
      ...DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG,
      ...(parsed && typeof parsed === "object" ? parsed : {}),
      sections: { ...DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG.sections, ...(parsed?.sections && typeof parsed.sections === "object" ? parsed.sections : {}) }
    };
    // Modelo das dicas que saiu da lista: volta ao padrão sem derrubar o resto da configuração.
    if (!(WHATSAPP_DAILY_SUMMARY_TIPS_MODELS as readonly unknown[]).includes(merged.managerTipsModel)) {
      merged.managerTipsModel = DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG.managerTipsModel;
    }
    const result = whatsappDailySummaryConfigSchema.safeParse(merged);
    return result.success ? result.data : DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG;
  } catch {
    return DEFAULT_WHATSAPP_DAILY_SUMMARY_CONFIG;
  }
}

type ConfigDb = Pick<typeof defaultPrisma, "appConfig">;

export async function loadDailySummaryConfig(db: ConfigDb = defaultPrisma) {
  const row = await db.appConfig.findUnique({ where: { key: DAILY_SUMMARY_CONFIG_KEY }, select: { value: true } });
  return parseDailySummaryConfig(row?.value);
}

export async function saveDailySummaryConfig(config: WhatsAppDailySummaryConfig, db: ConfigDb = defaultPrisma) {
  const value = JSON.stringify(whatsappDailySummaryConfigSchema.parse(config));
  const row = await db.appConfig.upsert({ where: { key: DAILY_SUMMARY_CONFIG_KEY }, update: { value }, create: { key: DAILY_SUMMARY_CONFIG_KEY, value }, select: { value: true } });
  return parseDailySummaryConfig(row.value);
}

export const emptyDailySummaryCounts = (): Record<WhatsAppDailySummarySellerStatus, number> =>
  Object.fromEntries(WHATSAPP_DAILY_SUMMARY_SELLER_STATUSES.map((status) => [status, 0])) as Record<WhatsAppDailySummarySellerStatus, number>;

const isStatus = (value: unknown): value is WhatsAppDailySummarySellerStatus =>
  typeof value === "string" && (WHATSAPP_DAILY_SUMMARY_SELLER_STATUSES as readonly string[]).includes(value);

const parseSellerDay = (value: string): WhatsAppDailySummarySellerDay | null => {
  try {
    const parsed = JSON.parse(value);
    if (!isStatus(parsed?.status)) return null;
    return {
      status: parsed.status,
      code: typeof parsed.code === "string" ? parsed.code : null,
      attempts: Number.isInteger(parsed.attempts) ? parsed.attempts : 0,
      at: typeof parsed.at === "string" ? parsed.at : ""
    };
  } catch {
    return null;
  }
};

const parseRunState = (value: string | null | undefined): WhatsAppDailySummaryRunState | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed?.dayKey !== "string" || !["done", "sender_unavailable", "window_closed"].includes(parsed.state)) return null;
    return {
      dayKey: parsed.dayKey,
      state: parsed.state,
      code: typeof parsed.code === "string" ? parsed.code : null,
      at: typeof parsed.at === "string" ? parsed.at : "",
      counts: { ...emptyDailySummaryCounts(), ...(parsed.counts && typeof parsed.counts === "object" ? parsed.counts : {}) }
    };
  } catch {
    return null;
  }
};

export type DailySummaryStore = {
  getSellerDays(dayKey: string, sellerIds: string[]): Promise<Map<string, WhatsAppDailySummarySellerDay>>;
  /** Cria a linha do vendedor no dia; false se já existe (outra execução chegou antes). */
  createSellerDay(dayKey: string, sellerId: string, state: WhatsAppDailySummarySellerDay): Promise<boolean>;
  updateSellerDay(dayKey: string, sellerId: string, state: WhatsAppDailySummarySellerDay): Promise<void>;
  getRunState(): Promise<WhatsAppDailySummaryRunState | null>;
  setRunState(state: WhatsAppDailySummaryRunState): Promise<void>;
  /** Apaga as linhas diárias criadas antes de "before". */
  cleanup(before: Date): Promise<number>;
};

export function appConfigDailySummaryStore(db: ConfigDb = defaultPrisma): DailySummaryStore {
  return {
    async getSellerDays(dayKey, sellerIds) {
      const result = new Map<string, WhatsAppDailySummarySellerDay>();
      if (!sellerIds.length) return result;
      const keys = new Map(sellerIds.map((id) => [sellerDayConfigKey(dayKey, id), id]));
      const rows = await db.appConfig.findMany({ where: { key: { in: [...keys.keys()] } }, select: { key: true, value: true } });
      for (const row of rows) {
        const state = parseSellerDay(row.value);
        const sellerId = keys.get(row.key);
        if (state && sellerId) result.set(sellerId, state);
      }
      return result;
    },
    async createSellerDay(dayKey, sellerId, state) {
      try {
        await db.appConfig.create({ data: { key: sellerDayConfigKey(dayKey, sellerId), value: JSON.stringify(state) }, select: { id: true } });
        return true;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
        throw error;
      }
    },
    async updateSellerDay(dayKey, sellerId, state) {
      await db.appConfig.update({ where: { key: sellerDayConfigKey(dayKey, sellerId) }, data: { value: JSON.stringify(state) }, select: { id: true } });
    },
    async getRunState() {
      const row = await db.appConfig.findUnique({ where: { key: DAILY_SUMMARY_RUN_KEY }, select: { value: true } });
      return parseRunState(row?.value);
    },
    async setRunState(state) {
      const value = JSON.stringify(state);
      await db.appConfig.upsert({ where: { key: DAILY_SUMMARY_RUN_KEY }, update: { value }, create: { key: DAILY_SUMMARY_RUN_KEY, value }, select: { id: true } });
    },
    async cleanup(before) {
      const { count } = await db.appConfig.deleteMany({ where: { key: { startsWith: DAILY_SUMMARY_SELLER_DAY_PREFIX }, createdAt: { lt: before } } });
      return count;
    }
  };
}
