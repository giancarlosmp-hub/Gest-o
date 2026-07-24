import { prisma } from "../config/prisma.js";
import { repairErpClientDryRun } from "../services/erpClientAuditService.js";
const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
try { console.log(JSON.stringify(await repairErpClientDryRun({ erpCode: arg("erp-code") || "5050", ownerSellerId: arg("owner-seller-id"), apply: process.argv.includes("--apply") }), null, 2)); }
finally { await prisma.$disconnect(); }
