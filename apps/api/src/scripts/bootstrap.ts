import { execSync } from "node:child_process";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";

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
  await waitForDatabase();
  runStep("npm run prisma:migrate -w @salesforce-pro/api", "prisma db push");
  runStep("npm run prisma:seed -w @salesforce-pro/api", "seed");

  app.listen(env.port, () => {
    console.log(`API on http://localhost:${env.port}`);
  });
}

start().catch((error) => {
  console.error("Falha ao inicializar API", error);
  process.exit(1);
});
