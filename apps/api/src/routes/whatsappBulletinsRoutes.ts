import type { Request, Response } from "express";
import { MarketingConsentSource, MarketingConsentStatus, Role } from "@prisma/client";
import { clientCulturesUpdateSchema, marketingConsentRecordSchema } from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";
import { authMiddleware } from "../middlewares/auth.js";
import { validateBody } from "../middlewares/validate.js";
import { createAsyncRouter } from "../utils/asyncRouter.js";
import { resolveUniqueActiveTenantForUser } from "../services/ultraFv3SyncService.js";
import { recordMarketingConsent } from "../services/marketingConsent/marketingConsent.js";
import { readClientBulletinPhones, readClientCultures, replaceClientCultures } from "../services/marketingConsent/clientBulletins.js";

// Campanhas WhatsApp Fase 1 (sem envio): card "Boletins WhatsApp" da ficha do cliente.
// - Sempre no tenant único e ativo do usuário; o cliente tem de ser desse tenant.
// - Vendedor só nos clientes da própria carteira (ownerSellerId); gerente e diretor em todos. Cliente fora do
//   alcance responde 404, como na ficha.
// - Registro manual só por referência à linha do ClientPhoneIndex do próprio cliente: nunca número digitado.
// - Nada aqui grava log com telefone.

export const whatsappBulletinsRoutes = createAsyncRouter();
whatsappBulletinsRoutes.use("/bulletins", authMiddleware);

const isManager = (req: Request) => req.user!.role === Role.diretor || req.user!.role === Role.gerente;

const resolveTenant = async (req: Request, res: Response) => {
  try {
    return await resolveUniqueActiveTenantForUser(req.user!.id);
  } catch (error) {
    if ((error as { status?: number })?.status !== 403) throw error;
    res.status(403).json({ message: "Contexto de tenant ausente ou ambíguo." });
    return null;
  }
};

/** Cliente do tenant ao alcance do usuário, ou null (a resposta 403/404 já foi enviada). */
const resolveClient = async (req: Request, res: Response) => {
  const tenantId = await resolveTenant(req, res);
  if (!tenantId) return null;
  const client = await prisma.client.findFirst({
    where: { id: req.params.clientId, tenantId, ...(isManager(req) ? {} : { ownerSellerId: req.user!.id }) },
    select: { id: true },
  });
  if (!client) {
    res.status(404).json({ message: "Cliente não encontrado." });
    return null;
  }
  return { tenantId, clientId: client.id };
};

whatsappBulletinsRoutes.get("/bulletins/clients/:clientId/consent", async (req, res) => {
  const scope = await resolveClient(req, res);
  if (!scope) return;
  res.json({ phones: await readClientBulletinPhones(prisma, scope) });
});

whatsappBulletinsRoutes.post("/bulletins/clients/:clientId/consent", validateBody(marketingConsentRecordSchema), async (req, res) => {
  const scope = await resolveClient(req, res);
  if (!scope) return;
  const body = req.body as ReturnType<typeof marketingConsentRecordSchema.parse>;
  const phoneRow = await prisma.clientPhoneIndex.findFirst({
    where: { id: body.phoneRef, clientId: scope.clientId },
    select: { phone: true },
  });
  if (!phoneRow) return res.status(404).json({ message: "Telefone não encontrado neste cliente.", code: "phone_not_found" });
  const actor = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { id: true, name: true } });
  await prisma.$transaction((tx) =>
    recordMarketingConsent(tx, {
      tenantId: scope.tenantId,
      phone: phoneRow.phone,
      clientId: scope.clientId,
      status: body.status as MarketingConsentStatus,
      source: body.source as MarketingConsentSource,
      note: body.note ?? null,
      recordedBy: { id: req.user!.id, name: actor?.name || req.user!.email },
    })
  );
  res.status(201).json({ phones: await readClientBulletinPhones(prisma, scope) });
});

whatsappBulletinsRoutes.get("/bulletins/clients/:clientId/cultures", async (req, res) => {
  const scope = await resolveClient(req, res);
  if (!scope) return;
  res.json(await readClientCultures(prisma, scope.clientId));
});

whatsappBulletinsRoutes.put("/bulletins/clients/:clientId/cultures", validateBody(clientCulturesUpdateSchema), async (req, res) => {
  const scope = await resolveClient(req, res);
  if (!scope) return;
  const result = await replaceClientCultures(prisma, { clientId: scope.clientId, cultureIds: req.body.cultureIds });
  if (!result.ok) {
    return res.status(400).json({
      message: result.reason === "unknown_culture" ? "Cultura não encontrada no catálogo técnico." : "Cultura desativada no catálogo técnico.",
      code: result.reason,
    });
  }
  res.json(await readClientCultures(prisma, scope.clientId));
});
