import { createAsyncRouter } from "../utils/asyncRouter.js";
import { Role } from "@prisma/client";
import { authMiddleware } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { communicationIntegrationService } from "../services/communications/communicationIntegrationService.js";

export const communicationRoutes = createAsyncRouter();
communicationRoutes.get("/integrations/meta-whatsapp/status", authMiddleware, authorize(Role.diretor, Role.gerente), async (_req, res) => res.json(await communicationIntegrationService.getStatus()));
