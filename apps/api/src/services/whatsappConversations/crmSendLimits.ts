import { CommunicationDirection, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { EVOLUTION_PROVIDER } from "../whatsappMessages/whatsappMessageStore.js";
import { brazilDayKey, brazilDayStart } from "../whatsappMessages/whatsappConversationReads.js";

// WhatsApp Fase C: limites do envio pelo CRM, por usuário, para reduzir o risco de bloqueio do número.
// - um envio de cada vez por usuário e intervalo mínimo entre dois envios;
// - por minuto (janela móvel, em memória);
// - por dia de Brasília: total e primeiros contatos (contatos que nunca escreveram para este número), contados
//   uma vez por contato. Em memória; no primeiro uso do dia (ou depois de reiniciar a API) parte do que já foi
//   enviado hoje pelo CRM e está gravado no banco.
// Contam os envios que saíram ou podem ter saído ("incerto"); recusa certa do Evolution não conta.
// Uma única instância da API (produção): com mais de uma, cada uma teria o próprio contador em memória.

export const CRM_SEND_LIMITS = Object.freeze({ perMinute: 6, perDay: 150, firstContactsPerDay: 20, minIntervalMs: 3_000 });

export type CrmSendLimitCode = "send_in_progress" | "rate_interval" | "rate_minute" | "rate_day" | "rate_first_contact";

type DayUsage = { day: string; total: number; firstContacts: Set<string> };
type UserUsage = { recent: number[]; lastAt: number; day: DayUsage | null };

export type LoadDayUsage = (input: { userId: string; account: string; dayStart: Date }) => Promise<{ total: number; firstContacts: Set<string> }>;

type UsageDb = Pick<PrismaClient, "communicationMessage">;

/** Envios pelo CRM de hoje deste usuário, gravados no número dele: total e contatos de primeiro contato. */
export const loadDayUsageFromDb =
  (db: UsageDb = defaultPrisma): LoadDayUsage =>
  async ({ userId, account, dayStart }) => {
    const rows = await db.communicationMessage.findMany({
      where: { provider: EVOLUTION_PROVIDER, externalAccountId: account, direction: CommunicationDirection.OUTBOUND, providerTimestamp: { gte: dayStart } },
      select: { metadata: true, conversation: { select: { externalConversationKey: true } } }
    });
    let total = 0;
    const firstContacts = new Set<string>();
    for (const row of rows) {
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? (row.metadata as Record<string, unknown>) : {};
      if (metadata.origin !== "crm" || metadata.sentByUserId !== userId) continue;
      total++;
      if (metadata.firstContact === true && row.conversation?.externalConversationKey) firstContacts.add(row.conversation.externalConversationKey);
    }
    return { total, firstContacts };
  };

export class CrmSendLimiter {
  private readonly users = new Map<string, UserUsage>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly loadDayUsage: LoadDayUsage = loadDayUsageFromDb(),
    private readonly clock: () => number = Date.now
  ) {}

  /** Trava "um envio de cada vez" do usuário; devolve a função que solta, ou null se já há um envio em curso. */
  acquire(userId: string): (() => void) | null {
    if (this.inFlight.has(userId)) return null;
    this.inFlight.add(userId);
    return () => this.inFlight.delete(userId);
  }

  private usage(userId: string) {
    let usage = this.users.get(userId);
    if (!usage) {
      usage = { recent: [], lastAt: 0, day: null };
      this.users.set(userId, usage);
    }
    return usage;
  }

  private async dayUsage(userId: string, account: string, now: number) {
    const usage = this.usage(userId);
    const day = brazilDayKey(new Date(now));
    if (usage.day?.day !== day) {
      const loaded = await this.loadDayUsage({ userId, account, dayStart: brazilDayStart(day)! });
      usage.day = { day, total: loaded.total, firstContacts: new Set(loaded.firstContacts) };
    }
    return usage.day;
  }

  /** Confere os limites para um envio a `contactKey` (telefone do contato). Chame com a trava do usuário. */
  async check(input: { userId: string; account: string; contactKey: string; firstContact: boolean }): Promise<CrmSendLimitCode | null> {
    const now = this.clock();
    const day = await this.dayUsage(input.userId, input.account, now);
    const usage = this.usage(input.userId);
    usage.recent = usage.recent.filter((at) => now - at < 60_000);
    if (usage.lastAt && now - usage.lastAt < CRM_SEND_LIMITS.minIntervalMs) return "rate_interval";
    if (usage.recent.length >= CRM_SEND_LIMITS.perMinute) return "rate_minute";
    if (day.total >= CRM_SEND_LIMITS.perDay) return "rate_day";
    if (input.firstContact && !day.firstContacts.has(input.contactKey) && day.firstContacts.size >= CRM_SEND_LIMITS.firstContactsPerDay) {
      return "rate_first_contact";
    }
    return null;
  }

  /** Registra um envio que saiu ou pode ter saído. */
  record(input: { userId: string; contactKey: string; firstContact: boolean }) {
    const now = this.clock();
    const usage = this.usage(input.userId);
    usage.recent.push(now);
    usage.lastAt = now;
    if (usage.day && usage.day.day === brazilDayKey(new Date(now))) {
      usage.day.total++;
      if (input.firstContact) usage.day.firstContacts.add(input.contactKey);
    }
  }

  /** Uso de hoje (para a tela): total e primeiros contatos. */
  async today(userId: string, account: string) {
    const day = await this.dayUsage(userId, account, this.clock());
    return { total: day.total, firstContacts: day.firstContacts.size };
  }

  reset() {
    this.users.clear();
    this.inFlight.clear();
  }
}

export const crmSendLimiter = new CrmSendLimiter();
