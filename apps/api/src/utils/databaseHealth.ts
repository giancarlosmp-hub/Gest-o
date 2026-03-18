import { prisma } from "../config/prisma.js";
import { logApiEvent } from "./logger.js";

export type DatabaseHealthSnapshot = {
  user: number;
  client: number;
  opportunity: number;
  timelineEvent: number;
  agendaEvent: number;
  activity: number;
};

type DatabaseHealthEvaluation = {
  inconsistent: boolean;
  reasons: string[];
  zeroedCriticalTables: string[];
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

export function formatSnapshot(snapshot: DatabaseHealthSnapshot) {
  return [
    `user=${snapshot.user}`,
    `client=${snapshot.client}`,
    `opportunity=${snapshot.opportunity}`,
    `timelineEvent=${snapshot.timelineEvent}`,
    `agendaEvent=${snapshot.agendaEvent}`,
    `activity=${snapshot.activity}`,
  ].join(", ");
}

function buildEnvironmentMetadata(environment = process.env) {
  return {
    nodeEnv: environment.NODE_ENV ?? "undefined",
    ci: toBoolean(environment.CI) || toBoolean(environment.GITHUB_ACTIONS),
    smoke:
      toBoolean(environment.ENABLE_SMOKE_BOOTSTRAP) || toBoolean(environment.COMPOSE_SMOKE) || toBoolean(environment.SMOKE_TEST),
  };
}

export async function getDatabaseHealthSnapshot(): Promise<DatabaseHealthSnapshot> {
  const [user, client, opportunity, timelineEvent, agendaEvent, activity] = await Promise.all([
    prisma.user.count(),
    prisma.client.count(),
    prisma.opportunity.count(),
    prisma.timelineEvent.count(),
    prisma.agendaEvent.count(),
    prisma.activity.count(),
  ]);

  return { user, client, opportunity, timelineEvent, agendaEvent, activity };
}

export function evaluateDatabaseHealth(snapshot: DatabaseHealthSnapshot): DatabaseHealthEvaluation {
  const reasons: string[] = [];
  const zeroedCriticalTables: string[] = [];

  const criticalTableEntries: Array<[string, number]> = [
    ["User", snapshot.user],
    ["Client", snapshot.client],
    ["Opportunity", snapshot.opportunity],
    ["TimelineEvent", snapshot.timelineEvent],
    ["AgendaEvent", snapshot.agendaEvent],
    ["Activity", snapshot.activity],
  ];

  criticalTableEntries.forEach(([tableName, count]) => {
    if (count === 0) {
      zeroedCriticalTables.push(tableName);
    }
  });

  if (snapshot.user === 0) {
    reasons.push("User == 0");
  }

  if (snapshot.client === 0) {
    reasons.push("Client == 0");
  }

  if (snapshot.client === 0 && snapshot.opportunity === 0) {
    reasons.push("Client == 0 e Opportunity == 0");
  }

  if (zeroedCriticalTables.length >= 2) {
    reasons.push(`Múltiplas tabelas críticas zeradas: ${zeroedCriticalTables.join(", ")}`);
  }

  return {
    inconsistent: reasons.length > 0,
    reasons,
    zeroedCriticalTables,
  };
}

export async function validateDatabaseHealth() {
  const isRealProduction = isRealProductionEnvironment();
  const environmentMetadata = buildEnvironmentMetadata();

  try {
    const snapshot = await getDatabaseHealthSnapshot();
    const evaluation = evaluateDatabaseHealth(snapshot);
    const formattedSnapshot = formatSnapshot(snapshot);

    logApiEvent("INFO", "[SAFEGUARD] Snapshot do banco", {
      snapshot,
      formattedSnapshot,
      environment: environmentMetadata,
    });

    if (!evaluation.inconsistent) {
      return;
    }

    if (isRealProduction) {
      logApiEvent("ERROR", "[CRITICAL] Banco inconsistente detectado — inicialização abortada", {
        snapshot,
        formattedSnapshot,
        reasons: evaluation.reasons,
        zeroedCriticalTables: evaluation.zeroedCriticalTables,
      });
      throw new Error(
        `[CRITICAL] Banco inconsistente detectado — inicialização abortada. Snapshot: ${formattedSnapshot}. Motivos: ${evaluation.reasons.join(" | ")}`,
      );
    }

    logApiEvent("WARN", "[SAFEGUARD] Banco inconsistente tolerado fora de produção real", {
      snapshot,
      formattedSnapshot,
      reasons: evaluation.reasons,
      zeroedCriticalTables: evaluation.zeroedCriticalTables,
      environment: environmentMetadata,
    });
  } catch (error) {
    if (isRealProduction) {
      if (error instanceof Error && error.message.includes("[CRITICAL] Banco inconsistente detectado — inicialização abortada")) {
        throw error;
      }

      logApiEvent("ERROR", "[CRITICAL] Banco inconsistente detectado — inicialização abortada", {
        environment: environmentMetadata,
        error: error instanceof Error ? error.message : String(error),
      });

      const safeguardError = new Error("[CRITICAL] Banco inconsistente detectado — inicialização abortada");
      (safeguardError as Error & { cause?: unknown }).cause = error;
      throw safeguardError;
    }

    logApiEvent("WARN", "[SAFEGUARD] Falha de validação do banco tolerada fora de produção real", {
      environment: environmentMetadata,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
