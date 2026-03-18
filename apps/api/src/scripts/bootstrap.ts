import { execSync } from "node:child_process";
import { app } from "../app.js";
import { env, runtimeGuards } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { ensureSmokeBootstrap } from "./ensureSmokeBootstrap.js";
import { ensureAdminBootstrap } from "../bootstrap/ensureAdminBootstrap.js";
import { checkDatabaseHealth } from "../utils/databaseHealth.js";

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

function runStep(command: string, label: string) {
  console.log(`Executando ${label}...`);
  execSync(command, { stdio: "inherit" });
}

async function start() {
  ensureDatabaseUrlFromEnvironment();
  await waitForDatabase();

  if (env.isProduction && env.enableSmokeBootstrapRequested) {
    console.warn("[SAFEGUARD] Seed/Bootstrap ignorado em produção por segurança (ENABLE_SMOKE_BOOTSTRAP)");
  }

  if (env.isProduction && env.seedOnBootstrapRequested) {
    console.warn("[SAFEGUARD] Seed/Bootstrap ignorado em produção por segurança (SEED_ON_BOOTSTRAP)");
  }

  runStep("npm run prisma:migrate -w @salesforce-pro/api", "prisma db push");
  await ensureAdminBootstrap();
  if (runtimeGuards.enableSmokeBootstrap) {
    await ensureSmokeBootstrap();
  } else {
    console.log("Bootstrap smoke desabilitado (ENABLE_SMOKE_BOOTSTRAP=false)");
  }

  if (runtimeGuards.seedOnBootstrap) {
    runStep("npm run prisma:seed -w @salesforce-pro/api", "seed");
  } else {
    console.log("Seed automático desabilitado (SEED_ON_BOOTSTRAP=false)");
  }

  await checkDatabaseHealth();

  app.listen(env.port, () => {
    console.log(`API on http://localhost:${env.port}`);
  });
}

start().catch((error) => {
  console.error("Falha ao inicializar API", error);
  process.exit(1);
});
