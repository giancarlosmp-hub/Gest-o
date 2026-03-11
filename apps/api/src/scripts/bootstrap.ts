import { execSync } from "node:child_process";
import { URL } from "node:url";
import { env } from "../config/env.js";

const MAX_DB_RETRIES = 30;
const RETRY_DELAY_MS = 2000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    const asRecord = error as Error & { code?: string; meta?: unknown; stderr?: Buffer; stdout?: Buffer };
    return [
      `name=${error.name}`,
      `message=${error.message}`,
      asRecord.code ? `code=${String(asRecord.code)}` : null,
      asRecord.stderr ? `stderr=${asRecord.stderr.toString().trim()}` : null,
      asRecord.stdout ? `stdout=${asRecord.stdout.toString().trim()}` : null,
      asRecord.meta ? `meta=${JSON.stringify(asRecord.meta)}` : null,
    ]
      .filter(Boolean)
      .join(" | ");
  }

  return String(error);
}

function logStep(message: string, extra?: Record<string, unknown>) {
  console.log(`[bootstrap] ${message}`, extra ?? "");
}

function validateEnvironment() {
  const requiredVars = ["DATABASE_URL", "PORT", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"];
  const missingVars = requiredVars.filter((key) => !process.env[key]);

  if (missingVars.length > 0) {
    throw new Error(`Variáveis obrigatórias ausentes: ${missingVars.join(", ")}`);
  }

  const dbUrl = new URL(env.databaseUrl);
  logStep("Ambiente validado", {
    nodeEnv: env.nodeEnv,
    port: env.port,
    dbHost: dbUrl.hostname,
    dbPort: dbUrl.port || "5432",
    dbName: dbUrl.pathname.replace(/^\//, ""),
  });
}

function runStep(command: string, label: string, options?: { capture?: boolean }) {
  logStep(`Executando ${label}`, { command });

  try {
    if (options?.capture) {
      return execSync(command, { stdio: "pipe" }).toString();
    }

    execSync(command, { stdio: "inherit" });
    return "";
  } catch (error) {
    throw new Error(`${label} falhou: ${formatError(error)}`);
  }
}

function isDatabaseMissingError(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("database") && normalized.includes("does not exist");
}

async function createDatabaseIfMissing() {
  const dbUrl = new URL(env.databaseUrl);
  const databaseName = dbUrl.pathname.replace(/^\//, "");

  if (!databaseName) {
    throw new Error("DATABASE_URL inválida: sem nome de banco para criar");
  }

  dbUrl.pathname = "/postgres";
  dbUrl.search = "";

  const safeDatabaseName = databaseName.replace(/"/g, '""');
  try {
    runStep(
      `npx prisma db execute --url "${dbUrl.toString()}" --stdin <<'SQL'\nCREATE DATABASE "${safeDatabaseName}";\nSQL`,
      `criação do banco ${databaseName}`,
    );
    logStep("Banco criado automaticamente", { databaseName });
  } catch (error) {
    const details = formatError(error);
    if (details.toLowerCase().includes("already exists")) {
      logStep("Banco já existia", { databaseName });
      return;
    }

    throw error;
  }
}

async function waitForDatabase() {
  for (let attempt = 1; attempt <= MAX_DB_RETRIES; attempt++) {
    try {
      runStep(
        `npx prisma db execute --url "${env.databaseUrl}" --stdin <<'SQL'\nSELECT 1;\nSQL`,
        `teste de conexão com Postgres (${attempt}/${MAX_DB_RETRIES})`,
      );
      logStep("Postgres pronto para conexões");
      return;
    } catch (error) {
      const details = formatError(error);

      if (isDatabaseMissingError(details)) {
        logStep("Banco alvo não existe; tentativa de criação automática");
        await createDatabaseIfMissing();
      }

      if (attempt === MAX_DB_RETRIES) {
        throw new Error(
          `Não foi possível conectar no Postgres dentro do tempo limite. Último erro: ${details}`,
        );
      }

      logStep(`Postgres indisponível, aguardando retry`, {
        attempt,
        maxAttempts: MAX_DB_RETRIES,
        retryDelayMs: RETRY_DELAY_MS,
        error: details,
      });
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function loadRuntimeModules() {
  const [{ app }, { prisma }, { ensureSmokeBootstrap }] = await Promise.all([
    import("../app.js"),
    import("../config/prisma.js"),
    import("./ensureSmokeBootstrap.js"),
  ]);

  return { app, prisma, ensureSmokeBootstrap };
}

async function start() {
  validateEnvironment();
  await waitForDatabase();

  runStep("npx prisma generate --schema prisma/schema.prisma", "prisma generate");
  runStep("npx prisma migrate deploy --schema prisma/schema.prisma", "prisma migrate deploy");

  const { app, prisma, ensureSmokeBootstrap } = await loadRuntimeModules();
  await prisma.$connect();
  logStep("Prisma client inicializado");

  await ensureSmokeBootstrap();

  if (env.seedOnBootstrap) {
    runStep("node prisma/seed.js", "seed");
  } else {
    logStep("Seed automático desabilitado (SEED_ON_BOOTSTRAP=false)");
  }

  app.listen(env.port, () => {
    logStep("API iniciada", { url: `http://0.0.0.0:${env.port}`, health: "/health" });
  });
}

start().catch((error) => {
  console.error("[bootstrap] Falha ao inicializar API", formatError(error));
  process.exit(1);
});
