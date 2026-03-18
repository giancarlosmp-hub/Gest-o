import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "./logger.js";

export type DatabaseHealthSnapshot = {
  user: number;
  client: number;
  opportunity: number;
  timelineEvent: number;
};

const CRITICAL_TABLES = ["User", "Client", "Opportunity", "TimelineEvent"] as const;

type TableName = (typeof CRITICAL_TABLES)[number];

async function tableExists(table: TableName) {
  const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ${table}
    ) AS "exists"
  `;

  return rows[0]?.exists === true;
}

async function resolveMissingTables() {
  const checks = await Promise.all(CRITICAL_TABLES.map(async (table) => ({ table, exists: await tableExists(table) })));
  return checks.filter((check) => !check.exists).map((check) => check.table);
}

function evaluateHealth(snapshot: DatabaseHealthSnapshot) {
  const reasons: string[] = [];

  if (snapshot.user === 0) {
    reasons.push("User == 0");
  }

  if (snapshot.client === 0 && snapshot.opportunity === 0) {
    reasons.push("Client == 0 e Opportunity == 0");
  }

  const zeroCriticalTables = [snapshot.user, snapshot.client, snapshot.opportunity, snapshot.timelineEvent].filter(
    (count) => count === 0,
  ).length;

  if (zeroCriticalTables >= 2) {
    reasons.push(`Múltiplas tabelas críticas zeradas (${zeroCriticalTables})`);
  }

  return reasons;
}

export async function checkDatabaseHealth() {
  const missingTables = await resolveMissingTables();

  if (missingTables.length > 0) {
    const schemaMessage = `Schema incompleto: tabelas ausentes (${missingTables.join(", ")})`;

    if (env.isProduction) {
      logApiEvent("ERROR", `[CRITICAL] ${schemaMessage}`, {
        missingTables,
      });
      throw new Error(`${schemaMessage}. Inicialização abortada para evitar operação sem blindagem.`);
    }

    logApiEvent("WARN", "[SAFEGUARD] Checagem de sanidade adiada: schema ainda não está pronto em ambiente não produção", {
      missingTables,
    });
    return null;
  }

  const [user, client, opportunity, timelineEvent] = await Promise.all([
    prisma.user.count(),
    prisma.client.count(),
    prisma.opportunity.count(),
    prisma.timelineEvent.count(),
  ]);

  const snapshot: DatabaseHealthSnapshot = {
    user,
    client,
    opportunity,
    timelineEvent,
  };

  const reasons = evaluateHealth(snapshot);

  logApiEvent("INFO", "[SAFEGUARD] Snapshot de sanidade do banco coletado", snapshot);

  if (reasons.length === 0) {
    return snapshot;
  }

  const details = reasons.join("; ");
  const message = "Banco inconsistente detectado — inicialização abortada para evitar perda de dados";

  if (env.isProduction) {
    logApiEvent("ERROR", `[CRITICAL] ${message}`, {
      snapshot,
      reasons,
    });

    throw new Error(`${message}. Motivos: ${details}`);
  }

  logApiEvent("WARN", `[CRITICAL] ${message} (ignorado fora de produção)`, {
    snapshot,
    reasons,
  });

  return snapshot;
}
