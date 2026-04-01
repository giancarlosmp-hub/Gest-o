import { execSync } from "node:child_process";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { ensureSmokeBootstrap } from "./ensureSmokeBootstrap.js";
import { ensureAdminBootstrap } from "../bootstrap/ensureAdminBootstrap.js";
import { validateDatabaseHealth } from "../utils/databaseHealth.js";

const MAX_DB_RETRIES = 60;
const RETRY_DELAY_MS = 3000;

function ensureDatabaseUrlFromEnvironment() {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim().length === 0) {
    throw new Error("DATABASE_URL não definida no ambiente");
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabase() {
  for (let attempt = 1; attempt <= MAX_DB_RETRIES; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      console.log("Postgres pronto para conexões");
      return;
    } catch {
      if (attempt === MAX_DB_RETRIES) {
        throw new Error("Não foi possível conectar no Postgres dentro do tempo limite");
      }
      console.log(`Postgres indisponível (${attempt}/${MAX_DB_RETRIES}), aguardando...`);
      await sleep(RETRY_DELAY_MS);
    }
  }
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
    })()
  });
}

function runStep(command: string, label: string) {
  console.log(`Executando ${label}...`);
  execSync(command, { stdio: "inherit" });
}

async function start() {
  logRuntimeContext();
  ensureDatabaseUrlFromEnvironment();
  await waitForDatabase();
  runStep("npm run prisma:migrate -w @salesforce-pro/api", "prisma db push");
  await validateDatabaseHealth();
  await ensureAdminBootstrap();
  if (env.enableSmokeBootstrap) {
    await ensureSmokeBootstrap();
  } else {
    console.log("Bootstrap smoke desabilitado (ENABLE_SMOKE_BOOTSTRAP=false)");
  }

  if (env.seedOnBootstrap) {
    runStep("npm run prisma:seed -w @salesforce-pro/api", "seed");
  } else {
    console.log("Seed automático desabilitado (SEED_ON_BOOTSTRAP=false)");
  }

  app.listen(env.port, () => {
    console.log(`API on http://localhost:${env.port}`);
  });
}

start().catch((error) => {
  console.error("Falha ao inicializar API", error);
  process.exit(1);
});
