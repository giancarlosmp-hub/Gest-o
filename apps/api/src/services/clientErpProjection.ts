// Projeção dos dados financeiros do ERP devolvidos à tela. O payload bruto do ERP
// (financialProfile e partnerTitles) nunca sai da API: só as chaves abaixo.

export const CLIENT_FINANCIAL_PROFILE_ALLOWED_KEYS = [
  "DIAS_MEDIAATRASO",
  "DIAS_MAIORATRASO_AB",
  "QTD_CHEQUES_DEV",
  "VALOR_MEDIO",
  "DATA_PRIMFATURA",
  "DATA_ULTFATURA",
  "VALOR_ULTFATURA"
] as const;

export const CLIENT_PARTNER_TITLE_ALLOWED_KEYS = [
  "DOCTO",
  "PARCELA",
  "DATA_VENCIMENTO",
  "DSCFORMA",
  "VALOR",
  "SALDO_CAPITAL"
] as const;

export type ClientCreditAlertLevel = "ok" | "atencao" | "risco";

export type ClientCreditAlert = {
  level: ClientCreditAlertLevel;
  reasons: string[];
};

type ErpScalar = string | number | boolean | null;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const isErpScalar = (value: unknown): value is ErpScalar =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const pickAllowed = (source: Record<string, unknown>, keys: readonly string[]) => {
  const output: Record<string, ErpScalar> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && isErpScalar(value)) output[key] = value;
  }
  return output;
};

export const projectClientFinancialProfile = (value: unknown): Record<string, ErpScalar> | null => {
  const record = asRecord(value);
  return record ? pickAllowed(record, CLIENT_FINANCIAL_PROFILE_ALLOWED_KEYS) : null;
};

export const projectClientPartnerTitles = (value: unknown): Record<string, ErpScalar>[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((title) => {
    const record = asRecord(title);
    return record ? [pickAllowed(record, CLIENT_PARTNER_TITLE_ALLOWED_KEYS)] : [];
  });
};

// Mesma conversão que a tela usava: vazio vira 0, "1.234,5" vira 1234.5.
const numberFromErp = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};

const formatBrl = (value: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);

const pluralDays = (days: number) =>
  `${days.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${days === 1 ? "dia" : "dias"}`;

/**
 * Regra de crédito que antes ficava no web (selo Verde/Amarelo/Vermelho do Perfil Financeiro ERP),
 * com os mesmos limites, mais os títulos vencidos (overdueTitlesTotal > 0 é risco).
 */
export const buildClientCreditAlert = (client: { financialProfile?: unknown; overdueTitlesTotal?: number | null }): ClientCreditAlert => {
  const reasons: string[] = [];
  let level: ClientCreditAlertLevel = "ok";

  const overdueTitlesTotal = typeof client.overdueTitlesTotal === "number" ? client.overdueTitlesTotal : 0;
  if (overdueTitlesTotal > 0) {
    level = "risco";
    reasons.push(`Cliente com títulos vencidos: ${formatBrl(overdueTitlesTotal)}`);
  }

  const profile = asRecord(client.financialProfile);
  if (profile) {
    const averageDelay = numberFromErp(profile.DIAS_MEDIAATRASO);
    const openDelay = numberFromErp(profile.DIAS_MAIORATRASO_AB);
    const bouncedChecks = numberFromErp(profile.QTD_CHEQUES_DEV);

    if (averageDelay === 0 && openDelay === 0 && bouncedChecks === 0) {
      // Verde no selo antigo: nada a acrescentar.
    } else if ((averageDelay ?? 0) > 15 || (openDelay ?? 0) > 0 || (bouncedChecks ?? 0) > 0) {
      level = "risco";
      if ((averageDelay ?? 0) > 15) reasons.push(`Atraso médio de ${pluralDays(averageDelay!)}`);
      if ((openDelay ?? 0) > 0) reasons.push(`Maior atraso em aberto: ${pluralDays(openDelay!)}`);
      if ((bouncedChecks ?? 0) > 0) reasons.push(`${bouncedChecks} ${bouncedChecks === 1 ? "cheque devolvido" : "cheques devolvidos"}`);
    } else {
      if (level === "ok") level = "atencao";
      reasons.push(
        (averageDelay ?? 0) > 0
          ? `Atraso médio de ${pluralDays(averageDelay!)}`
          : "Dados de atraso do ERP incompletos; confira com o financeiro"
      );
    }
  }

  return { level, reasons };
};

/** Cliente pronto para resposta HTTP: ERP só pela lista de permitidos, mais o creditAlert. */
export const projectClientForResponse = <T extends { financialProfile?: unknown; partnerTitles?: unknown; overdueTitlesTotal?: number | null }>(
  client: T
) => ({
  ...client,
  financialProfile: projectClientFinancialProfile(client.financialProfile),
  partnerTitles: projectClientPartnerTitles(client.partnerTitles),
  creditAlert: buildClientCreditAlert(client)
});
