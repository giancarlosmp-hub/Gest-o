import { useMemo, useState } from "react";

type Recommendation = {
  range: string;
  notes: string[];
};

type CultureRecommendation = {
  label: string;
  goals: Record<string, Recommendation>;
};

const cardClass = "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm";

const SORGO_NOTES = [
  "Ajustar conforme PMS.",
  "Considerar germinação real do lote.",
  "Atenção à profundidade de plantio."
];

const CULTURE_RECOMMENDATIONS: Record<string, CultureRecommendation> = {
  sorgo: {
    label: "Sorgo",
    goals: {
      silagem: {
        range: "12–18 kg/ha",
        notes: SORGO_NOTES
      },
      grao: {
        range: "8–12 kg/ha",
        notes: SORGO_NOTES
      }
    }
  },
  milheto: {
    label: "Milheto",
    goals: {
      cobertura: {
        range: "15–20 kg/ha",
        notes: ["Priorizar boa cobertura inicial para proteção do solo."]
      }
    }
  },
  brachiaria: {
    label: "Brachiaria",
    goals: {
      padrao: {
        range: "8–15 kg/ha",
        notes: ["Ajustar a taxa conforme vigor da semente e sistema de implantação."]
      }
    }
  },
  trigo: {
    label: "Trigo",
    goals: {
      padrao: {
        range: "100–140 kg/ha",
        notes: ["Refinar a dose pela população alvo de plantas por metro quadrado."]
      }
    }
  },
  aveia: {
    label: "Aveia",
    goals: {
      padrao: {
        range: "60–100 kg/ha",
        notes: ["Ajustar conforme janela de plantio e finalidade da área."]
      }
    }
  }
};

const getGoalLabel = (goalKey: string) => {
  if (goalKey === "padrao") return "Padrão";
  if (goalKey === "grao") return "Grão";
  return goalKey.charAt(0).toUpperCase() + goalKey.slice(1);
};

export default function AssistenteTecnico() {
  const [selectedCulture, setSelectedCulture] = useState("");
  const [selectedGoal, setSelectedGoal] = useState("");
  const [copyStatus, setCopyStatus] = useState("");

  const selectedCultureData = selectedCulture ? CULTURE_RECOMMENDATIONS[selectedCulture] : undefined;
  const goalKeys = selectedCultureData ? Object.keys(selectedCultureData.goals) : [];

  const effectiveGoal = useMemo(() => {
    if (!selectedCultureData) return "";
    if (goalKeys.length === 1) return goalKeys[0];
    return selectedGoal;
  }, [goalKeys, selectedCultureData, selectedGoal]);

  const recommendation = selectedCultureData && effectiveGoal ? selectedCultureData.goals[effectiveGoal] : undefined;

  const handleCopyRecommendation = async () => {
    if (!selectedCultureData || !recommendation) return;

    const goalLabel = getGoalLabel(effectiveGoal);
    const text = [
      `Cultura: ${selectedCultureData.label}`,
      `Objetivo: ${goalLabel}`,
      `Faixa recomendada: ${recommendation.range}`,
      "Observações:",
      ...recommendation.notes.map((note) => `- ${note}`)
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("Recomendação copiada.");
    } catch {
      setCopyStatus("Não foi possível copiar automaticamente.");
    }
  };

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">Assistente Técnico</h1>
        <p className="text-sm text-slate-600">Ferramentas para apoio técnico e regulagem de plantio.</p>
      </header>

      <article className={cardClass}>
        <h2 className="text-base font-semibold text-slate-800">Calculadora de Semeadura</h2>
        <p className="mt-2 text-sm text-slate-500">Em breve.</p>
      </article>

      <article className={cardClass}>
        <h2 className="text-base font-semibold text-slate-800">Indicação rápida de kg/ha</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Cultura</span>
            <select
              className="w-full rounded-lg border border-slate-300 px-3 py-2"
              value={selectedCulture}
              onChange={(event) => {
                setSelectedCulture(event.target.value);
                setSelectedGoal("");
                setCopyStatus("");
              }}
            >
              <option value="">Selecione</option>
              {Object.entries(CULTURE_RECOMMENDATIONS).map(([key, value]) => (
                <option key={key} value={key}>
                  {value.label}
                </option>
              ))}
            </select>
          </label>

          {goalKeys.length > 1 && (
            <label className="space-y-1 text-sm">
              <span className="font-medium text-slate-700">Objetivo</span>
              <select className="w-full rounded-lg border border-slate-300 px-3 py-2" value={selectedGoal} onChange={(event) => setSelectedGoal(event.target.value)}>
                <option value="">Selecione</option>
                {goalKeys.map((goal) => (
                  <option key={goal} value={goal}>
                    {getGoalLabel(goal)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {recommendation && (
          <div className="mt-5 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-700">
              <span className="font-semibold">Faixa recomendada:</span> {recommendation.range}
            </p>

            <div className="text-sm text-slate-700">
              <p className="font-semibold">Observações técnicas:</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {recommendation.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>

            <button
              type="button"
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700"
              onClick={handleCopyRecommendation}
            >
              Copiar recomendação
            </button>
            {copyStatus && <p className="text-xs text-slate-500">{copyStatus}</p>}
          </div>
        )}
      </article>
    </section>
  );
}
