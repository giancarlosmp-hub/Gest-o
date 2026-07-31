import { execSync, spawnSync } from "node:child_process";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { ensureSmokeBootstrap } from "./ensureSmokeBootstrap.js";
import { ensureAdminBootstrap } from "../bootstrap/ensureAdminBootstrap.js";
import { validateDatabaseHealth } from "../utils/databaseHealth.js";
import { logApiEvent } from "../utils/logger.js";
import { startErpSyncScheduler } from "../jobs/erpSyncScheduler.js";
import { ensureErpOrderNumberSequence } from "../services/erpOrderNumberSequenceSetup.js";

console.log("BOOTSTRAP START");

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

const MAX_DB_RETRIES = 60;
const RETRY_DELAY_MS = 3000;
type DatabaseSchemaMode = "external" | "ephemeral-push";

function readDatabaseSchemaMode(): DatabaseSchemaMode {
  const value = process.env.DATABASE_SCHEMA_MODE;
  if (value === "external" || value === "ephemeral-push") return value;
  throw new Error("DATABASE_SCHEMA_MODE must be explicitly set to external or ephemeral-push");
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
  console.log(`Executando ${label}...`, { command });
  const result = spawnSync(command, { shell: true, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    console.error(`[bootstrap] ${label} failed`, {
      command,
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    });
    throw result.error ?? new Error(`${label} failed with exit code ${result.status}`);
  }
}

async function runDatabaseBootstrap() {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim().length === 0) {
    throw new Error("DATABASE_URL não definida no ambiente");
  }

  try {
    await waitForDatabase();
    console.log("DB CONNECTED");
  } catch (error) {
    console.error("DB CONNECTION FAILED:", error);
    throw error;
  }

  const schemaMode = readDatabaseSchemaMode();

  try {
    if (schemaMode === "external") {
      // The production operation applies and validates schema before this container starts.
      console.log("Database schema authority is external; automatic schema and bootstrap writes are disabled");
    } else if (schemaMode === "ephemeral-push") {
      console.log("Disposable database explicitly authorized: running prisma db push...");
      runStep("npm run prisma:migrate -w @salesforce-pro/api", "ephemeral prisma db push");
      console.log("Ensuring ERP order sequence in disposable database...");
      await ensureErpOrderNumberSequence();
    }
  } catch (error) {
    console.error("DATABASE SCHEMA BOOTSTRAP FAILED:", error);
    process.exitCode = 1;
    throw error;
  }

  try {
    await validateDatabaseHealth();
  } catch (error) {
    console.error("DATABASE HEALTH CHECK FAILED (non-blocking):", error);
  }

  if (schemaMode === "ephemeral-push") {
    try {
      await ensureAdminBootstrap();
    } catch (error) {
      console.error("ADMIN BOOTSTRAP FAILED (non-blocking):", error);
    }
  } else console.log("Admin bootstrap desabilitado por DATABASE_SCHEMA_MODE=external");

  if (schemaMode === "ephemeral-push" && env.enableSmokeBootstrap) {
    try {
      await ensureSmokeBootstrap();
    } catch (error) {
      console.error("SMOKE BOOTSTRAP FAILED (non-blocking):", error);
    }
  } else {
    console.log("Bootstrap smoke desabilitado (ENABLE_SMOKE_BOOTSTRAP=false)");
  }

  if (schemaMode === "ephemeral-push" && env.seedOnBootstrap) {
    try {
      runStep("npm run prisma:seed -w @salesforce-pro/api", "seed");
    } catch (error) {
      console.error("SEED FAILED (non-blocking):", error);
    }
  } else {
    console.log("Seed automático desabilitado (SEED_ON_BOOTSTRAP=false)");
  }

  if (schemaMode === "ephemeral-push" && env.enablePreviewSeed) {
    try {
      runStep("npm run seed:preview -w @salesforce-pro/api", "preview seed");
    } catch (error) {
      console.error("PREVIEW SEED FAILED (non-blocking):", error);
    }
  } else {
    console.log("Preview seed desabilitado (ENABLE_PREVIEW_SEED=false)");
  }

}

async function start() {
  logRuntimeContext();
  await runDatabaseBootstrap();

  const server = app.listen(env.port, () => {
    console.log(`SERVER RUNNING ON PORT ${env.port}`);
    console.log(`API on http://localhost:${env.port}`);
    logApiEvent("INFO", "[erp-sync/scheduler] initialization-requested", { entrypoint: "dist/scripts/bootstrap.js" });
    void startErpSyncScheduler()
      .then(() => logApiEvent("INFO", "[erp-sync/scheduler] initialized", { entrypoint: "dist/scripts/bootstrap.js" }))
      .catch((error) => logApiEvent("ERROR", "[erp-sync/scheduler] initialization-failed", { entrypoint: "dist/scripts/bootstrap.js", error: error instanceof Error ? error.message : String(error) }));
    console.log("BOOTSTRAP END");
    if (process.env.BOOTSTRAP_SMOKE_EXIT === "true") server.close(() => void prisma.$disconnect().finally(() => process.exit(0)));
  });
}

start().catch((error) => {
  console.error("Falha ao inicializar API", error);
  process.exit(1);
});
