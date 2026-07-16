import { pathToFileURL } from "node:url";
import { prisma } from "../config/prisma.js";
import { ensureErpOrderNumberSequence } from "../services/erpOrderNumberSequenceSetup.js";

const isDirectExecution = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectExecution) {
  ensureErpOrderNumberSequence()
    .catch(() => {
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

export { ensureErpOrderNumberSequence };
