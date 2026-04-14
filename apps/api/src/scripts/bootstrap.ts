import { execSync } from "node:child_process";
import bcrypt from "bcryptjs";
import { Role } from "@prisma/client";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { ensureSmokeBootstrap } from "./ensureSmokeBootstrap.js";
import { ensureAdminBootstrap } from "../bootstrap/ensureAdminBootstrap.js";
import { validateDatabaseHealth } from "../utils/databaseHealth.js";

console.log("BOOTSTRAP START");

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

const MAX_DB_RETRIES = 60;
const RETRY_DELAY_MS = 3000;

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

async function ensureAdminUser(prismaClient: typeof prisma) {
  const email = "admin@preview.local";
  const password = "123456";

  const existing = await prismaClient.user.findUnique({
    where: { email }
  });

  if (!existing) {
    const passwordHash = await bcrypt.hash(password, 10);

    await prismaClient.user.create({
      data: {
        name: "Admin Preview",
        email,
        passwordHash,
        role: Role.diretor
      }
    });

    console.log("ADMIN CREATED");
    return;
  }

  console.log("ADMIN ALREADY EXISTS");
}

async function runDatabaseBootstrap() {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim().length === 0) {
    console.error("DB CONNECTION FAILED:", new Error("DATABASE_URL não definida no ambiente"));
    return;
  }

  try {
    await waitForDatabase();
    await prisma.$connect();
    console.log("DB CONNECTED");
    const count = await prisma.user.count();
    console.log("USERS COUNT:", count);
  } catch (error) {
    console.error("DB CONNECTION FAILED:", error);
    return;
  }

  try {
    console.log("Running prisma migrate deploy...");
    runStep("npm run prisma:migrate -w @salesforce-pro/api", "prisma db push");
  } catch (error) {
    console.error("MIGRATE FAILED (non-blocking):", error);
  }

  try {
    await validateDatabaseHealth();
  } catch (error) {
    console.error("DATABASE HEALTH CHECK FAILED (non-blocking):", error);
  }

  try {
    await ensureAdminBootstrap();
  } catch (error) {
    console.error("ADMIN BOOTSTRAP FAILED (non-blocking):", error);
  }

  if (env.enableSmokeBootstrap) {
    try {
      await ensureSmokeBootstrap();
    } catch (error) {
      console.error("SMOKE BOOTSTRAP FAILED (non-blocking):", error);
    }
  } else {
    console.log("Bootstrap smoke desabilitado (ENABLE_SMOKE_BOOTSTRAP=false)");
  }

  if (env.seedOnBootstrap) {
    try {
      runStep("npm run prisma:seed -w @salesforce-pro/api", "seed");
    } catch (error) {
      console.error("SEED FAILED (non-blocking):", error);
    }
  } else {
    console.log("Seed automático desabilitado (SEED_ON_BOOTSTRAP=false)");
  }

  try {
    await ensureAdminUser(prisma);
    const admin = await prisma.user.findUnique({
      where: { email: "admin@preview.local" }
    });
    console.log("ADMIN EXISTS:", admin);
  } catch (error) {
    console.error("ADMIN PREVIEW USER BOOTSTRAP FAILED (non-blocking):", error);
  }

  console.log("BOOTSTRAP END");
}

async function start() {
  logRuntimeContext();
  await runDatabaseBootstrap();

  app.listen(env.port, () => {
    console.log(`SERVER RUNNING ON PORT ${env.port}`);
    console.log(`API on http://localhost:${env.port}`);
  });
}

start().catch((error) => {
  console.error("Falha ao inicializar API (non-blocking)", error);
});
