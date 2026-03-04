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

type JsPdfClass = new (options?: { unit?: string; format?: string }) => {
  internal: { pageSize: { getWidth: () => number } };
  setFont: (font: string, style: string) => void;
  setFontSize: (size: number) => void;
  setTextColor: (r: number, g: number, b: number) => void;
  text: (text: string | string[], x: number, y: number) => void;
  splitTextToSize: (text: string, size: number) => string[];
  addImage: (imageData: string, format: string, x: number, y: number, width: number, height: number) => void;
  save: (filename: string) => void;
};

declare global {
  interface Window {
    jspdf?: {
      jsPDF: JsPdfClass;
    };
  }
}

const loadJsPdf = () =>
  new Promise<JsPdfClass>((resolve, reject) => {
    if (window.jspdf?.jsPDF) {
      resolve(window.jspdf.jsPDF);
      return;
    }

    const existingScript = document.querySelector('script[data-js="jspdf"]') as HTMLScriptElement | null;
    if (existingScript) {
      existingScript.addEventListener("load", () => {
        if (window.jspdf?.jsPDF) {
          resolve(window.jspdf.jsPDF);
          return;
        }
        reject(new Error("Biblioteca jsPDF não carregada."));
      });
      existingScript.addEventListener("error", () => reject(new Error("Falha ao carregar jsPDF.")));
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.2/jspdf.umd.min.js";
    script.async = true;
    script.dataset.js = "jspdf";
    script.onload = () => {
      if (window.jspdf?.jsPDF) {
        resolve(window.jspdf.jsPDF);
        return;
      }
      reject(new Error("Biblioteca jsPDF indisponível após carregamento."));
    };
    script.onerror = () => reject(new Error("Não foi possível baixar a biblioteca jsPDF."));
    document.head.appendChild(script);
  });

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
  const [pdfStatus, setPdfStatus] = useState("");

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

  const loadImageAsDataUrl = (src: string) =>
    new Promise<string>((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");

        if (!context) {
          reject(new Error("Não foi possível preparar a imagem para o PDF."));
          return;
        }

        context.drawImage(image, 0, 0);
        resolve(canvas.toDataURL("image/png"));
      };
      image.onerror = () => reject(new Error("Não foi possível carregar a logo da Demetra."));
      image.src = src;
    });

  const getTechnicalAlerts = () => {
    const alerts: string[] = [];
    const germinacao = parseNumber(form.germinacao);
    const pureza = parseNumber(form.pureza);
    const pms = parseNumber(form.pms);
    const espacamento = parseNumber(form.espacamentoCm);

    if (germinacao <= 0 || pureza <= 0) {
      alerts.push("Preencha germinação e pureza com valores acima de zero para liberar o cálculo completo.");
    }
    if (results.fator < 0.7 && results.fator > 0) {
      alerts.push("Fator de conversão baixo. Avalie qualidade do lote e ajuste de regulagem em campo.");
    }
    if (pms > 0 && pms < 15) {
      alerts.push("PMS informado está baixo. Confira unidade e laudo da semente.");
    }
    if (espacamento > 0 && espacamento > 90) {
      alerts.push("Espaçamento alto para muitas culturas. Valide o arranjo populacional planejado.");
    }
    if (!alerts.length) {
      alerts.push("Sem alertas críticos para os dados informados.");
    }

    return alerts;
  };

  const handleExportPdf = async () => {
    try {
      setPdfStatus("");
      const jsPDF = await loadJsPdf();
      const pdf = new jsPDF({ unit: "mm", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      let y = 18;

      const logoDataUrl = await loadImageAsDataUrl(`${window.location.origin}/logo-demetra.png`);
      pdf.addImage(logoDataUrl, "PNG", 14, 10, 28, 12);
      y = 28;
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(16);
      pdf.text("Relatório de Cálculo de Semeadura", 14, y);
      y += 7;

      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(10);
      pdf.setTextColor(90, 90, 90);
      pdf.text(`Data e hora: ${new Date().toLocaleString("pt-BR")}`, 14, y);
      y += 8;

      const addSectionTitle = (title: string) => {
        pdf.setFont("helvetica", "bold");
        pdf.setTextColor(24, 24, 27);
        pdf.setFontSize(12);
        pdf.text(title, 14, y);
        y += 6;
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(10);
        pdf.setTextColor(50, 50, 50);
      };

      const addLine = (label: string, value: string) => {
        pdf.text(`${label}: ${value}`, 16, y);
        y += 5;
      };

      addSectionTitle("Cultura e parâmetros informados");
      addLine("Cultura", form.cultura);
      addLine("Objetivo", form.objetivo || "Não informado");
      addLine("População desejada (plantas/ha)", form.populacaoHa || "0");
      addLine("Espaçamento (cm)", form.espacamentoCm || "0");
      addLine("PMS (g)", form.pms || "0");
      addLine("Germinação (%)", form.germinacao || "0");
      addLine("Pureza (%)", form.pureza || "0");
      addLine("Correção de campo (%)", form.correcaoCampo || "0");
      y += 2;

      addSectionTitle("Resultados calculados");
      addLine("Plantas por m²", formatValue(results.plantasM2));
      addLine("Sementes por m²", formatValue(results.sementesM2));
      addLine("Sementes por metro linear", formatValue(results.sementesMetro));
      addLine("kg/ha base", formatValue(results.kgHa));
      addLine("kg/ha recomendado", `${formatValue(results.kgHaFinal)} kg/ha`);
      y += 2;

      addSectionTitle("Alertas técnicos");
      getTechnicalAlerts().forEach((alert) => {
        const lines = pdf.splitTextToSize(`• ${alert}`, pageWidth - 30);
        pdf.text(lines, 16, y);
        y += lines.length * 4.5;
      });

      pdf.save(`calculo-semeadura-${new Date().toISOString().slice(0, 10)}.pdf`);
      setPdfStatus("PDF gerado com sucesso.");
    } catch {
      setPdfStatus("Não foi possível exportar o PDF neste dispositivo.");
    }
  };

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
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleExportPdf}
                className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-emerald-500"
              >
                Exportar PDF
              </button>
              <button
                type="button"
                onClick={clearForm}
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
              >
                Limpar
              </button>
            </div>
          </div>

          {pdfStatus ? <p className="mt-2 text-xs text-slate-500">{pdfStatus}</p> : null}

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
