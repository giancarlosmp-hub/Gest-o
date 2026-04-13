import { app } from "./app.js";
import { execSync } from "node:child_process";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";
import { ensureAdminBootstrap } from "./bootstrap/ensureAdminBootstrap.js";
import { validateDatabaseHealth } from "./utils/databaseHealth.js";
import { logApiEvent } from "./utils/logger.js";

process.on("unhandledRejection", (reason) => {
  logApiEvent("ERROR", "[process] Promise rejeitada sem tratamento", {
    stack: reason instanceof Error ? reason.stack : String(reason),
  });
});

process.on("uncaughtException", (error) => {
  logApiEvent("ERROR", "[process] Exceção não capturada", {
    stack: error instanceof Error ? error.stack : String(error),
  });
});

async function waitForDatabase(maxRetries = 20, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await prisma.$connect();
      logApiEvent("INFO", "Conexão com banco estabelecida");
      return;
    } catch (error) {
      if (attempt === maxRetries) throw error;
      logApiEvent("WARN", "Banco indisponível, tentando novamente", { attempt, maxRetries });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function start() {
  await waitForDatabase();
  runPrismaMigrations();
  await validateDatabaseHealth();
  await ensureAdminBootstrap();
  app.listen(env.port, () => {
    logApiEvent("INFO", "API iniciada", { port: env.port, nodeEnv: env.nodeEnv });
    console.log(`API STARTED ON PORT ${env.port}`);
  });
}

function runPrismaMigrations() {
  try {
    logApiEvent("INFO", "Executando prisma migrate deploy");
    execSync("npx prisma migrate deploy", { stdio: "inherit" });
  } catch (error) {
    logApiEvent("WARN", "prisma migrate deploy falhou; executando prisma db push", {
      stack: error instanceof Error ? error.stack : String(error),
    });
    execSync("npx prisma db push", { stdio: "inherit" });
  }
}

start().catch((error) => {
  logApiEvent("ERROR", "Falha ao iniciar API", {
    stack: error instanceof Error ? error.stack : String(error),
  });
  process.exit(1);
});
