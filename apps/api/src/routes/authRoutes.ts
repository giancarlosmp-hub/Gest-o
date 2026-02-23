import { Router } from "express";
import { login, logout, me, refresh } from "../controllers/authController.js";
import { validateBody } from "../middlewares/validate.js";
import { loginSchema } from "@salesforce-pro/shared";
import { authMiddleware } from "../middlewares/auth.js";

const router = Router();
router.post("/login", validateBody(loginSchema), login);
router.post("/refresh", refresh);
router.post("/logout", logout);
router.get("/me", authMiddleware, me);

export default router;
