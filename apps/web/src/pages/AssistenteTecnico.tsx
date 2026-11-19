import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  CULTURE_FALLBACKS,
  type TechnicalCulture,
  fetchTechnicalCultures,
} from "../lib/technicalCultures";
import { getApiErrorMessage } from "../lib/apiError";
import { useAuth } from "../context/AuthContext";
import {
  calculateSeeding,
  calculateVc,
  checkKgHaRange,
  cultureGoalOptions,
  cultureSeedingDefaults,
  fieldLossWarningMessage,
  formatKgHaRange,
  kgHaRangeMessage,
  parseDecimal,
  resolveKgHaRange,
  SEEDS_PER_METER_HINT,
  seedingFieldPrompts,
  seedingSummaryText,
} from "../lib/technicalAssistant";

const cardClass =
  "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6";

const helpClass = "mt-1 block text-xs text-slate-500";

// Campos numéricos como texto com teclado decimal: aceita vírgula no celular (type="number" recusa em
// alguns aparelhos) e a conta lê com parseDecimal.
const decimalInputProps = { type: "text", inputMode: "decimal", autoComplete: "off" } as const;

const inputBaseClass =
  "mt-1 w-full max-w-full rounded-lg border px-3 py-2.5 text-sm text-slate-800 shadow-sm outline-none transition focus:ring-2";

const inputClass = `${inputBaseClass} border-slate-300 focus:border-emerald-500 focus:ring-emerald-200`;

// Campo que a calculadora pede (a cultura não tem o padrão): destaque até um valor ser digitado.
const promptInputClass = `${inputBaseClass} border-amber-400 bg-amber-50 focus:border-amber-500 focus:ring-amber-200`;

const promptHelpClass = "mt-1 block text-xs font-medium text-amber-800";

type SemeaduraForm = {
  culturaId: string;
  objetivo: string;
  populacaoHa: string;
  espacamentoCm: string;
  pms: string;
  germinacao: string;
  pureza: string;
  perdaCampo: string;
};

const initialForm: SemeaduraForm = {
  culturaId: "",
  objetivo: "",
  populacaoHa: "",
  espacamentoCm: "",
  pms: "",
  germinacao: "",
  pureza: "",
  perdaCampo: "0",
};

type VcForm = {
  cultureId: string;
  pureza: string;
  germinacao: string;
  sementesDuras: string;
  considerarSementesDuras: boolean;
  doseFisica: string;
  doseSpv: string;
  lastEditedDose: "fisica" | "spv" | null;
};

const initialVcForm: VcForm = {
  cultureId: "",
  pureza: "",
  germinacao: "",
  sementesDuras: "",
  considerarSementesDuras: false,
  doseFisica: "",
  doseSpv: "",
  lastEditedDose: null,
};

const VC_STORAGE_KEY = "technical_assistant_vc_last";

function parseNumber(value: string) {
  return parseDecimal(value) ?? 0;
}

function parseOptionalNumber(value: string) {
  return parseDecimal(value);
}

function formatValue(value: number, digits = 2) {
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

const TECHNICAL_CATALOG_SETTINGS_PATH = "/configurações?section=catalogo-tecnico";

export default function AssistenteTecnico() {
  const { user } = useAuth();
  const canConfigureCatalog = user?.role === "diretor" || user?.role === "gerente";
  const [form, setForm] = useState<SemeaduraForm>(initialForm);

  const [cultures, setCultures] = useState<TechnicalCulture[]>([]);
  const [loading, setLoading] = useState(true);
  const [fallbackMessage, setFallbackMessage] = useState("");

  // VC
  const [vcForm, setVcForm] = useState<VcForm>(initialVcForm);
  const [vcMessage, setVcMessage] = useState("");

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      try {
        const data = await fetchTechnicalCultures();
        if (!mounted) return;
        setCultures((data ?? []).filter((item) => item.isActive));
      } catch (error) {
        console.error("Falha ao carregar catálogo técnico", {
          reason: getApiErrorMessage(error, "Erro ao carregar catálogo técnico."),
          error,
        });
        if (!mounted) return;

        setCultures(CULTURE_FALLBACKS);
        setFallbackMessage(
          "Não foi possível carregar as culturas agora. Mostrando uma lista reduzida; recarregue a página para tentar de novo."
        );
        toast.warning("Sem conexão com o servidor: lista reduzida de culturas.");
      } finally {
        if (mounted) setLoading(false);
      }
    };

    load();
    return () => {
      mounted = false;
    };
  }, []);

  const selectedCulture = useMemo(
    () => cultures.find((item) => item.id === form.culturaId) ?? null,
    [cultures, form.culturaId]
  );

  // Ao escolher uma cultura (inclusive a primeira, ao carregar), todos os padrões dela substituem os
  // valores da tela; a perda a campo é do usuário e fica como está.
  const applyCultureDefaults = (culture: TechnicalCulture) => {
    setForm((prev) => ({
      ...prev,
      culturaId: culture.id,
      objetivo: "",
      ...cultureSeedingDefaults(culture),
    }));
  };

  useEffect(() => {
    if (!cultures.length) return;
    if (!form.culturaId || !cultures.some((c) => c.id === form.culturaId)) {
      applyCultureDefaults(cultures[0]);
    }
  }, [cultures, form.culturaId]);

  const handleCultureChange = (cultureId: string) => {
    const culture = cultures.find((c) => c.id === cultureId);
    if (culture) applyCultureDefaults(culture);
  };

  const restoreCultureDefaults = () => {
    if (selectedCulture) applyCultureDefaults(selectedCulture);
  };

  const results = useMemo(
    () =>
      calculateSeeding({
        populationHa: parseNumber(form.populacaoHa),
        rowSpacingCm: parseNumber(form.espacamentoCm),
        pms: parseNumber(form.pms),
        germination: parseNumber(form.germinacao),
        purity: parseNumber(form.pureza),
        fieldLossPercent: parseNumber(form.perdaCampo),
      }),
    [form]
  );

  const fieldPrompts = useMemo(
    () => seedingFieldPrompts(selectedCulture, form),
    [selectedCulture, form]
  );

  const goalOptions = useMemo(
    () => cultureGoalOptions(selectedCulture?.goalsJson),
    [selectedCulture]
  );

  const referenceRange = useMemo(
    () => (selectedCulture ? resolveKgHaRange(selectedCulture, form.objetivo) : null),
    [selectedCulture, form.objetivo]
  );

  const rangeCheck = useMemo(
    () => (selectedCulture ? checkKgHaRange(results.ready ? results.kgHa : null, referenceRange) : null),
    [selectedCulture, results, referenceRange]
  );

  const selectedGoalLabel = goalOptions.find((option) => option.key === form.objetivo)?.label ?? "";

  const fieldLossMessage = fieldLossWarningMessage(results.fieldLossWarning);

  const seedingSummary = useMemo(
    () =>
      selectedCulture
        ? seedingSummaryText({
            cultureLabel: selectedCulture.label,
            goalLabel: selectedGoalLabel,
            input: {
              populationHa: parseNumber(form.populacaoHa),
              rowSpacingCm: parseNumber(form.espacamentoCm),
              pms: parseNumber(form.pms),
              germination: parseNumber(form.germinacao),
              purity: parseNumber(form.pureza),
              fieldLossPercent: parseNumber(form.perdaCampo),
            },
            result: results,
            range: referenceRange,
          })
        : "",
    [selectedCulture, selectedGoalLabel, form, results, referenceRange]
  );

  const [seedingMessage, setSeedingMessage] = useState("");

  useEffect(() => {
    setSeedingMessage("");
  }, [seedingSummary]);

  const handleCopySeeding = async () => {
    if (!seedingSummary) return;
    try {
      await navigator.clipboard.writeText(seedingSummary);
      setSeedingMessage("Resultado copiado para envio no WhatsApp.");
    } catch {
      setSeedingMessage("Não foi possível copiar automaticamente neste dispositivo.");
    }
  };

  // ======== VC (Valor Cultural) ========

  // load VC do localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(VC_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<VcForm>;

      setVcForm((prev) => ({
        ...prev,
        ...parsed,
        considerarSementesDuras: Boolean(parsed.considerarSementesDuras),
        lastEditedDose:
          parsed.lastEditedDose === "fisica" || parsed.lastEditedDose === "spv"
            ? parsed.lastEditedDose
            : null,
      }));
    } catch {
      // ignora
    }
  }, []);

  // persist VC
  useEffect(() => {
    try {
      localStorage.setItem(VC_STORAGE_KEY, JSON.stringify(vcForm));
    } catch {
      // ignora
    }
  }, [vcForm]);

  // default cultureId VC
  useEffect(() => {
    if (!cultures.length || vcForm.cultureId) return;
    setVcForm((prev) => ({ ...prev, cultureId: cultures[0].id }));
  }, [cultures, vcForm.cultureId]);

  const selectedVcCulture = useMemo(
    () => cultures.find((item) => item.id === vcForm.cultureId) ?? null,
    [cultures, vcForm.cultureId]
  );

  const handleVcCultureChange = (cultureId: string) => {
    const culture = cultures.find((c) => c.id === cultureId);

    setVcForm((prev) => ({
      ...prev,
      cultureId,
      pureza: culture?.purityDefault != null ? String(culture.purityDefault) : "",
      germinacao:
        culture?.germinationDefault != null ? String(culture.germinationDefault) : "",
    }));
  };

  const vcComputed = useMemo(() => {
    const computed = calculateVc({
      purity: parseOptionalNumber(vcForm.pureza),
      germination: parseOptionalNumber(vcForm.germinacao),
      hardSeeds: parseOptionalNumber(vcForm.sementesDuras),
      considerHardSeeds: vcForm.considerarSementesDuras,
      physicalDose: parseOptionalNumber(vcForm.doseFisica),
      spvDose: parseOptionalNumber(vcForm.doseSpv),
      lastEditedDose: vcForm.lastEditedDose,
    });
    return {
      errors: computed.errors,
      ready: computed.ready,
      vc: computed.vc,
      fatorCorrecao: computed.correctionFactor,
      germinacaoEfetiva: computed.effectiveGermination,
      doseSpvCalculada: computed.spvDose,
      doseFisicaNecessaria: computed.physicalDoseNeeded,
    };
  }, [vcForm]);

  const vcSummaryText = useMemo(() => {
    if (!vcComputed.ready || vcComputed.vc <= 0 || vcComputed.errors.length) return "";

    const p = parseNumber(vcForm.pureza);
    const gEff = vcComputed.germinacaoEfetiva;

    const physicalDose =
      vcComputed.doseFisicaNecessaria != null
        ? `${formatValue(vcComputed.doseFisicaNecessaria, 1)} kg/ha`
        : "—";

    const spvDose =
      vcComputed.doseSpvCalculada != null
        ? `${formatValue(vcComputed.doseSpvCalculada, 1)} kg/ha`
        : "—";

    return `VC = ${formatValue(vcComputed.vc, 1)}% (Pureza ${formatValue(
      p,
      1
    )}% × Germinação ${formatValue(
      gEff,
      1
    )}%). Fator de correção: ${formatValue(
      vcComputed.fatorCorrecao,
      2
    )}. Dose efetiva (SPV): ${spvDose}. Dose física necessária: ${physicalDose}.`;
  }, [vcComputed, vcForm.pureza]);

  useEffect(() => {
    if (!vcForm.doseFisica.trim() || !vcForm.doseSpv.trim()) {
      setVcMessage("");
      return;
    }

    const msg =
      vcForm.lastEditedDose === "spv"
        ? "Ambas as doses preenchidas: usando a Dose efetiva (SPV) como referência (último campo alterado)."
        : "Ambas as doses preenchidas: usando a Dose física como referência (último campo alterado).";

    setVcMessage(msg);
  }, [vcForm.doseFisica, vcForm.doseSpv, vcForm.lastEditedDose]);

  useEffect(() => {
    if (!vcComputed.ready) return;
    if (vcComputed.vc === 0 && vcForm.pureza.trim() && vcForm.germinacao.trim()) {
      setVcMessage("VC igual a 0%. Ajuste pureza e germinação para liberar as conversões de dose.");
    }
  }, [vcComputed.ready, vcComputed.vc, vcForm.germinacao, vcForm.pureza]);

  // autopreenche defaults VC quando selecionar cultura e os campos estiverem vazios
  useEffect(() => {
    if (!selectedVcCulture) return;
    if (vcForm.pureza || vcForm.germinacao) return;

    setVcForm((prev) => ({
      ...prev,
      pureza:
        selectedVcCulture.purityDefault != null
          ? String(selectedVcCulture.purityDefault)
          : prev.pureza,
      germinacao:
        selectedVcCulture.germinationDefault != null
          ? String(selectedVcCulture.germinationDefault)
          : prev.germinacao,
    }));
  }, [selectedVcCulture, vcForm.germinacao, vcForm.pureza]);

  const clearVcForm = () => {
    setVcForm(initialVcForm);
    setVcMessage("");
    try {
      localStorage.removeItem(VC_STORAGE_KEY);
    } catch {
      // ignora
    }
  };

  const handleCopyVc = async () => {
    if (!vcSummaryText) return;
    try {
      await navigator.clipboard.writeText(vcSummaryText);
      setVcMessage("Resultado copiado para envio no WhatsApp.");
    } catch {
      setVcMessage("Não foi possível copiar automaticamente neste dispositivo.");
    }
  };

  if (loading) {
    return (
      <div className="p-6 text-sm text-slate-600">
        Carregando Assistente Técnico...
      </div>
    );
  }

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">
          Assistente Técnico
        </h1>
        <p className="text-sm text-slate-600">
          Ferramentas para apoio técnico e regulagem de plantio.
        </p>
      </header>

      <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        Os resultados são estimativas de apoio e não substituem a recomendação de um engenheiro agrônomo.
      </p>

      {fallbackMessage ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {fallbackMessage}
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <article className={cardClass}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-800">
              Calculadora de Semeadura
            </h2>
            <button
              type="button"
              onClick={restoreCultureDefaults}
              disabled={!selectedCulture}
              className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Restaurar padrões
            </button>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <label className="block text-sm text-slate-700">
              Cultura
              <select
                value={form.culturaId}
                onChange={(e) => handleCultureChange(e.target.value)}
                className={inputClass}
              >
                {cultures.map((culture) => (
                  <option key={culture.id} value={culture.id}>
                    {culture.label}
                  </option>
                ))}
              </select>
            </label>

            {goalOptions.length ? (
              <label className="block text-sm text-slate-700">
                Objetivo
                <select
                  value={form.objetivo}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, objetivo: e.target.value }))
                  }
                  className={inputClass}
                >
                  <option value="">
                    Geral
                    {selectedCulture?.defaultKgHaMin != null && selectedCulture?.defaultKgHaMax != null
                      ? ` (${formatKgHaRange({ min: selectedCulture.defaultKgHaMin, max: selectedCulture.defaultKgHaMax })})`
                      : ""}
                  </option>
                  {goalOptions.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label} ({formatKgHaRange(option.range)})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="block text-sm text-slate-700">
              População desejada (plantas/ha)
              <input
                {...decimalInputProps}
                value={form.populacaoHa}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, populacaoHa: e.target.value }))
                }
                className={fieldPrompts.populacaoHa ? promptInputClass : inputClass}
              />
              {fieldPrompts.populacaoHa ? (
                <span className={promptHelpClass}>{fieldPrompts.populacaoHa}</span>
              ) : (
                <span className={helpClass}>Plantas estabelecidas por hectare.</span>
              )}
            </label>

            <label className="block text-sm text-slate-700">
              Espaçamento entre linhas (cm)
              <input
                {...decimalInputProps}
                value={form.espacamentoCm}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, espacamentoCm: e.target.value }))
                }
                className={inputClass}
              />
              <span className={helpClass}>Usado só para sementes por metro.</span>
            </label>

            <label className="block text-sm text-slate-700">
              PMS (g)
              <input
                {...decimalInputProps}
                value={form.pms}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, pms: e.target.value }))
                }
                className={fieldPrompts.pms ? promptInputClass : inputClass}
              />
              {fieldPrompts.pms ? (
                <span className={promptHelpClass}>{fieldPrompts.pms}</span>
              ) : (
                <span className={helpClass}>PMS = peso de 1.000 sementes, em gramas (do boletim do lote).</span>
              )}
            </label>

            <label className="block text-sm text-slate-700">
              Germinação (%)
              <input
                {...decimalInputProps}
                value={form.germinacao}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, germinacao: e.target.value }))
                }
                className={fieldPrompts.germinacao ? promptInputClass : inputClass}
              />
              {fieldPrompts.germinacao ? (
                <span className={promptHelpClass}>{fieldPrompts.germinacao}</span>
              ) : (
                <span className={helpClass}>Do boletim de análise do lote.</span>
              )}
            </label>

            <label className="block text-sm text-slate-700">
              Pureza (%)
              <input
                {...decimalInputProps}
                value={form.pureza}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, pureza: e.target.value }))
                }
                className={fieldPrompts.pureza ? promptInputClass : inputClass}
              />
              {fieldPrompts.pureza ? (
                <span className={promptHelpClass}>{fieldPrompts.pureza}</span>
              ) : (
                <span className={helpClass}>Do boletim de análise do lote.</span>
              )}
            </label>

            <label className="block text-sm text-slate-700">
              Perda a campo (%)
              <input
                {...decimalInputProps}
                value={form.perdaCampo}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, perdaCampo: e.target.value }))
                }
                className={inputClass}
              />
              <span className={helpClass}>Sementes que não viram planta (falha de emergência, pragas, pássaros). Ex.: 20% → semeia 25% a mais. Máximo 50%.</span>
            </label>
          </div>

          {fieldLossMessage ? (
            <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {fieldLossMessage}
            </p>
          ) : null}

          <div className="mt-5 grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs uppercase text-slate-500">Plantas por m²</p>
              <p className="text-lg font-semibold">
                {formatValue(results.plantsM2)}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase text-slate-500">Sementes por m²</p>
              <p className="text-lg font-semibold">
                {results.ready ? formatValue(results.seedsM2) : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase text-slate-500">Sementes por metro</p>
              <p className="text-lg font-semibold">
                {results.seedsPerMeter != null ? formatValue(results.seedsPerMeter) : "—"}
              </p>
              {results.ready && results.seedsPerMeter == null ? (
                <p className="text-xs text-slate-500">{SEEDS_PER_METER_HINT}</p>
              ) : null}
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 sm:col-span-2 lg:col-span-1">
              <p className="text-xs uppercase text-emerald-700">
                kg/ha recomendado
              </p>
              <p className="mt-1 text-2xl font-bold leading-tight text-emerald-700 sm:text-3xl">
                {results.ready ? formatValue(results.kgHa) : "—"}
              </p>
              <p className="text-sm font-semibold text-emerald-700">kg/ha</p>
            </div>
            {results.ready && results.fieldLossApplied > 0 ? (
              <div className="rounded-lg border border-slate-200 bg-white p-3 sm:col-span-2 lg:col-span-1">
                <p className="text-xs uppercase text-slate-500">Sem perda a campo</p>
                <p className="text-lg font-semibold text-slate-900">
                  {formatValue(results.kgHaBase)} kg/ha
                </p>
              </div>
            ) : null}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCopySeeding}
              disabled={!seedingSummary}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Copiar resultado
            </button>
            {seedingMessage ? <span className="text-sm text-slate-600">{seedingMessage}</span> : null}
          </div>

          {rangeCheck ? (
            <p
              role={rangeCheck.status === "below" || rangeCheck.status === "above" ? "alert" : undefined}
              className={`mt-4 rounded-lg border px-3 py-2 text-sm ${
                rangeCheck.status === "within"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : rangeCheck.status === "no_range"
                    ? "border-slate-200 bg-slate-50 text-slate-700"
                    : "border-amber-300 bg-amber-50 text-amber-900"
              }`}
            >
              {kgHaRangeMessage(rangeCheck)}
              {rangeCheck.status === "no_range" && canConfigureCatalog ? (
                <>
                  {" "}
                  <Link to={TECHNICAL_CATALOG_SETTINGS_PATH} className="font-medium underline">
                    Cadastrar em Configurações → Catálogo Técnico
                  </Link>
                </>
              ) : null}
            </p>
          ) : null}
        </article>

        <article className={cardClass}>
          <h2 className="text-base font-semibold text-slate-800">
            Indicação rápida kg/ha
          </h2>

          <p className="mt-2 text-sm text-slate-600">
            {selectedCulture?.label || "Selecione uma cultura"}
          </p>

          {referenceRange ? (
            <>
              <p className="mt-3 text-2xl font-bold text-slate-900">
                {formatKgHaRange(referenceRange)}
              </p>
              {selectedGoalLabel ? (
                <p className="text-xs text-slate-500">Objetivo: {selectedGoalLabel}</p>
              ) : null}
            </>
          ) : (
            <p className="mt-3 text-sm font-medium text-slate-700">
              Sem faixa de referência cadastrada.
              {canConfigureCatalog ? (
                <>
                  {" "}
                  <Link to={TECHNICAL_CATALOG_SETTINGS_PATH} className="text-emerald-700 underline">
                    Cadastrar em Configurações
                  </Link>
                </>
              ) : null}
            </p>
          )}

          <p className="mt-2 text-sm text-slate-600">
            {selectedCulture?.notes || "Sem observações cadastradas."}
          </p>

          <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            Categoria: {selectedCulture?.category || "—"}
          </p>
        </article>
      </div>

      {/* ===== VC ===== */}
      <article className={cardClass}>
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-800">
              Valor Cultural (VC)
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Calcule a eficiência do lote e converta entre Dose física e Dose efetiva (SPV).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCopyVc}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-emerald-500"
            >
              Copiar resultado
            </button>
            <button
              type="button"
              onClick={clearVcForm}
              className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Limpar
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <label className="block text-sm text-slate-700">
            Cultura (opcional)
            <select
              value={vcForm.cultureId}
              onChange={(event) => handleVcCultureChange(event.target.value)}
              className={inputClass}
            >
              <option value="">Selecione</option>
              {cultures.map((c) => (
                <option key={`vc-${c.id}`} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm text-slate-700">
            Pureza (%)
            <input
              {...decimalInputProps}
              value={vcForm.pureza}
              onChange={(event) =>
                setVcForm((prev) => ({ ...prev, pureza: event.target.value }))
              }
              className={inputClass}
            />
          </label>

          <label className="block text-sm text-slate-700">
            Germinação (%)
            <input
              {...decimalInputProps}
              value={vcForm.germinacao}
              onChange={(event) =>
                setVcForm((prev) => ({ ...prev, germinacao: event.target.value }))
              }
              className={inputClass}
            />
          </label>

          <label className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={vcForm.considerarSementesDuras}
              onChange={(event) =>
                setVcForm((prev) => ({
                  ...prev,
                  considerarSementesDuras: event.target.checked,
                }))
              }
            />
            Considerar sementes duras na germinação
          </label>

          <label className="block text-sm text-slate-700">
            Sementes duras (%)
            <input
              {...decimalInputProps}
              disabled={!vcForm.considerarSementesDuras}
              value={vcForm.sementesDuras}
              onChange={(event) =>
                setVcForm((prev) => ({ ...prev, sementesDuras: event.target.value }))
              }
              className={inputClass}
            />
          </label>

          <label className="block text-sm text-slate-700">
            Dose física (kg/ha)
            <input
              {...decimalInputProps}
              value={vcForm.doseFisica}
              onChange={(event) =>
                setVcForm((prev) => ({
                  ...prev,
                  doseFisica: event.target.value,
                  lastEditedDose: "fisica",
                }))
              }
              className={inputClass}
            />
          </label>

          <label className="block text-sm text-slate-700">
            Dose efetiva (SPV) desejada (kg/ha)
            <input
              {...decimalInputProps}
              value={vcForm.doseSpv}
              onChange={(event) =>
                setVcForm((prev) => ({
                  ...prev,
                  doseSpv: event.target.value,
                  lastEditedDose: "spv",
                }))
              }
              className={inputClass}
            />
          </label>
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          <p>
            <strong>VC</strong> = Pureza × Germinação (ou Germinação + Sementes duras, se marcado).
          </p>
          <p>
            <strong>Fator de correção</strong> = 100 / VC (quanto multiplicar para corrigir dose pela qualidade do lote).
          </p>
          <p className="mt-2 text-xs text-slate-500">
            * VC corrige a dose pela qualidade do lote (pureza e germinação).
          </p>
        </div>

        {!vcForm.pureza.trim() || !vcForm.germinacao.trim() ? (
          <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Preencha pureza e germinação para calcular VC.
          </p>
        ) : null}

        {vcComputed.errors.length ? (
          <div className="mt-4 space-y-2">
            {vcComputed.errors.map((error) => (
              <p
                key={error}
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
              >
                {error}
              </p>
            ))}
          </div>
        ) : null}

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
            <p className="text-xs uppercase tracking-wide text-emerald-700">
              VC (%)
            </p>
            <p className="mt-1 text-3xl font-bold text-emerald-700">
              {formatValue(vcComputed.vc, 1)}%
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Fator de correção
            </p>
            <p className="mt-1 text-lg font-semibold text-slate-900">
              {vcComputed.vc > 0 ? formatValue(vcComputed.fatorCorrecao, 2) : "—"}
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Dose efetiva (SPV)
            </p>
            <p className="mt-1 text-lg font-semibold text-slate-900">
              {vcComputed.vc > 0 && vcComputed.doseSpvCalculada != null
                ? `${formatValue(vcComputed.doseSpvCalculada, 1)} kg/ha`
                : "—"}
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Dose física necessária
            </p>
            <p className="mt-1 text-lg font-semibold text-slate-900">
              {vcComputed.vc > 0 && vcComputed.doseFisicaNecessaria != null
                ? `${formatValue(vcComputed.doseFisicaNecessaria, 1)} kg/ha`
                : "—"}
            </p>
          </div>
        </div>

        {vcComputed.ready && vcComputed.vc === 0 ? (
          <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            VC igual a 0%. Ajuste pureza e germinação para liberar as conversões de dose.
          </p>
        ) : null}

        {vcMessage ? (
          <p className="mt-4 text-sm text-slate-600">{vcMessage}</p>
        ) : null}

        {selectedVcCulture ? (
          <p className="mt-4 text-xs text-slate-500">
            Cultura selecionada: <strong>{selectedVcCulture.label}</strong>
          </p>
        ) : null}
      </article>
    </section>
  );
}
