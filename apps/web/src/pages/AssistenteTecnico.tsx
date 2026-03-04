import { useMemo, useState } from "react";

const cardClass = "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm";

type SemeaduraForm = {
  cultura: string;
  objetivo: string;
  populacaoHa: string;
  espacamentoCm: string;
  pms: string;
  germinacao: string;
  pureza: string;
  correcaoCampo: string;
};

const initialForm: SemeaduraForm = {
  cultura: "Sorgo",
  objetivo: "",
  populacaoHa: "",
  espacamentoCm: "",
  pms: "",
  germinacao: "",
  pureza: "",
  correcaoCampo: "0"
};

const culturas = ["Sorgo", "Milho", "Milheto", "Trigo", "Aveia", "Brachiaria"];

const inputClass =
  "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200";

function parseNumber(value: string) {
  const normalized = value.replace(",", ".").trim();
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function formatValue(value: number, digits = 2) {
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

/** Indicação rápida (kg/ha) */
type Recommendation = {
  range: string;
  notes: string[];
};

type CultureRecommendation = {
  label: string;
  goals: Record<string, Recommendation>;
};

const SORGO_NOTES = [
  "Ajustar conforme PMS (peso de mil sementes) do lote.",
  "Considerar a germinação real e o vigor do lote.",
  "Atenção à profundidade de plantio e umidade do solo."
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
        notes: ["Priorizar boa cobertura inicial para proteção do solo e supressão de plantas daninhas."]
      }
    }
  },
  brachiaria: {
    label: "Brachiaria",
    goals: {
      padrao: {
        range: "8–15 kg/ha",
        notes: ["Ajustar a taxa conforme vigor da semente, sistema de implantação e pressão de competição."]
      }
    }
  },
  trigo: {
    label: "Trigo",
    goals: {
      padrao: {
        range: "100–140 kg/ha",
        notes: ["Refinar a dose pela população-alvo (plantas/m²), PMS e condições de semeadura."]
      }
    }
  },
  aveia: {
    label: "Aveia",
    goals: {
      padrao: {
        range: "60–100 kg/ha",
        notes: ["Ajustar conforme janela de plantio, finalidade (cobertura/pastejo) e fertilidade."]
      }
    }
  }
};

const getGoalLabel = (goalKey: string) => {
  if (goalKey === "padrao") return "Padrão";
  if (goalKey === "grao") return "Grão";
  if (goalKey === "silagem") return "Silagem";
  if (goalKey === "cobertura") return "Cobertura";
  return goalKey.charAt(0).toUpperCase() + goalKey.slice(1);
};

export default function AssistenteTecnico() {
  /** Calculadora */
  const [form, setForm] = useState<SemeaduraForm>(initialForm);

  const results = useMemo(() => {
    const populacaoHa = parseNumber(form.populacaoHa);
    const espacamentoCm = parseNumber(form.espacamentoCm);
    const pms = parseNumber(form.pms);
    const germinacao = parseNumber(form.germinacao);
    const pureza = parseNumber(form.pureza);
    const correcaoCampo = parseNumber(form.correcaoCampo);

    const plantasM2 = populacaoHa / 10000;
    const fator = (germinacao / 100) * (pureza / 100);

    if (fator <= 0 || espacamentoCm <= 0 || pms <= 0 || populacaoHa <= 0) {
      return {
        plantasM2,
        sementesM2: 0,
        sementesMetro: 0,
        kgHa: 0,
        kgHaFinal: 0,
        fator
      };
    }

    const sementesM2 = plantasM2 / fator;
    const espacamentoM = espacamentoCm / 100;
    const sementesMetro = sementesM2 * espacamentoM;
    const kgHa = (sementesM2 * pms) / 1000;
    const kgHaFinal = kgHa * (1 + correcaoCampo / 100);

    return {
      plantasM2,
      sementesM2,
      sementesMetro,
      kgHa,
      kgHaFinal,
      fator
    };
  }, [form]);

  const updateField = (key: keyof SemeaduraForm, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const clearForm = () => setForm(initialForm);

  /** Recomendação rápida */
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

      <div className="grid gap-4 md:grid-cols-2">
        {/* CALCULADORA */}
        <article className={cardClass}>
          <div className="mb-5 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-800">Calculadora de Semeadura</h2>
              <p className="mt-1 text-sm text-slate-500">Cálculo instantâneo de sementes por metro e kg/ha.</p>
            </div>
            <button
              type="button"
              onClick={clearForm}
              className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Limpar
            </button>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-sm text-slate-700">
              Cultura
              <select value={form.cultura} onChange={(event) => updateField("cultura", event.target.value)} className={inputClass}>
                {culturas.map((cultura) => (
                  <option key={cultura} value={cultura}>
                    {cultura}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm text-slate-700">
              Objetivo (opcional)
              <input
                value={form.objetivo}
                onChange={(event) => updateField("objetivo", event.target.value)}
                placeholder="Ex.: silagem, grão, cobertura"
                className={inputClass}
              />
            </label>

            <label className="block text-sm text-slate-700">
              População desejada (plantas/ha)
              <input
                type="number"
                min="0"
                value={form.populacaoHa}
                onChange={(event) => updateField("populacaoHa", event.target.value)}
                className={inputClass}
              />
            </label>

            <label className="block text-sm text-slate-700">
              Espaçamento entre linhas (cm)
              <input
                type="number"
                min="0"
                value={form.espacamentoCm}
                onChange={(event) => updateField("espacamentoCm", event.target.value)}
                className={inputClass}
              />
            </label>

            <label className="block text-sm text-slate-700">
              PMS (g)
              <input
                type="number"
                min="0"
                value={form.pms}
                onChange={(event) => updateField("pms", event.target.value)}
                className={inputClass}
              />
            </label>

            <label className="block text-sm text-slate-700">
              Germinação (%)
              <input
                type="number"
                min="0"
                value={form.germinacao}
                onChange={(event) => updateField("germinacao", event.target.value)}
                className={inputClass}
              />
            </label>

            <label className="block text-sm text-slate-700">
              Pureza (%)
              <input
                type="number"
                min="0"
                value={form.pureza}
                onChange={(event) => updateField("pureza", event.target.value)}
                className={inputClass}
              />
            </label>

            <label className="block text-sm text-slate-700">
              Correção de campo (%)
              <input
                type="number"
                value={form.correcaoCampo}
                onChange={(event) => updateField("correcaoCampo", event.target.value)}
                className={inputClass}
              />
            </label>
          </div>

          <div className="mt-6 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Plantas por m²</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{formatValue(results.plantasM2)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Sementes por m²</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{formatValue(results.sementesM2)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Sementes por metro linear</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{formatValue(results.sementesMetro)}</p>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <p className="text-xs uppercase tracking-wide text-emerald-700">kg/ha recomendado</p>
              <p className="mt-1 text-2xl font-bold text-emerald-700">{formatValue(results.kgHaFinal)} kg/ha</p>
            </div>
          </div>

          <div className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-slate-800">Entenda o cálculo</h3>
            <div className="mt-2 space-y-1 text-sm text-slate-600">
              <p>1) plantas/m² = plantas/ha ÷ 10.000</p>
              <p>2) fator = (germinação ÷ 100) × (pureza ÷ 100)</p>
              <p>3) sementes/m² = plantas/m² ÷ fator</p>
              <p>4) sementes/metro = sementes/m² × (espaçamento cm ÷ 100)</p>
              <p>5) kg/ha = (sementes/m² × PMS) ÷ 1.000</p>
              <p>6) kg/ha final = kg/ha × (1 + correção ÷ 100)</p>
            </div>
          </div>
        </article>

        {/* INDICAÇÃO RÁPIDA */}
        <article className={cardClass}>
          <h2 className="text-base font-semibold text-slate-800">Indicação rápida de kg/ha</h2>
          <p className="mt-1 text-sm text-slate-500">Selecione cultura e objetivo para obter uma faixa de referência.</p>

          <div className="mt-4 grid gap-4">
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

            {goalKeys.length > 1 ? (
              <label className="space-y-1 text-sm">
                <span className="font-medium text-slate-700">Objetivo</span>
                <select
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  value={selectedGoal}
                  onChange={(event) => {
                    setSelectedGoal(event.target.value);
                    setCopyStatus("");
                  }}
                >
                  <option value="">Selecione</option>
                  {goalKeys.map((goal) => (
                    <option key={goal} value={goal}>
                      {getGoalLabel(goal)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {recommendation ? (
              <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
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

                {copyStatus ? <p className="text-xs text-slate-500">{copyStatus}</p> : null}
              </div>
            ) : null}
          </div>
        </article>
      </div>
    </section>
  );
}