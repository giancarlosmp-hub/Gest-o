import { useEffect, useMemo, useState } from "react";
import { culturesKgHa, type CultureKgHa } from "../data/culturesKgHa";

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

const CULTURES_OVERRIDE_KEY = "culturesKgHaOverrides";

type AlertSeverity = "warning" | "critical";

type TechnicalAlert = {
  message: string;
  severity: AlertSeverity;
};


const sanitizeCulture = (item: CultureKgHa): CultureKgHa => ({
  ...item,
  kgHaMin: item.kgHaMin == null ? null : Math.max(0, item.kgHaMin),
  kgHaMax: item.kgHaMax == null ? null : Math.max(0, item.kgHaMax),
  notes: item.notes?.trim() || undefined,
});

const parseStoredCultures = (rawValue: string | null) => {
  if (!rawValue) return null;
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return null;
    return parsed as CultureKgHa[];
  } catch {
    return null;
  }
};

const buildRangeLabel = (min: number | null, max: number | null) => {
  if (min == null || max == null) return "—";
  return `${formatValue(min, 0)}–${formatValue(max, 0)} kg/ha`;
};

export default function AssistenteTecnico() {
  /** Calculadora */
  const [form, setForm] = useState<SemeaduraForm>(initialForm);
  const [pdfStatus, setPdfStatus] = useState("");
  const [cultureItems, setCultureItems] = useState<CultureKgHa[]>([]);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editSearch, setEditSearch] = useState("");
  const [editGroupFilter, setEditGroupFilter] = useState("todos");
  const [recommendationWarning, setRecommendationWarning] = useState("");

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

  const alerts = useMemo<TechnicalAlert[]>(() => {
    const germinacao = parseNumber(form.germinacao);
    const pureza = parseNumber(form.pureza);
    const espacamentoCm = parseNumber(form.espacamentoCm);
    const alertsList: TechnicalAlert[] = [];

    if (germinacao > 0 && germinacao < 80) {
      alertsList.push({
        message: "Germinação baixa. Recomenda-se aumentar a correção.",
        severity: "warning"
      });
    }

    if (pureza > 0 && pureza < 90) {
      alertsList.push({
        message: "Pureza abaixo do ideal. Revisar lote.",
        severity: "warning"
      });
    }

    if (results.sementesMetro > 25) {
      alertsList.push({
        message: "Densidade elevada. Confirmar regulagem da plantadeira.",
        severity: "warning"
      });
    }

    if (espacamentoCm > 0 && (espacamentoCm < 15 || espacamentoCm > 80)) {
      alertsList.push({
        message: "Espaçamento fora da faixa usual. Conferir configuração de semeadura.",
        severity: "warning"
      });
    }

    const cultureData = cultureItems.find((culture) => culture.active && culture.name === form.cultura);
    if (cultureData && cultureData.kgHaMin != null && cultureData.kgHaMax != null) {
      const averageKgHa = (cultureData.kgHaMin + cultureData.kgHaMax) / 2;
      if (results.kgHaFinal > averageKgHa * 1.2) {
        alertsList.push({
          message: "Dose acima da recomendação média.",
          severity: "critical"
        });
      }
    }

    return alertsList;
  }, [cultureItems, form, results.kgHaFinal, results.sementesMetro]);

  useEffect(() => {
    const stored = parseStoredCultures(localStorage.getItem(CULTURES_OVERRIDE_KEY));
    if (stored) {
      setCultureItems(stored.map(sanitizeCulture));
      return;
    }
    setCultureItems(culturesKgHa.map(sanitizeCulture));
  }, []);

  const activeCultures = useMemo(() => cultureItems.filter((item) => item.active), [cultureItems]);
  const culturas = useMemo(() => activeCultures.map((item) => item.name), [activeCultures]);
  const groupedOptions = useMemo(() => {
    return activeCultures.reduce<Record<string, CultureKgHa[]>>((acc, item) => {
      if (!acc[item.group]) acc[item.group] = [];
      acc[item.group].push(item);
      return acc;
    }, {});
  }, [activeCultures]);

  useEffect(() => {
    if (!culturas.length) return;
    if (!culturas.includes(form.cultura)) {
      setForm((prev) => ({ ...prev, cultura: culturas[0] }));
    }
  }, [culturas, form.cultura]);

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

  const selectedCultureData = useMemo(
    () => activeCultures.find((item) => item.id === selectedCulture) ?? null,
    [activeCultures, selectedCulture]
  );

  useEffect(() => {
    if (!activeCultures.length || selectedCulture) return;
    setSelectedCulture(activeCultures[0].id);
  }, [activeCultures, selectedCulture]);

  const editGroups = useMemo(() => ["todos", ...new Set(cultureItems.map((item) => item.group))], [cultureItems]);

  const filteredEditItems = useMemo(() => {
    return cultureItems.filter((item) => {
      const matchSearch = item.name.toLowerCase().includes(editSearch.toLowerCase());
      const matchGroup = editGroupFilter === "todos" || item.group === editGroupFilter;
      return matchSearch && matchGroup;
    });
  }, [cultureItems, editGroupFilter, editSearch]);

  const updateCultureItem = (id: string, field: keyof CultureKgHa, value: string | boolean) => {
    setCultureItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;

        if (field === "kgHaMin" || field === "kgHaMax") {
          if (value === "") return { ...item, [field]: null };
          const numberValue = Number(value);
          if (!Number.isFinite(numberValue)) return item;
          return { ...item, [field]: Math.max(0, numberValue) };
        }

        if (field === "active") {
          return { ...item, active: Boolean(value) };
        }

        return { ...item, [field]: value };
      })
    );
  };

  const saveOverrides = () => {
    const sanitized = cultureItems.map(sanitizeCulture);
    const hasInvalidRange = sanitized.some(
      (item) => item.kgHaMin != null && item.kgHaMax != null && item.kgHaMin > item.kgHaMax
    );

    if (hasInvalidRange) {
      setRecommendationWarning("Existem faixas com mínimo maior que o máximo. Revise antes de salvar.");
      return;
    }

    setCultureItems(sanitized);
    localStorage.setItem(CULTURES_OVERRIDE_KEY, JSON.stringify(sanitized));
    setRecommendationWarning("");
    setShowEditModal(false);
  };

  const restoreDefaults = () => {
    const defaults = culturesKgHa.map(sanitizeCulture);
    setCultureItems(defaults);
    localStorage.removeItem(CULTURES_OVERRIDE_KEY);
    setRecommendationWarning("");
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

          {alerts.length ? (
            <div className="mt-4 space-y-2">
              {alerts.map((alert) => {
                const alertClass =
                  alert.severity === "critical"
                    ? "border-red-200 bg-red-50 text-red-800"
                    : "border-amber-200 bg-amber-50 text-amber-800";

                return (
                  <p key={`${alert.severity}-${alert.message}`} className={`rounded-lg border px-3 py-2 text-sm ${alertClass}`}>
                    {alert.message}
                  </p>
                );
              })}
            </div>
          ) : null}

          <details className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
            <summary className="cursor-pointer list-none text-sm font-semibold text-slate-800 marker:content-none">
              Entenda o cálculo
            </summary>

            <div className="mt-3 space-y-3 text-sm text-slate-600">
              <div>
                <p className="font-medium text-slate-800">O que é PMS</p>
                <p>
                  PMS é o Peso de Mil Sementes, medido em gramas. Esse valor representa o tamanho e a massa do lote e permite converter
                  quantidade de sementes em kg/ha. Quanto maior o PMS, maior tende a ser a dose em peso para atingir a mesma população.
                </p>
              </div>

              <div>
                <p className="font-medium text-slate-800">O que é germinação</p>
                <p>
                  Germinação é o percentual de sementes que formam plântulas normais em teste de laboratório. Ela indica o potencial
                  mínimo de estabelecimento e entra diretamente no cálculo da quantidade de sementes necessária por área.
                </p>
              </div>

              <div>
                <p className="font-medium text-slate-800">O que é pureza</p>
                <p>
                  Pureza é a fração do lote que realmente corresponde à semente da cultura (sem impurezas, materiais inertes ou sementes
                  de outras espécies). Se a pureza é menor, é preciso distribuir mais material para obter o mesmo número de sementes úteis.
                </p>
              </div>

              <div>
                <p className="font-medium text-slate-800">Como funciona a correção</p>
                <p>
                  O sistema calcula a população-alvo por m² e corrige as sementes necessárias usando o fator germinação × pureza. Em
                  seguida, converte para sementes por metro linear e para kg/ha com base no PMS. A correção de campo é aplicada no final
                  como margem operacional para perdas de semeadura e variações reais do talhão.
                </p>
              </div>

              <div>
                <p className="font-medium text-slate-800">Fatores que influenciam a emergência</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  <li>Vigor da semente e qualidade do lote.</li>
                  <li>Profundidade e uniformidade de deposição.</li>
                  <li>Umidade do solo no momento da semeadura.</li>
                  <li>Temperatura do solo e ocorrência de estresse térmico.</li>
                  <li>Compactação, encrostamento e presença de palhada.</li>
                  <li>Regulagem da plantadeira e velocidade de operação.</li>
                </ul>
              </div>

              <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p>1) plantas/m² = plantas/ha ÷ 10.000</p>
                <p>2) fator = (germinação ÷ 100) × (pureza ÷ 100)</p>
                <p>3) sementes/m² = plantas/m² ÷ fator</p>
                <p>4) sementes/metro = sementes/m² × (espaçamento cm ÷ 100)</p>
                <p>5) kg/ha = (sementes/m² × PMS) ÷ 1.000</p>
                <p>6) kg/ha final = kg/ha × (1 + correção ÷ 100)</p>
              </div>
            </div>
          </details>
        </article>

        {/* INDICAÇÃO RÁPIDA */}
        <article className={cardClass}>
          <h2 className="text-base font-semibold text-slate-800">Indicação rápida de kg/ha</h2>
          <p className="mt-1 text-sm text-slate-500">Selecione a cultura para consultar a faixa recomendada de forma rápida.</p>

          <div className="mt-4 grid gap-4">
            <label className="space-y-1 text-sm">
              <span className="font-medium text-slate-700">Cultura</span>
              <select
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
                value={selectedCulture}
                onChange={(event) => {
                  setSelectedCulture(event.target.value);
                  setRecommendationWarning("");
                }}
              >
                <option value="">Selecione</option>
                {Object.entries(groupedOptions).map(([group, items]) => (
                  <optgroup key={group} label={group}>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>

            <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-700">
                <span className="font-semibold">Faixa recomendada (kg/ha):</span>{" "}
                {selectedCultureData ? buildRangeLabel(selectedCultureData.kgHaMin, selectedCultureData.kgHaMax) : "—"}
              </p>

              <p className="text-sm text-slate-700">
                <span className="font-semibold">Observações:</span>{" "}
                {selectedCultureData?.notes || "—"}
              </p>

              {selectedCultureData && (selectedCultureData.kgHaMin == null || selectedCultureData.kgHaMax == null) ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Faixa incompleta para esta cultura. Ajuste na edição para mostrar o intervalo completo.
                </p>
              ) : null}

              {recommendationWarning ? <p className="text-xs text-amber-700">{recommendationWarning}</p> : null}

              <button
                type="button"
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
                onClick={() => setShowEditModal(true)}
              >
                Editar recomendações
              </button>
            </div>
          </div>
        </article>
      </div>

      {showEditModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-4xl rounded-xl bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-lg font-semibold text-slate-800">Editar recomendações</h3>
              <button type="button" className="rounded border px-3 py-1 text-sm" onClick={() => setShowEditModal(false)}>Fechar</button>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <input
                className={inputClass}
                placeholder="Buscar cultura"
                value={editSearch}
                onChange={(event) => setEditSearch(event.target.value)}
              />
              <select className={inputClass} value={editGroupFilter} onChange={(event) => setEditGroupFilter(event.target.value)}>
                {editGroups.map((group) => (
                  <option key={group} value={group}>
                    {group === "todos" ? "Todos os grupos" : group}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-4 max-h-80 overflow-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-slate-500">
                    <th className="py-2">Nome</th>
                    <th>kg/ha mín</th>
                    <th>kg/ha máx</th>
                    <th>Ativo</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEditItems.map((item) => (
                    <tr key={item.id} className="border-b border-slate-100">
                      <td className="py-2">{item.name}</td>
                      <td>
                        <input
                          type="number"
                          min="0"
                          value={item.kgHaMin ?? ""}
                          onChange={(event) => updateCultureItem(item.id, "kgHaMin", event.target.value)}
                          className="w-24 rounded border border-slate-300 px-2 py-1"
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min="0"
                          value={item.kgHaMax ?? ""}
                          onChange={(event) => updateCultureItem(item.id, "kgHaMax", event.target.value)}
                          className="w-24 rounded border border-slate-300 px-2 py-1"
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={item.active}
                          onChange={(event) => updateCultureItem(item.id, "active", event.target.checked)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="rounded border border-slate-300 px-3 py-2 text-sm"
                onClick={restoreDefaults}
              >
                Restaurar padrão
              </button>
              <button
                type="button"
                className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white"
                onClick={saveOverrides}
              >
                Salvar alterações
              </button>
            </div>
          </div>
        </div>
      ) : null}

    </section>
  );
}
