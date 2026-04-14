import { execSync } from "node:child_process";
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

async function runBootstrapSafe() {
  logApiEvent("INFO", "BOOTSTRAP START", { mode: "runtime" });

  try {
    try {
      await prisma.$connect();
      console.log("DB CONNECTED SUCCESS");
    } catch (error) {
      logApiEvent("ERROR", "Falha ao conectar no banco durante bootstrap", {
        stack: error instanceof Error ? error.stack : String(error)
      });
      return;
    }

    try {
      execSync("npx prisma db push --schema=prisma/schema.prisma", { stdio: "inherit" });
      console.log("DB SYNC SUCCESS (db push)");
    } catch (error) {
      logApiEvent("ERROR", "Falha no prisma db push", {
        stack: error instanceof Error ? error.stack : String(error)
      });
    }

    try {
      await validateDatabaseHealth();
    } catch (error) {
      logApiEvent("ERROR", "Falha ao validar saúde do banco", {
        stack: error instanceof Error ? error.stack : String(error)
      });
    }

    try {
      await ensureAdminBootstrap();
    } catch (error) {
      logApiEvent("ERROR", "Falha no ensureAdminBootstrap", {
        stack: error instanceof Error ? error.stack : String(error)
      });
    }

    logApiEvent("INFO", "BOOTSTRAP SUCCESS", { mode: "runtime" });
  } catch (error) {
    logApiEvent("ERROR", "BOOTSTRAP ERROR", {
      stack: error instanceof Error ? error.stack : String(error)
    });
  }
}

function start() {
  startApiHttpServer(env.port, () => {
    logApiEvent("INFO", "API iniciada", { port: env.port, nodeEnv: env.nodeEnv, host: "0.0.0.0" });

    runBootstrapSafe().catch((error) => {
      logApiEvent("ERROR", "Bootstrap failed", {
        stack: error instanceof Error ? error.stack : String(error)
      });
    });
  });
}

start();
