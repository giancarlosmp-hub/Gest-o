// "Último contato" do cliente: a API manda lastContactAt (atividade ou mensagem enviada pelo WhatsApp, pelo CRM
// ou pelo app, a mais recente). Resposta antiga, sem o campo: vale a última atividade.
export type ClientLastContactSummary = {
  lastContactAt?: string | null;
  lastActivityAt?: string | null;
};

export const clientLastContactOf = (summary?: ClientLastContactSummary | null): string | null =>
  summary?.lastContactAt ?? summary?.lastActivityAt ?? null;
