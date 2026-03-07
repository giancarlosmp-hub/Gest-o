import { startServer } from "./server.js";

startServer().catch((error) => {
  console.error("Falha ao iniciar API", error);
  process.exit(1);
});
