import type { NextFunction, Request, Response } from "express";
import { Role } from "@prisma/client";
import { createAsyncRouter } from "../utils/asyncRouter.js";
import { authMiddleware } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { isWhatsAppEvolutionEnabled } from "../services/whatsappConnection/config.js";
import { EvolutionUnavailableError } from "../services/whatsappConnection/evolutionClient.js";
import { WhatsAppConnectionError, whatsappConnectionService } from "../services/whatsappConnection/whatsappConnectionService.js";

// WhatsApp Fase A: conexão do número comercial por QR. Não existe nenhuma rota de envio de mensagem.
// - o próprio usuário conecta, consulta e desconecta o seu número;
// - diretor e gerente veem o status de todos e podem desconectar qualquer um.
export const whatsappConnectionRoutes = createAsyncRouter();

whatsappConnectionRoutes.use(authMiddleware);

const requireEnabled = (_req: Request, res: Response, next: NextFunction) => {
  if (!isWhatsAppEvolutionEnabled()) return res.status(404).json({ message: "Integração de WhatsApp desativada.", code: "disabled" });
  next();
};

const sendError = (res: Response, error: unknown) => {
  if (error instanceof WhatsAppConnectionError) return res.status(error.status).json({ message: error.message, code: error.code });
  if (error instanceof EvolutionUnavailableError) {
    return res.status(503).json({ message: "Serviço de WhatsApp indisponível. Tente novamente em instantes.", code: "evolution_unavailable" });
  }
  throw error;
};

whatsappConnectionRoutes.get("/connection", async (req, res) => {
  if (!isWhatsAppEvolutionEnabled()) return res.json({ enabled: false });
  try {
    return res.json(await whatsappConnectionService.getOwn(req.user!.id));
  } catch (error) {
    return sendError(res, error);
  }
});

whatsappConnectionRoutes.post("/connection", requireEnabled, async (req, res) => {
  try {
    return res.json(await whatsappConnectionService.start(req.user!.id));
  } catch (error) {
    return sendError(res, error);
  }
});

whatsappConnectionRoutes.delete("/connection", requireEnabled, async (req, res) => {
  try {
    return res.json(await whatsappConnectionService.disconnectOwn(req.user!.id));
  } catch (error) {
    return sendError(res, error);
  }
});

whatsappConnectionRoutes.get("/connections", authorize(Role.diretor, Role.gerente), async (_req, res) => {
  if (!isWhatsAppEvolutionEnabled()) return res.json({ enabled: false, data: [] });
  return res.json({ enabled: true, data: await whatsappConnectionService.list() });
});

whatsappConnectionRoutes.delete("/connections/:userId", authorize(Role.diretor, Role.gerente), requireEnabled, async (req, res) => {
  try {
    const row = await whatsappConnectionService.disconnect(req.params.userId, req.user!.id);
    return res.json({ userId: row.userId, status: row.status, statusReason: row.statusReason });
  } catch (error) {
    return sendError(res, error);
  }
});
