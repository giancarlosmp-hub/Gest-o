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

async function connectDatabaseOrFail() {
  logApiEvent("INFO", "Tentando conectar no banco", { host: "db", port: 5432 });

  try {
    await prisma.$connect();
    console.log("DB CONNECTED SUCCESS");
    logApiEvent("INFO", "Conexão com banco estabelecida");
  } catch (error) {
    logApiEvent("ERROR", "Falha ao conectar no banco", {
      stack: error instanceof Error ? error.stack : String(error)
    });
    throw error;
  }
}

function runMigrationsOrFail() {
  logApiEvent("INFO", "Executando prisma migrate deploy");

  try {
    execSync("npx prisma migrate deploy --schema=prisma/schema.prisma", { stdio: "inherit" });
    logApiEvent("INFO", "prisma migrate deploy concluído");
  } catch (error) {
    logApiEvent("ERROR", "Falha no prisma migrate deploy", {
      stack: error instanceof Error ? error.stack : String(error)
    });
    throw error;
  }
}

async function startupBootstrapOrFail() {
  await connectDatabaseOrFail();
  runMigrationsOrFail();
  await validateDatabaseHealth();
  await ensureAdminBootstrap();
}

async function start() {
  try {
    await startupBootstrapOrFail();

    startApiHttpServer(env.port, () => {
      logApiEvent("INFO", "API iniciada", { port: env.port, nodeEnv: env.nodeEnv, host: "0.0.0.0" });
    });
  } catch (error) {
    logApiEvent("ERROR", "Startup abortado: API não subirá sem banco/migrations", {
      stack: error instanceof Error ? error.stack : String(error)
    });
    process.exit(1);
  }
}

start();
