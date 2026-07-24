import { prisma } from "../config/prisma.js";
import { auditErpClientReadOnly } from "../services/erpClientAuditService.js";
const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const erpCode = arg("erp-code");
if (!erpCode) {
  console.error("Informe --erp-code=<codigo> para executar a auditoria read-only.");
  process.exitCode = 1;
} else {
  try {
    console.log(JSON.stringify(await auditErpClientReadOnly({ erpCode, ownerSellerId: arg("owner-seller-id") }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Falha ao executar a auditoria read-only.");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
