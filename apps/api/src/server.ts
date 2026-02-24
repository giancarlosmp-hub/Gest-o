import { app } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";

async function waitForDatabase(maxRetries = 20, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await prisma.$connect();
      console.log("Conexão com banco estabelecida");
      return;
    } catch (error) {
      if (attempt === maxRetries) throw error;
      console.log(`Banco indisponível (tentativa ${attempt}/${maxRetries}), tentando novamente...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function start() {
  await waitForDatabase();
  app.listen(env.port, () => {
    console.log(`API on http://localhost:${env.port}`);
  });
}

start().catch((error) => {
  console.error("Falha ao iniciar API", error);
  process.exit(1);
});
