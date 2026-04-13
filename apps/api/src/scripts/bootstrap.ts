import { execSync } from "node:child_process";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { ensureSmokeBootstrap } from "./ensureSmokeBootstrap.js";
import { ensureAdminBootstrap } from "../bootstrap/ensureAdminBootstrap.js";
import { validateDatabaseHealth } from "../utils/databaseHealth.js";

const MAX_DB_RETRIES = 60;
const RETRY_DELAY_MS = 3000;

function hasDatabaseUrl() {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabase() {
  for (let attempt = 1; attempt <= MAX_DB_RETRIES; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      console.log("Postgres pronto para conexões");
      return true;
    } catch (error) {
      if (attempt === MAX_DB_RETRIES) {
        console.error("Postgres não ficou pronto no tempo limite", error);
        return false;
      }
      console.log(`Postgres indisponível (${attempt}/${MAX_DB_RETRIES}), aguardando...`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  return false;
}

function logRuntimeContext() {
  console.log("[bootstrap] runtime context", {
    cwd: process.cwd(),
    script: import.meta.url,
    nodeEnv: process.env.NODE_ENV ?? null,
    hasDistServer: (() => {
      try {
        execSync("test -f /app/apps/api/dist/server.js");
        return true;
      } catch {
        return false;
      }
    })(),
    hasDistBootstrap: (() => {
      try {
        execSync("test -f /app/apps/api/dist/scripts/bootstrap.js");
        return true;
      } catch {
        return false;
      }
    })()
  });
}

function runStep(command: string, label: string) {
  try {
    console.log(`Executando ${label}...`);
    execSync(command, { stdio: "inherit" });
    return true;
  } catch (error) {
    console.error(`[BOOTSTRAP ERROR] Falha ao executar ${label}`, error);
    return false;
  }
}

async function runBootstrap() {
  console.log("BOOTSTRAP START");

  try {
    logRuntimeContext();

    if (!hasDatabaseUrl()) {
      console.error("BOOTSTRAP ERROR: DATABASE_URL não definida no ambiente");
      return;
    }

    const dbReady = await waitForDatabase();
    if (!dbReady) {
      console.error("BOOTSTRAP ERROR: banco indisponível, bootstrap será ignorado nesta execução");
      return;
    }

    const migrateOk = runStep("npm run prisma:migrate -w @salesforce-pro/api", "prisma migrate deploy");
    if (!migrateOk) {
      console.warn("Tentando fallback de migração com prisma db push...");
      runStep("npx prisma db push --schema=apps/api/prisma/schema.prisma", "prisma db push (fallback)");
    }

    try {
      await validateDatabaseHealth();
    } catch (error) {
      console.error("[BOOTSTRAP ERROR] validateDatabaseHealth falhou", error);
    }

    try {
      await ensureAdminBootstrap();
    } catch (error) {
      console.error("[BOOTSTRAP ERROR] ensureAdminBootstrap falhou", error);
    }

    if (env.enableSmokeBootstrap) {
      try {
        await ensureSmokeBootstrap();
      } catch (error) {
        console.error("[BOOTSTRAP ERROR] ensureSmokeBootstrap falhou", error);
      }
    } else {
      console.log("Bootstrap smoke desabilitado (ENABLE_SMOKE_BOOTSTRAP=false)");
    }

    if (env.seedOnBootstrap) {
      runStep("npm run prisma:seed -w @salesforce-pro/api", "seed");
    } else {
      console.log("Seed automático desabilitado (SEED_ON_BOOTSTRAP=false)");
    }

    console.log("BOOTSTRAP SUCCESS");
  } catch (error) {
    console.error("BOOTSTRAP ERROR", error);
  }
}

function startApiServer() {
  app.listen(env.port, () => {
    console.log(`API on http://localhost:${env.port}`);

    runBootstrap().catch((error) => {
      console.error("Bootstrap failed:", error);
    });
  });
}

startApiServer();
