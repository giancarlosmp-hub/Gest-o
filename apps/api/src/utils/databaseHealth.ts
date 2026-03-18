import { prisma } from "../config/prisma.js";

export type DatabaseHealthSnapshot = {
  user: number;
  client: number;
  opportunity: number;
  timelineEvent: number;
};

function toBoolean(value: string | undefined) {
  if (value == null) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function isRealProductionEnvironment(environment = process.env) {
  const isProduction = environment.NODE_ENV === "production";
  const isCi = toBoolean(environment.CI) || toBoolean(environment.GITHUB_ACTIONS);
  const isSmoke =
    toBoolean(environment.ENABLE_SMOKE_BOOTSTRAP) || toBoolean(environment.COMPOSE_SMOKE) || toBoolean(environment.SMOKE_TEST);

  return isProduction && !isCi && !isSmoke;
}

function formatSnapshot(snapshot: DatabaseHealthSnapshot) {
  return `user=${snapshot.user}, client=${snapshot.client}, opportunity=${snapshot.opportunity}, timelineEvent=${snapshot.timelineEvent}`;
}

function isEmptySnapshot(snapshot: DatabaseHealthSnapshot) {
  return snapshot.user === 0 && snapshot.client === 0 && snapshot.opportunity === 0 && snapshot.timelineEvent === 0;
}

export async function validateDatabaseHealth() {
  const isRealProduction = isRealProductionEnvironment();

  try {
    const [user, client, opportunity, timelineEvent] = await Promise.all([
      prisma.user.count(),
      prisma.client.count(),
      prisma.opportunity.count(),
      prisma.timelineEvent.count()
    ]);

    const snapshot = { user, client, opportunity, timelineEvent };
    const formattedSnapshot = formatSnapshot(snapshot);
    console.log(`[SAFEGUARD] Database snapshot: ${formattedSnapshot}`);

    if (!isEmptySnapshot(snapshot)) {
      return;
    }

    const message = `[SAFEGUARD] ${isRealProduction ? "Banco inconsistente detectado em produção real; bootstrap abortado." : "Banco vazio detectado em ambiente não produtivo; inicialização permitida."} Snapshot: ${formattedSnapshot}`;

    if (isRealProduction) {
      throw new Error(message);
    }

    console.warn(message);
  } catch (error) {
    if (isRealProduction) {
      const safeguardError = new Error("[SAFEGUARD] Falha ao validar integridade do banco em produção real; bootstrap abortado.");
      (safeguardError as Error & { cause?: unknown }).cause = error;
      throw safeguardError;
    }

    console.warn("[SAFEGUARD] Tabelas críticas indisponíveis em ambiente não produtivo; inicialização permitida.", error);
  }
}
