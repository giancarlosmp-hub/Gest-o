import { prisma } from "../config/prisma.js";
import { investigateErpPartnerReadOnly } from "../services/erpPartnerInvestigationService.js";

const arg = process.argv.find((item) => item.startsWith("--erp-code="));
const report = await investigateErpPartnerReadOnly({
  erpCode: arg?.split("=")[1] || "5050",
});
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
