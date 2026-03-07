import { startServer } from "../server.js";

async function bootstrap() {
  await startServer();
}

bootstrap().catch((error) => {
  console.error("Falha ao inicializar API", error);
  process.exit(1);
});
