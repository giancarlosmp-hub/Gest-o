import { Router } from "express";
import { env } from "../config/env.js";
import { authMiddleware } from "../middlewares/auth.js";
import { CnpjLookupError, cnpjLookupService } from "../services/cnpjLookupService.js";
import { parseCnpj } from "../utils/cnpj.js";

const router = Router();

router.use(authMiddleware);

// Esta rota precisa ficar registrada fora do CRUD genérico para garantir
// disponibilidade explícita no boot e precedência sobre qualquer matching futuro.
router.get("/clients/cnpj-lookup/:cnpj", async (req, res) => {
  const parsedCnpj = parseCnpj(req.params.cnpj);

  if (!parsedCnpj.ok) {
    return res.status(400).json({
      message: "CNPJ inválido. Informe um CNPJ com 14 dígitos válidos.",
      code: "INVALID_CNPJ"
    });
  }

  try {
    const result = await cnpjLookupService.lookup(parsedCnpj.digits);

    return res.status(200).json({
      data: result.payload,
      meta: {
        provider: result.provider || result.payload.source || env.cnpjLookupProvider || undefined,
        normalizedCnpj: parsedCnpj.digits
      }
    });
  } catch (error) {
    if (error instanceof CnpjLookupError) {
      console.warn("[cnpj-lookup] lookup failed", {
        code: error.code,
        statusCode: error.statusCode,
        provider: (typeof error.details?.provider === "string" ? error.details.provider : env.cnpjLookupProvider) || undefined,
        cnpjSuffix: parsedCnpj.digits.slice(-4),
        details: error.details
      });

      return res.status(error.statusCode).json({
        message: error.message,
        code: error.code
      });
    }

    console.error("[cnpj-lookup] unexpected lookup failure", {
      provider: env.cnpjLookupProvider || undefined,
      cnpjSuffix: parsedCnpj.digits.slice(-4),
      error: error instanceof Error ? error.message : String(error)
    });

    return res.status(502).json({
      message: "Não foi possível consultar o CNPJ no momento. Tente novamente em instantes.",
      code: "CNPJ_LOOKUP_PROVIDER_ERROR"
    });
  }
});

export default router;
