import { app } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";
import { ensureAdminBootstrap } from "./bootstrap/ensureAdminBootstrap.js";
import { validateDatabaseHealth } from "./utils/databaseHealth.js";
import { logApiEvent } from "./utils/logger.js";

console.log("SERVER STARTING...");

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
  logApiEvent("ERROR", "[process] Promise rejeitada sem tratamento", {
    stack: reason instanceof Error ? reason.stack : String(reason),
  });
});

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
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
  await validateDatabaseHealth();
  await ensureAdminBootstrap();
  app.listen(env.port, () => {
    console.log(`SERVER RUNNING ON PORT ${env.port}`);
    logApiEvent("INFO", "API iniciada", { port: env.port, nodeEnv: env.nodeEnv });
  });
}

start().catch((error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
  logApiEvent("ERROR", "Falha ao iniciar API", {
    stack: error instanceof Error ? error.stack : String(error),
  });
});
