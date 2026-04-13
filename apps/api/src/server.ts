import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";
import { ensureAdminBootstrap } from "./bootstrap/ensureAdminBootstrap.js";
import { validateDatabaseHealth } from "./utils/databaseHealth.js";
import { logApiEvent } from "./utils/logger.js";
import { startApiHttpServer } from "./app.js";

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
      console.log("DB CONNECTED");
      return true;
    } catch (error) {
      if (attempt === maxRetries) {
        logApiEvent("ERROR", "Falha ao conectar banco após tentativas", {
          stack: error instanceof Error ? error.stack : String(error),
          attempt,
          maxRetries
        });
        return false;
      }

      logApiEvent("WARN", "Banco indisponível, tentando novamente", { attempt, maxRetries });
      console.log("DB connection attempt failed", { attempt, maxRetries });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return false;
}

async function runRuntimeBootstrap() {
  logApiEvent("INFO", "BOOTSTRAP START", { mode: "runtime" });

  try {
    const dbReady = await waitForDatabase();
    if (!dbReady) {
      logApiEvent("ERROR", "BOOTSTRAP ERROR", { reason: "database_not_ready" });
      return;
    }

    try {
      await validateDatabaseHealth();
    } catch (error) {
      logApiEvent("ERROR", "BOOTSTRAP ERROR", {
        step: "validateDatabaseHealth",
        stack: error instanceof Error ? error.stack : String(error)
      });
    }

    try {
      await ensureAdminBootstrap();
    } catch (error) {
      logApiEvent("ERROR", "BOOTSTRAP ERROR", {
        step: "ensureAdminBootstrap",
        stack: error instanceof Error ? error.stack : String(error)
      });
    }

    logApiEvent("INFO", "BOOTSTRAP SUCCESS", { mode: "runtime" });
  } catch (error) {
    logApiEvent("ERROR", "BOOTSTRAP ERROR", {
      step: "runRuntimeBootstrap",
      stack: error instanceof Error ? error.stack : String(error)
    });
  }
}

function start() {
  startApiHttpServer(env.port, () => {
    logApiEvent("INFO", "API iniciada", { port: env.port, nodeEnv: env.nodeEnv, host: "0.0.0.0" });

    runRuntimeBootstrap().catch((error) => {
      logApiEvent("ERROR", "Bootstrap failed", {
        stack: error instanceof Error ? error.stack : String(error)
      });
    });
  });
}

start();
