import { prisma } from "../config/prisma.js";
import { auditErpClientReadOnly } from "../services/erpClientAuditService.js";
const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
try { console.log(JSON.stringify(await auditErpClientReadOnly({ erpCode: arg("erp-code") || "5050", ownerSellerId: arg("owner-seller-id") }), null, 2)); }
finally { await prisma.$disconnect(); }
