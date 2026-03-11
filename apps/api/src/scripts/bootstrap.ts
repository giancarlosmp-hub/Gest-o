import { execSync } from "node:child_process";
import { URL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { ensureSmokeBootstrap } from "./ensureSmokeBootstrap.js";

const MAX_DB_RETRIES = 30;
const RETRY_DELAY_MS = 2000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    const asRecord = error as Error & { code?: string; meta?: unknown; cause?: unknown };
    return [
      `name=${error.name}`,
      `message=${error.message}`,
      asRecord.code ? `code=${asRecord.code}` : null,
      asRecord.meta ? `meta=${JSON.stringify(asRecord.meta)}` : null,
      asRecord.cause ? `cause=${JSON.stringify(asRecord.cause)}` : null,
    ]
      .filter(Boolean)
      .join(" | ");
  }

  return String(error);
}

function isDatabaseMissingError(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("database") && normalized.includes("does not exist");
}

async function waitForDatabase() {
  for (let attempt = 1; attempt <= MAX_DB_RETRIES; attempt++) {
    try {
      await prisma.$connect();
      await prisma.$queryRaw`SELECT 1`;
      console.log("Postgres pronto para conexões");
      return;
    } catch (error) {
      const details = formatError(error);

      if (isDatabaseMissingError(details)) {
        console.log("Banco alvo não existe. Tentando criar automaticamente...");
        await createDatabaseIfMissing();
      }

      if (attempt === MAX_DB_RETRIES) {
        throw new Error(
          `Não foi possível conectar no Postgres dentro do tempo limite. Último erro: ${details}`,
        );
      }

      console.log(
        `Postgres indisponível (${attempt}/${MAX_DB_RETRIES}), aguardando... Detalhes: ${details}`,
      );
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function createDatabaseIfMissing() {
  const dbUrl = new URL(env.databaseUrl);
  const databaseName = dbUrl.pathname.replace(/^\//, "");

  if (!databaseName) {
    throw new Error("DATABASE_URL inválida: sem nome de banco para criar");
  }

  dbUrl.pathname = "/postgres";
  dbUrl.search = "";

  const adminClient = new PrismaClient({
    datasources: {
      db: {
        url: dbUrl.toString(),
      },
    },
  });

  try {
    const existingDb = await adminClient.$queryRaw<Array<{ datname: string }>>`
      SELECT datname
      FROM pg_database
      WHERE datname = ${databaseName}
      LIMIT 1
    `;

    if (existingDb.length > 0) {
      console.log(`Banco ${databaseName} já existe`);
      return;
    }

    const safeDbName = databaseName.replace(/"/g, '""');
    await adminClient.$executeRawUnsafe(`CREATE DATABASE "${safeDbName}"`);
    console.log(`Banco ${databaseName} criado com sucesso`);
  } finally {
    await adminClient.$disconnect();
  }
}

function runStep(command: string, label: string) {
  console.log(`Executando ${label}...`);
  try {
    execSync(command, { stdio: "inherit" });
  } catch (error) {
    throw new Error(`${label} falhou ao executar \`${command}\`: ${formatError(error)}`);
  }
}

async function start() {
  await waitForDatabase();
  runStep("npx prisma migrate deploy --schema prisma/schema.prisma", "prisma migrate deploy");
  runStep("npx prisma generate --schema prisma/schema.prisma", "prisma generate");
  await ensureSmokeBootstrap();

  if (env.seedOnBootstrap) {
    runStep("node prisma/seed.js", "seed");
  } else {
    console.log("Seed automático desabilitado (SEED_ON_BOOTSTRAP=false)");
  }

  app.listen(env.port, () => {
    console.log(`API on http://localhost:${env.port}`);
  });
}

start().catch((error) => {
  console.error("Falha ao inicializar API", formatError(error));
  process.exit(1);
});
