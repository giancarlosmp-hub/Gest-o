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

function buildEnvironmentMetadata(environment = process.env) {
  return {
    nodeEnv: environment.NODE_ENV ?? "undefined",
    ci: toBoolean(environment.CI) || toBoolean(environment.GITHUB_ACTIONS),
    smoke:
      toBoolean(environment.ENABLE_SMOKE_BOOTSTRAP) || toBoolean(environment.COMPOSE_SMOKE) || toBoolean(environment.SMOKE_TEST)
  };
}

function isEmptySnapshot(snapshot: DatabaseHealthSnapshot) {
  return snapshot.user === 0 && snapshot.client === 0 && snapshot.opportunity === 0 && snapshot.timelineEvent === 0;
}

export async function validateDatabaseHealth() {
  const isRealProduction = isRealProductionEnvironment();
  const environmentMetadata = buildEnvironmentMetadata();

  try {
    const [user, client, opportunity, timelineEvent] = await Promise.all([
      prisma.user.count(),
      prisma.client.count(),
      prisma.opportunity.count(),
      prisma.timelineEvent.count()
    ]);

    const snapshot = { user, client, opportunity, timelineEvent };
    const formattedSnapshot = formatSnapshot(snapshot);

    console.log("[SAFEGUARD] Database snapshot:", snapshot);

    if (!isEmptySnapshot(snapshot)) {
      return;
    }

    if (isRealProduction) {
      throw new Error(`[CRITICAL] Banco inconsistente detectado. Snapshot: ${formattedSnapshot}`);
    }

    console.warn(`[SAFEGUARD] Banco vazio permitido em ambiente não produtivo. Snapshot: ${formattedSnapshot}`);
  } catch (error) {
    if (isRealProduction) {
      const safeguardError = new Error("[CRITICAL] Falha ao validar integridade do banco em produção real; bootstrap abortado.");
      (safeguardError as Error & { cause?: unknown }).cause = error;
      throw safeguardError;
    }

    console.warn("[SAFEGUARD] Falha de conexão ou tabelas críticas indisponíveis em ambiente não produtivo; inicialização permitida.", {
      environment: environmentMetadata,
      error
    });
  }
}
