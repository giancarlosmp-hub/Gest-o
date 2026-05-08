import { Router } from "express";
import { ultraFv3Client } from "../services/ultraFv3Client.js";
import { logApiEvent } from "../utils/logger.js";

const router = Router();

const wrap = (path: string) => async (_req: any, res: any) => {
  try {
    const data = await ultraFv3Client.request(path);
    return res.status(200).json(data);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logApiEvent("ERROR", "[ultrafv3 proxy] request failed", { path, error: details });
    return res.status(502).json({
      message: "Falha de integração UltraFV3.",
      details,
    });
  }
};

router.get("/erp/ultrafv3/health", wrap("/health"));
router.get("/erp/ultrafv3/products", wrap("/products"));
router.get("/erp/ultrafv3/partners", wrap("/partners"));
router.get("/erp/ultrafv3/payment-methods", wrap("/payment-methods"));
router.get("/erp/ultrafv3/receiving-conditions", wrap("/receiving-conditions"));
router.get("/erp/ultrafv3/price-tables", wrap("/price-tables"));
router.get("/erp/ultrafv3/branches", wrap("/branches"));
router.get("/erp/ultrafv3/operations", wrap("/operations"));
router.get("/erp/ultrafv3/salesmen", wrap("/salesmen"));
router.get("/erp/ultrafv3/order-status", wrap("/orderStatus"));

export default router;
