import { execSync } from "node:child_process";
import { URL } from "node:url";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { ensureSmokeBootstrap } from "./ensureSmokeBootstrap.js";

const MAX_DB_RETRIES = 30;
const RETRY_DELAY_MS = 2000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabase() {
  for (let attempt = 1; attempt <= MAX_DB_RETRIES; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      console.log("Postgres pronto para conexões");
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("does not exist")) {
        console.log("Banco alvo não existe. Tentando criar automaticamente...");
        await createDatabaseIfMissing();
      }

      if (attempt === MAX_DB_RETRIES) {
        throw new Error(
          `Não foi possível conectar no Postgres dentro do tempo limite. Último erro: ${message}`,
        );
      }

      console.log(
        `Postgres indisponível (${attempt}/${MAX_DB_RETRIES}), aguardando... Erro: ${message}`,
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

  const adminUrl = dbUrl.toString();

  runStep(
    `npx prisma db execute --url "${adminUrl}" --stdin <<'SQL'\nSELECT format('CREATE DATABASE %I', '${databaseName}')\nWHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${databaseName}')\n\\gexec\nSQL`,
    `criação automática do banco ${databaseName}`,
  );
}

function runStep(command: string, label: string) {
  console.log(`Executando ${label}...`);
  execSync(command, { stdio: "inherit" });
}

async function start() {
  await waitForDatabase();
  runStep("npm run prisma:migrate -w @salesforce-pro/api", "prisma migrate deploy");
  runStep("npm run prisma:generate -w @salesforce-pro/api", "prisma generate");
  await ensureSmokeBootstrap();

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
