import { PrismaClient } from "@prisma/client";
import { logApiEvent } from "../utils/logger.js";

export const prisma = new PrismaClient({
  log: [
    { emit: "event", level: "query" },
    { emit: "event", level: "error" },
    { emit: "event", level: "warn" }
  ]
});

prisma.$on("query", (event) => {
  logApiEvent("INFO", "[prisma] query", {
    durationMs: event.duration,
    query: event.query,
    params: event.params
  });
});

prisma.$on("warn", (event) => {
  logApiEvent("WARN", "[prisma] warn", {
    target: event.target,
    message: event.message
  });
});

prisma.$on("error", (event) => {
  logApiEvent("ERROR", "[prisma] error", {
    target: event.target,
    message: event.message
  });
});
