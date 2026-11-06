// WhatsApp Fase A: status da conexão do número comercial de cada usuário (via CRM, por QR).

export type WhatsAppConnectionStatus =
  | "NOT_CONNECTED"
  | "PENDING_QR"
  | "CONNECTED"
  | "DISCONNECTED"
  | "REJECTED_WRONG_NUMBER"
  | "ERROR";

export type OwnWhatsAppConnection =
  | { enabled: false }
  | {
      enabled: true;
      configured: boolean;
      serviceAvailable: boolean;
      phoneConfigured: boolean;
      expectedPhone: string | null;
      status: WhatsAppConnectionStatus;
      statusReason: string | null;
      connectedPhone: string | null;
      connectedAt: string | null;
      lastSeenAt: string | null;
      qrDataUrl: string | null;
    };

export type WhatsAppConnectionListItem = {
  userId: string;
  status: Exclude<WhatsAppConnectionStatus, "NOT_CONNECTED">;
  statusReason: string | null;
  connectedPhone: string | null;
  connectedAt: string | null;
  lastSeenAt: string | null;
};

export const WHATSAPP_STATUS_LABELS: Record<WhatsAppConnectionStatus, string> = {
  NOT_CONNECTED: "Não conectado",
  PENDING_QR: "Aguardando leitura do QR",
  CONNECTED: "Conectado",
  DISCONNECTED: "Desconectado",
  REJECTED_WRONG_NUMBER: "Recusado: número diferente do cadastrado",
  ERROR: "Erro na conexão"
};

const REASON_LABELS: Record<string, string> = {
  phone_mismatch: "O número lido no QR não é o celular cadastrado no seu usuário. A conexão foi desfeita.",
  phone_unreadable: "Não foi possível confirmar o número lido no QR. A conexão foi desfeita.",
  phone_in_use: "Este número já está conectado por outro usuário. A conexão foi desfeita.",
  session_closed: "A sessão foi encerrada no celular. Conecte de novo pelo QR.",
  session_missing: "O QR expirou ou a sessão se perdeu. Conecte de novo pelo QR.",
  disconnected_by_user: "Você desconectou o WhatsApp.",
  disconnected_by_manager: "A gestão desconectou este WhatsApp.",
  evolution_unavailable: "O serviço de WhatsApp estava indisponível. Tente de novo."
};

export const whatsappReasonLabel = (reason: string | null | undefined) => (reason ? REASON_LABELS[reason] ?? null : null);

/** Texto curto da coluna em Configurações → Usuários. */
export const whatsappColumnLabel = (item: WhatsAppConnectionListItem | undefined) => {
  if (!item) return WHATSAPP_STATUS_LABELS.NOT_CONNECTED;
  if (item.status === "CONNECTED") return item.connectedPhone ? `Conectado · ${item.connectedPhone}` : "Conectado";
  if (item.status === "REJECTED_WRONG_NUMBER") return "Recusado (número diferente)";
  return WHATSAPP_STATUS_LABELS[item.status];
};

/** Ainda há sessão no Evolution para desconectar. */
export const whatsappCanDisconnect = (status: WhatsAppConnectionStatus | undefined) =>
  status === "CONNECTED" || status === "PENDING_QR" || status === "ERROR";
