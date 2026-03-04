import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CULTURE_FALLBACKS,
  type TechnicalCulture,
  fetchTechnicalCultures,
} from "../lib/technicalCultures";
import { getApiErrorMessage } from "../lib/apiError";

const cardClass =
  "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm";

const inputClass =
  "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200";

type SemeaduraForm = {
  culturaId: string;
  objetivo: string;
  populacaoHa: string;
  espacamentoCm: string;
  pms: string;
  germinacao: string;
  pureza: string;
  correcaoCampo: string;
};

const initialForm: SemeaduraForm = {
  culturaId: "",
  objetivo: "",
  populacaoHa: "",
  espacamentoCm: "",
  pms: "",
  germinacao: "",
  pureza: "",
  correcaoCampo: "0",
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
  const normalized = (value ?? "").replace(",", ".").trim();
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function parseOptionalNumber(value: string) {
  if (!value?.trim()) return null;
  const num = parseNumber(value);
  return Number.isFinite(num) ? num : null;
}

function formatValue(value: number, digits = 2) {
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export default function AssistenteTecnico() {
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
          "Não foi possível carregar o catálogo da API. Exibindo catálogo local temporário."
        );
        toast.warning("Catálogo temporário ativo. Verifique conexão com a API.");
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

  // define cultura default quando carregar
  useEffect(() => {
    if (!cultures.length) return;

    if (!form.culturaId || !cultures.some((c) => c.id === form.culturaId)) {
      const first = cultures[0];
      setForm((prev) => ({ ...prev, culturaId: first.id }));
    }
  }, [cultures, form.culturaId]);

  // autopreenche defaults da cultura na semeadura (só se campo estiver vazio)
  useEffect(() => {
    if (!selectedCulture) return;

    setForm((prev) => ({
      ...prev,
      populacaoHa:
        prev.populacaoHa ||
        (selectedCulture.populationTargetDefault != null
          ? String(selectedCulture.populationTargetDefault)
          : ""),
      espacamentoCm:
        prev.espacamentoCm ||
        (selectedCulture.rowSpacingCmDefault != null
          ? String(selectedCulture.rowSpacingCmDefault)
          : ""),
      pms:
        prev.pms ||
        (selectedCulture.pmsDefault != null ? String(selectedCulture.pmsDefault) : ""),
      germinacao:
        prev.germinacao ||
        (selectedCulture.germinationDefault != null
          ? String(selectedCulture.germinationDefault)
          : ""),
      pureza:
        prev.pureza ||
        (selectedCulture.purityDefault != null
          ? String(selectedCulture.purityDefault)
          : ""),
    }));
  }, [selectedCulture]);

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
      };
    }

    const sementesM2 = plantasM2 / fator;
    const sementesMetro = sementesM2 * (espacamentoCm / 100);

    // Mantido conforme seu cálculo atual (evita mudança de comportamento)
    const kgHa = (sementesM2 * pms) / 1000;

    return {
      plantasM2,
      sementesM2,
      sementesMetro,
      kgHa,
      kgHaFinal: kgHa * (1 + correcaoCampo / 100),
    };
  }, [form]);

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
    const pureza = parseOptionalNumber(vcForm.pureza);
    const germinacao = parseOptionalNumber(vcForm.germinacao);
    const sementesDuras = parseOptionalNumber(vcForm.sementesDuras) ?? 0;

    const doseFisica = parseOptionalNumber(vcForm.doseFisica);
    const doseSpv = parseOptionalNumber(vcForm.doseSpv);

    const errors: string[] = [];

    if (pureza != null && (pureza < 0 || pureza > 100))
      errors.push("Pureza deve estar entre 0 e 100%.");

    if (germinacao != null && (germinacao < 0 || germinacao > 100))
      errors.push("Germinação deve estar entre 0 e 100%.");

    if (vcForm.considerarSementesDuras && (sementesDuras < 0 || sementesDuras > 100))
      errors.push("Sementes duras deve estar entre 0 e 100%.");

    if ((doseFisica != null && doseFisica < 0) || (doseSpv != null && doseSpv < 0))
      errors.push("As doses devem ser valores iguais ou maiores que zero.");

    if (pureza == null || germinacao == null) {
      return {
        errors,
        ready: false,
        vc: 0,
        fatorCorrecao: 0,
        germinacaoEfetiva: 0,
        doseSpvCalculada: null as number | null,
        doseFisicaNecessaria: null as number | null,
      };
    }

    const germinacaoEfetiva = vcForm.considerarSementesDuras
      ? Math.min(100, germinacao + sementesDuras)
      : germinacao;

    const vc = (pureza * germinacaoEfetiva) / 100;
    const fatorCorrecao = vc > 0 ? 100 / vc : 0;

    // regra: se os dois preenchidos, usa o último editado como referência
    const ambosPreenchidos = doseFisica != null && doseSpv != null;
    const usarSpvComoFonte = ambosPreenchidos && vcForm.lastEditedDose === "spv";
    const usarFisicaComoFonte = ambosPreenchidos && vcForm.lastEditedDose !== "spv";

    const doseFisicaBase = usarSpvComoFonte ? null : doseFisica;
    const doseSpvBase = usarFisicaComoFonte ? null : doseSpv;

    const doseSpvCalculada = doseFisicaBase != null ? doseFisicaBase * (vc / 100) : null;
    const doseFisicaNecessaria =
      doseSpvBase != null && vc > 0 ? doseSpvBase / (vc / 100) : null;

    return {
      errors,
      ready: true,
      vc,
      fatorCorrecao,
      germinacaoEfetiva,
      doseSpvCalculada,
      doseFisicaNecessaria,
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

      {fallbackMessage ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {fallbackMessage}
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <article className={cardClass}>
          <h2 className="text-base font-semibold text-slate-800">
            Calculadora de Semeadura
          </h2>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="block text-sm text-slate-700">
              Cultura
              <select
                value={form.culturaId}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, culturaId: e.target.value }))
                }
                className={inputClass}
              >
                {cultures.map((culture) => (
                  <option key={culture.id} value={culture.id}>
                    {culture.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm text-slate-700">
              Objetivo (opcional)
              <input
                value={form.objetivo}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, objetivo: e.target.value }))
                }
                className={inputClass}
              />
            </label>

            <label className="block text-sm text-slate-700">
              População desejada (plantas/ha)
              <input
                value={form.populacaoHa}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, populacaoHa: e.target.value }))
                }
                className={inputClass}
              />
            </label>

            <label className="block text-sm text-slate-700">
              Espaçamento (cm)
              <input
                value={form.espacamentoCm}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, espacamentoCm: e.target.value }))
                }
                className={inputClass}
              />
            </label>

            <label className="block text-sm text-slate-700">
              PMS (g)
              <input
                value={form.pms}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, pms: e.target.value }))
                }
                className={inputClass}
              />
            </label>

            <label className="block text-sm text-slate-700">
              Germinação (%)
              <input
                value={form.germinacao}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, germinacao: e.target.value }))
                }
                className={inputClass}
              />
            </label>

            <label className="block text-sm text-slate-700">
              Pureza (%)
              <input
                value={form.pureza}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, pureza: e.target.value }))
                }
                className={inputClass}
              />
            </label>

            <label className="block text-sm text-slate-700">
              Correção de campo (%)
              <input
                value={form.correcaoCampo}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, correcaoCampo: e.target.value }))
                }
                className={inputClass}
              />
            </label>
          </div>

          <div className="mt-5 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase text-slate-500">Plantas por m²</p>
              <p className="text-lg font-semibold">
                {formatValue(results.plantasM2)}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase text-slate-500">Sementes por m²</p>
              <p className="text-lg font-semibold">
                {formatValue(results.sementesM2)}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase text-slate-500">Sementes por metro</p>
              <p className="text-lg font-semibold">
                {formatValue(results.sementesMetro)}
              </p>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <p className="text-xs uppercase text-emerald-700">
                kg/ha recomendado
              </p>
              <p className="text-2xl font-bold text-emerald-700">
                {formatValue(results.kgHaFinal)} kg/ha
              </p>
            </div>
          </div>
        </article>

        <article className={cardClass}>
          <h2 className="text-base font-semibold text-slate-800">
            Indicação rápida kg/ha
          </h2>

          <p className="mt-2 text-sm text-slate-600">
            {selectedCulture?.label || "Selecione uma cultura"}
          </p>

          {selectedCulture?.defaultKgHaMin != null &&
          selectedCulture?.defaultKgHaMax != null ? (
            <p className="mt-3 text-2xl font-bold text-slate-900">
              {formatValue(selectedCulture.defaultKgHaMin, 0)}–
              {formatValue(selectedCulture.defaultKgHaMax, 0)} kg/ha
            </p>
          ) : (
            <p className="mt-3 text-sm font-medium text-amber-700">
              Não configurado — ajuste em Configurações.
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

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
              type="number"
              min="0"
              max="100"
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
              type="number"
              min="0"
              max="100"
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
              type="number"
              min="0"
              max="100"
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
              type="number"
              min="0"
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

          <label className="block text-sm text-slate-700 xl:col-span-2">
            Dose efetiva (SPV) desejada (kg/ha)
            <input
              type="number"
              min="0"
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
            * VC é correção de qualidade do lote; não substitui recomendação agronômica.
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

        <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
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
