import { randomBytes } from "node:crypto";
import { WhatsAppConnectionStatus, type PrismaClient, type WhatsAppConnection } from "@prisma/client";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { logApiEvent } from "../../utils/logger.js";
import { isWhatsAppEvolutionConfigured } from "./config.js";
import { createEvolutionClient, EvolutionUnavailableError, type EvolutionClient } from "./evolutionClient.js";
import { displayPhone, maskPhone, normalizeMobilePhone, phoneFromWhatsAppJid } from "./phoneMatch.js";

// WhatsApp Fase A: cada usuário conecta o próprio número comercial lendo um QR. Só fica CONNECTED se o
// número lido for o User.phone; senão a instância é apagada (logout) e o número lido não é gravado.
// O QR vem do Evolution a cada consulta e nunca é gravado. Nenhuma mensagem passa por aqui.

export class WhatsAppConnectionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "WhatsAppConnectionError";
  }
}

export type WhatsAppConnectionStatusView = WhatsAppConnectionStatus | "NOT_CONNECTED";

export type OwnConnectionView = {
  enabled: true;
  configured: boolean;
  serviceAvailable: boolean;
  phoneConfigured: boolean;
  expectedPhone: string | null;
  status: WhatsAppConnectionStatusView;
  statusReason: string | null;
  connectedPhone: string | null;
  connectedAt: Date | null;
  lastSeenAt: Date | null;
  qrDataUrl: string | null;
};

export type ConnectionListItem = {
  userId: string;
  status: WhatsAppConnectionStatus;
  statusReason: string | null;
  connectedPhone: string | null;
  connectedAt: Date | null;
  lastSeenAt: Date | null;
  updatedAt: Date;
};

/** Nome opaco da instância: aleatório, nunca telefone, nome ou id do usuário. */
export const newInstanceName = () => `crm-${randomBytes(12).toString("hex")}`;

// Recusa em que o logout no Evolution falhou: a próxima consulta tenta de novo antes de mostrar a recusa.
const PENDING_REJECT_PREFIX = "reject_pending:";

const serviceUnavailable = () =>
  new WhatsAppConnectionError(503, "evolution_unavailable", "Serviço de WhatsApp indisponível. Tente novamente em instantes.");

type ClientFactory = () => EvolutionClient;

export class WhatsAppConnectionService {
  constructor(
    private readonly db: PrismaClient = defaultPrisma,
    private readonly clientFactory: ClientFactory = createEvolutionClient,
    private readonly isConfigured: () => boolean = isWhatsAppEvolutionConfigured
  ) {}

  private client() {
    if (!this.isConfigured()) throw new WhatsAppConnectionError(503, "not_configured", "Integração de WhatsApp ainda não configurada no servidor.");
    return this.clientFactory();
  }

  private async userPhone(userId: string) {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { phone: true } });
    return normalizeMobilePhone(user?.phone);
  }

  private view(row: WhatsAppConnection | null, expected: string | null, extra: { serviceAvailable?: boolean; qrDataUrl?: string | null } = {}): OwnConnectionView {
    const pendingReject = row?.status === WhatsAppConnectionStatus.ERROR && row.statusReason?.startsWith(PENDING_REJECT_PREFIX);
    return {
      enabled: true,
      configured: this.isConfigured(),
      serviceAvailable: extra.serviceAvailable ?? true,
      phoneConfigured: Boolean(expected),
      expectedPhone: displayPhone(expected),
      status: row ? (pendingReject ? WhatsAppConnectionStatus.REJECTED_WRONG_NUMBER : row.status) : "NOT_CONNECTED",
      statusReason: row ? (pendingReject ? row.statusReason!.slice(PENDING_REJECT_PREFIX.length) : row.statusReason) : null,
      connectedPhone: row?.status === WhatsAppConnectionStatus.CONNECTED ? displayPhone(row.connectedPhone) : null,
      connectedAt: row?.status === WhatsAppConnectionStatus.CONNECTED ? row.connectedAt : null,
      lastSeenAt: row?.lastSeenAt ?? null,
      qrDataUrl: row?.status === WhatsAppConnectionStatus.PENDING_QR ? extra.qrDataUrl ?? null : null
    };
  }

  /** Outro usuário já conectado com este número? */
  private async phoneInUseByOther(userId: string, phone: string) {
    const other = await this.db.whatsAppConnection.findFirst({
      where: { connectedPhone: phone, status: WhatsAppConnectionStatus.CONNECTED, NOT: { userId } },
      select: { id: true }
    });
    return Boolean(other);
  }

  private markClosed(row: WhatsAppConnection, reason: string) {
    return this.db.whatsAppConnection.update({
      where: { id: row.id },
      data: { status: WhatsAppConnectionStatus.DISCONNECTED, statusReason: reason, connectedPhone: null, disconnectedAt: new Date() }
    });
  }

  /** Recusa a conexão: apaga a instância (logout) e não grava o número lido. */
  private async reject(row: WhatsAppConnection, reason: string) {
    let disconnected = true;
    try {
      await this.clientFactory().deleteInstance(row.instanceName);
    } catch (error) {
      if (!(error instanceof EvolutionUnavailableError)) throw error;
      disconnected = false;
      logApiEvent("WARN", "[whatsapp] rejected connection could not be disconnected yet", { userId: row.userId, reason: error.reason });
    }
    logApiEvent("INFO", "[whatsapp] connection rejected", { userId: row.userId, reason });
    return this.db.whatsAppConnection.update({
      where: { id: row.id },
      data: {
        status: disconnected ? WhatsAppConnectionStatus.REJECTED_WRONG_NUMBER : WhatsAppConnectionStatus.ERROR,
        statusReason: disconnected ? reason : `${PENDING_REJECT_PREFIX}${reason}`,
        connectedPhone: null,
        connectedAt: null,
        disconnectedAt: new Date()
      }
    });
  }

  /**
   * A conexão abriu: confere o número lido (do evento ou do Evolution) com o esperado e com o User.phone
   * atual. Só grava o número quando confere.
   */
  async finalizeOpen(row: WhatsAppConnection, jid?: string | null) {
    const ownerJid = jid ?? (await this.clientFactory().ownerJid(row.instanceName));
    const readPhone = phoneFromWhatsAppJid(ownerJid);
    if (!readPhone) return this.reject(row, "phone_unreadable");
    const current = await this.userPhone(row.userId);
    if (readPhone !== row.expectedPhone || readPhone !== current) return this.reject(row, "phone_mismatch");
    if (await this.phoneInUseByOther(row.userId, readPhone)) return this.reject(row, "phone_in_use");
    const now = new Date();
    const updated = await this.db.whatsAppConnection.update({
      where: { id: row.id },
      data: {
        status: WhatsAppConnectionStatus.CONNECTED,
        statusReason: null,
        connectedPhone: readPhone,
        connectedAt: row.status === WhatsAppConnectionStatus.CONNECTED && row.connectedAt ? row.connectedAt : now,
        lastSeenAt: now,
        disconnectedAt: null,
        disconnectedById: null
      }
    });
    if (row.status !== WhatsAppConnectionStatus.CONNECTED) logApiEvent("INFO", "[whatsapp] connected", { userId: row.userId });
    return updated;
  }

  /** Status do próprio usuário; com QR atual enquanto aguarda leitura. Evolution fora do ar não derruba a tela. */
  async getOwn(userId: string): Promise<OwnConnectionView> {
    const expected = await this.userPhone(userId);
    let row = await this.db.whatsAppConnection.findUnique({ where: { userId } });
    if (!row || !this.isConfigured()) return this.view(row, expected);
    try {
      if (row.status === WhatsAppConnectionStatus.ERROR && row.statusReason?.startsWith(PENDING_REJECT_PREFIX)) {
        row = await this.reject(row, row.statusReason.slice(PENDING_REJECT_PREFIX.length));
        return this.view(row, expected);
      }
      if (row.status === WhatsAppConnectionStatus.PENDING_QR) {
        const result = await this.clientFactory().connect(row.instanceName);
        if (result.kind === "open") return this.view(await this.finalizeOpen(row), expected);
        if (result.kind === "not_found") return this.view(await this.markClosed(row, "session_missing"), expected);
        return this.view(row, expected, { qrDataUrl: result.qrDataUrl });
      }
      if (row.status === WhatsAppConnectionStatus.CONNECTED) {
        const state = await this.clientFactory().connectionState(row.instanceName);
        if (state === "open") row = await this.db.whatsAppConnection.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } });
        else if (state === "close" || state === "not_found") row = await this.markClosed(row, "session_closed");
      }
      return this.view(row, expected);
    } catch (error) {
      if (error instanceof EvolutionUnavailableError) return this.view(row, expected, { serviceAvailable: false });
      throw error;
    }
  }

  /** Conectar: cria (ou reaproveita) a instância e devolve o QR. */
  async start(userId: string): Promise<OwnConnectionView> {
    const client = this.client();
    const expected = await this.userPhone(userId);
    if (!expected) throw new WhatsAppConnectionError(422, "phone_missing", "Cadastre seu celular em Usuários antes de conectar o WhatsApp.");
    if (await this.phoneInUseByOther(userId, expected)) {
      throw new WhatsAppConnectionError(409, "phone_in_use", "Este número já está conectado por outro usuário.");
    }
    const existing = await this.db.whatsAppConnection.findUnique({ where: { userId } });
    try {
      if (existing?.status === WhatsAppConnectionStatus.CONNECTED) {
        throw new WhatsAppConnectionError(409, "already_connected", "Seu WhatsApp já está conectado.");
      }
      if (existing?.status === WhatsAppConnectionStatus.PENDING_QR && existing.expectedPhone === expected) {
        const result = await client.connect(existing.instanceName);
        if (result.kind === "open") return this.view(await this.finalizeOpen(existing), expected);
        if (result.kind === "qr") return this.view(existing, expected, { qrDataUrl: result.qrDataUrl });
      } else if (existing) {
        await client.deleteInstance(existing.instanceName);
      }

      const instanceName = newInstanceName();
      const fields = {
        instanceName,
        expectedPhone: expected,
        status: WhatsAppConnectionStatus.PENDING_QR,
        statusReason: null,
        connectedPhone: null,
        connectedAt: null,
        disconnectedAt: null,
        disconnectedById: null,
        lastSeenAt: null
      };
      // A linha existe antes da instância: o webhook de conexão sempre encontra a quem pertence.
      const row = await this.db.whatsAppConnection.upsert({ where: { userId }, create: { userId, ...fields }, update: fields });
      try {
        const created = await client.createInstance(instanceName);
        logApiEvent("INFO", "[whatsapp] connection started", { userId });
        return this.view(row, expected, { qrDataUrl: created.qrDataUrl });
      } catch (error) {
        if (error instanceof EvolutionUnavailableError) {
          await this.db.whatsAppConnection.update({ where: { id: row.id }, data: { status: WhatsAppConnectionStatus.ERROR, statusReason: "evolution_unavailable" } });
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof EvolutionUnavailableError) {
        logApiEvent("WARN", "[whatsapp] evolution unavailable", { userId, reason: error.reason });
        throw serviceUnavailable();
      }
      throw error;
    }
  }

  /** Desconectar (o próprio usuário, ou diretor/gerente): logout, instância apagada e status DISCONNECTED. */
  async disconnect(targetUserId: string, actorUserId: string) {
    const client = this.client();
    const row = await this.db.whatsAppConnection.findUnique({ where: { userId: targetUserId } });
    if (!row) throw new WhatsAppConnectionError(404, "not_connected", "Nenhum WhatsApp conectado para este usuário.");
    try {
      await client.deleteInstance(row.instanceName);
    } catch (error) {
      if (error instanceof EvolutionUnavailableError) {
        logApiEvent("WARN", "[whatsapp] evolution unavailable", { userId: targetUserId, reason: error.reason });
        throw serviceUnavailable();
      }
      throw error;
    }
    const updated = await this.db.whatsAppConnection.update({
      where: { id: row.id },
      data: {
        status: WhatsAppConnectionStatus.DISCONNECTED,
        statusReason: actorUserId === targetUserId ? "disconnected_by_user" : "disconnected_by_manager",
        connectedPhone: null,
        disconnectedAt: new Date(),
        disconnectedById: actorUserId
      }
    });
    logApiEvent("INFO", "[whatsapp] disconnected", { userId: targetUserId, actorUserId });
    return updated;
  }

  async disconnectOwn(userId: string) {
    await this.disconnect(userId, userId);
    return this.view(await this.db.whatsAppConnection.findUnique({ where: { userId } }), await this.userPhone(userId));
  }

  /** Status de todos (diretor/gerente): número mascarado, sem consultar o Evolution. */
  async list(): Promise<ConnectionListItem[]> {
    const rows = await this.db.whatsAppConnection.findMany({ orderBy: { updatedAt: "desc" } });
    return rows.map((row) => {
      const pendingReject = row.status === WhatsAppConnectionStatus.ERROR && row.statusReason?.startsWith(PENDING_REJECT_PREFIX);
      return {
        userId: row.userId,
        status: pendingReject ? WhatsAppConnectionStatus.REJECTED_WRONG_NUMBER : row.status,
        statusReason: pendingReject ? row.statusReason!.slice(PENDING_REJECT_PREFIX.length) : row.statusReason,
        connectedPhone: row.status === WhatsAppConnectionStatus.CONNECTED ? maskPhone(row.connectedPhone) : null,
        connectedAt: row.connectedAt,
        lastSeenAt: row.lastSeenAt,
        updatedAt: row.updatedAt
      };
    });
  }
}

export const whatsappConnectionService = new WhatsAppConnectionService();
