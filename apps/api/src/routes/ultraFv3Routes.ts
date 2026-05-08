import { Router } from "express";
import { ultraFv3Client } from "../services/ultraFv3Client.js";
import { logApiEvent } from "../utils/logger.js";
import { authMiddleware } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";

const router = Router();

const erpAccess = [authMiddleware, authorize("diretor", "gerente")];

const wrap = (path: string) => async (_req: any, res: any) => {
  try {
    const data = await ultraFv3Client.request(path);
    return res.status(200).json(data);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logApiEvent("ERROR", "[ultrafv3 proxy] request failed", {
      path,
      error: details,
    });
    return res.status(502).json({
      message: "Falha de integração UltraFV3.",
      details,
    });
  }
};

router.get("/erp/ultrafv3/health", ...erpAccess, wrap("/health"));
router.get("/erp/ultrafv3/products", ...erpAccess, wrap("/products"));
router.get("/erp/ultrafv3/partners", ...erpAccess, wrap("/partners"));
router.get(
  "/erp/ultrafv3/payment-methods",
  ...erpAccess,
  wrap("/payment-methods"),
);
router.get(
  "/erp/ultrafv3/receiving-conditions",
  ...erpAccess,
  wrap("/receiving-conditions"),
);
router.get("/erp/ultrafv3/price-tables", ...erpAccess, wrap("/price-tables"));
router.get("/erp/ultrafv3/branches", ...erpAccess, wrap("/branches"));
router.get("/erp/ultrafv3/operations", ...erpAccess, wrap("/operations"));
router.get("/erp/ultrafv3/salesmen", ...erpAccess, wrap("/salesmen"));
router.get("/erp/ultrafv3/order-status", ...erpAccess, wrap("/orderStatus"));

export default router;
