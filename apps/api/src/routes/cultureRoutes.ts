import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth.js";

const cultureRecommendationSchema = z.object({
  rangeMin: z.number().positive(),
  rangeMax: z.number().positive(),
  unit: z.string().min(1).default("kg/ha"),
  notes: z.array(z.string()).default([])
});

const cultureSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  notes: z.array(z.string()).default([]),
  active: z.boolean().default(true),
  goalsJson: z.record(cultureRecommendationSchema)
});

const CULTURES_CATALOG = cultureSchema.array().parse([
  {
    id: "culture-sorgo",
    key: "sorgo",
    label: "Sorgo",
    active: true,
    notes: [
      "Ajustar conforme PMS (peso de mil sementes) do lote.",
      "Considerar a germinação real e o vigor do lote."
    ],
    goalsJson: {
      silagem: { rangeMin: 12, rangeMax: 18, unit: "kg/ha", notes: ["Atenção à profundidade de plantio e umidade do solo."] },
      grao: { rangeMin: 8, rangeMax: 12, unit: "kg/ha", notes: ["Para grão, considerar arquitetura de planta e janela da safrinha."] }
    }
  },
  {
    id: "culture-milheto",
    key: "milheto",
    label: "Milheto",
    active: true,
    notes: ["Priorizar boa cobertura inicial para proteção do solo e supressão de plantas daninhas."],
    goalsJson: {
      cobertura: { rangeMin: 15, rangeMax: 20, unit: "kg/ha", notes: ["Elevar dose em cenários de alta pressão de invasoras."] },
      pastejo: { rangeMin: 12, rangeMax: 18, unit: "kg/ha", notes: ["Avaliar altura de entrada/saída para persistência da forrageira."] }
    }
  },
  {
    id: "culture-brachiaria",
    key: "brachiaria",
    label: "Brachiaria",
    active: true,
    notes: ["Ajustar a taxa conforme vigor da semente, sistema de implantação e pressão de competição."],
    goalsJson: {
      cobertura: { rangeMin: 8, rangeMax: 15, unit: "kg/ha", notes: ["Pode variar conforme espécie e nível de incorporação."] }
    }
  },
  {
    id: "culture-trigo",
    key: "trigo",
    label: "Trigo",
    active: true,
    notes: ["Refinar a dose pela população-alvo (plantas/m²), PMS e condições de semeadura."],
    goalsJson: {
      grao: { rangeMin: 100, rangeMax: 140, unit: "kg/ha", notes: ["Ajustar conforme perfilhamento esperado e ambiente produtivo."] }
    }
  },
  {
    id: "culture-aveia",
    key: "aveia",
    label: "Aveia",
    active: true,
    notes: ["Ajustar conforme janela de plantio, finalidade e fertilidade."],
    goalsJson: {
      cobertura: { rangeMin: 60, rangeMax: 100, unit: "kg/ha", notes: ["Para cobertura, priorizar estande inicial uniforme."] },
      pastejo: { rangeMin: 70, rangeMax: 110, unit: "kg/ha", notes: ["Distribuição homogênea melhora oferta de forragem."] }
    }
  }
]);

const router = Router();
router.use(authMiddleware);

router.get("/cultures", async (req, res) => {
  const activeParam = String(req.query.active ?? "").toLowerCase();
  const onlyActive = activeParam === "true";
  const payload = onlyActive ? CULTURES_CATALOG.filter((culture) => culture.active) : CULTURES_CATALOG;
  res.json(payload);
});

router.get("/cultures/recommendations", async (req, res) => {
  const activeParam = String(req.query.active ?? "").toLowerCase();
  const onlyActive = activeParam !== "false";
  const payload = (onlyActive ? CULTURES_CATALOG.filter((culture) => culture.active) : CULTURES_CATALOG).map((culture) => ({
    key: culture.key,
    label: culture.label,
    notes: culture.notes,
    goals: Object.entries(culture.goalsJson).map(([goalKey, goal]) => ({
      key: goalKey,
      rangeMin: goal.rangeMin,
      rangeMax: goal.rangeMax,
      unit: goal.unit,
      notes: goal.notes
    }))
  }));

  res.json(payload);
});

export default router;
