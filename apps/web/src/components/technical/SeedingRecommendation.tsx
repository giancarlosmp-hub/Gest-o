import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { TechnicalCulture } from "../../lib/technicalCultures";
import { cultureGoalOptions, formatKgHaRange, kgHaRangeMessage } from "../../lib/technicalAssistant";
import {
  CONFORMITY_TERM_HINT,
  EMPTY_RECOMMENDATION_FORM,
  FORAGE_ANALYSIS_LABEL,
  FORAGE_VC_FORMULA,
  FORAGE_VIABILITY_NOTE,
  ORIGIN_LABEL,
  SPACING_OPTIONS_CM,
  type ForageAnalysis,
  type RecommendationForm,
  type RecommendationMode,
  type UsedValue,
  formatNumber,
  formatSeedsPerMeter,
  germinationFieldLabel,
  germinationTerm,
  hardSeedsApply,
  isForageCulture,
  readStoredMode,
  seedingRecommendation,
  seedingRecommendationText,
  storeMode,
  whatsappShareUrl,
} from "../../lib/seedingRecommendation";

type Props = {
  cultures: TechnicalCulture[];
  /** Lista reduzida sem conexão: germinação, pureza e PMS do catálogo não entram. */
  offline: boolean;
  /** Diretor e gerente: link para cadastrar a faixa no Catálogo Técnico. */
  canConfigureCatalog: boolean;
};

export const TECHNICAL_CATALOG_SETTINGS_PATH = "/configurações?section=catalogo-tecnico";

const inputClass =
  "mt-1 w-full max-w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-800 shadow-sm outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200";

const chipBaseClass = "min-h-11 rounded-lg border px-3 text-sm font-medium transition";
const chipClass = (active: boolean) =>
  `${chipBaseClass} ${active ? "border-emerald-600 bg-emerald-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"}`;

const decimalInputProps = { type: "text", inputMode: "decimal", autoComplete: "off" } as const;

function OriginBadge({ used }: { used: UsedValue }) {
  if (!used) return null;
  return (
    <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
      {ORIGIN_LABEL[used.origin]}
    </span>
  );
}

function ResultRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-emerald-100 py-2 text-sm">
      <span className="text-slate-600">{label}</span>
      <span className="text-right font-semibold text-slate-900">{children}</span>
    </div>
  );
}

function NumberField(props: { label: string; value: string; placeholder: string; hint?: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-sm text-slate-700">
      {props.label}
      <input
        {...decimalInputProps}
        placeholder={props.placeholder}
        className={inputClass}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.hint ? <span className="mt-1 block text-xs text-slate-500">{props.hint}</span> : null}
    </label>
  );
}

function spacingFromCulture(culture: TechnicalCulture | null) {
  const value = culture?.rowSpacingCmDefault;
  if (value == null || !(value > 0)) return { spacingCm: "", other: false };
  const isPreset = (SPACING_OPTIONS_CM as readonly number[]).includes(value);
  return { spacingCm: formatNumber(value, 1), other: !isPreset };
}

const formFor = (culture: TechnicalCulture | null, fieldLoss = EMPTY_RECOMMENDATION_FORM.fieldLoss): RecommendationForm => ({
  ...EMPTY_RECOMMENDATION_FORM,
  fieldLoss,
  spacingCm: spacingFromCulture(culture).spacingCm,
});

/** "Germinação" ou "Germinação ou viabilidade" (forrageira), com inicial maiúscula. */
const germinationLabelText = (forage: boolean) => {
  const term = germinationTerm(forage);
  return term.charAt(0).toUpperCase() + term.slice(1);
};

const defaultPlaceholder = (value: number | null, prefix: string, unit: string, digits: number, fallback: string) =>
  value != null && value > 0 ? `${prefix}: ${formatNumber(value, digits)}${unit}` : fallback;

export default function SeedingRecommendation({ cultures, offline, canConfigureCatalog }: Props) {
  // Começa na primeira cultura da lista; se a lista chegar depois, o efeito abaixo escolhe.
  const [initial] = useState(() => {
    const first = cultures[0] ?? null;
    return { cultureId: first?.id ?? "", form: formFor(first), other: spacingFromCulture(first).other };
  });
  const [cultureId, setCultureId] = useState(initial.cultureId);
  const [form, setForm] = useState<RecommendationForm>(initial.form);
  const [otherSpacing, setOtherSpacing] = useState(initial.other);
  const [mode, setMode] = useState<RecommendationMode>(readStoredMode);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [message, setMessage] = useState("");

  const culture = cultures.find((item) => item.id === cultureId) ?? null;
  const complete = mode === "complete";
  const forage = culture ? isForageCulture(culture) : false;

  const setField = <K extends keyof RecommendationForm>(key: K, value: RecommendationForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // Trocar de cultura limpa o que foi digitado e volta ao espaçamento padrão dela; a perda fica.
  const selectCulture = (next: TechnicalCulture | null) => {
    setCultureId(next?.id ?? "");
    setForm((prev) => formFor(next, prev.fieldLoss));
    setOtherSpacing(spacingFromCulture(next).other);
  };

  const clearForm = () => {
    setForm(formFor(culture));
    setOtherSpacing(spacingFromCulture(culture).other);
  };

  const changeMode = (next: RecommendationMode) => {
    setMode(next);
    storeMode(next);
  };

  useEffect(() => {
    if (!cultures.length) return;
    if (!cultures.some((item) => item.id === cultureId)) selectCulture(cultures[0]);
  }, [cultures, cultureId]);

  const rec = useMemo(
    () => (culture ? seedingRecommendation(culture, form, { offline, mode }) : null),
    [culture, form, offline, mode]
  );
  const goalOptions = useMemo(() => (culture && !forage ? cultureGoalOptions(culture.goalsJson) : []), [culture, forage]);
  const goalLabel = goalOptions.find((option) => option.key === form.goal)?.label ?? "";
  const text = culture && rec ? seedingRecommendationText(culture.label, goalLabel, rec) : "";

  useEffect(() => {
    setMessage("");
  }, [text]);

  const handleCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setMessage("Resultado copiado.");
    } catch {
      setMessage("Não foi possível copiar automaticamente neste dispositivo.");
    }
  };

  const handleWhatsApp = async () => {
    if (!text) return;
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ text });
        return;
      } catch (error) {
        // Usuário fechou a janela de compartilhar: nada a fazer.
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    window.open(whatsappShareUrl(text), "_blank", "noopener,noreferrer");
  };

  if (!cultures.length || !culture || !rec) return null;

  const catalogDefault = (value: number | null) => (offline ? null : value);
  const hardSeedsVisible = complete && hardSeedsApply(culture, form);
  const physicalInput = forage && complete && form.forageDoseInput === "physical";

  const guidance = (
    <dl className="space-y-2 text-sm">
      {forage ? (
        <div>
          <dt className="text-xs uppercase text-slate-500">Recomendação</dt>
          <dd className="text-slate-800">
            Em kg de sementes puras viáveis (SPV) por hectare; veja as observações. Pontos de VC = SPV × 100.
          </dd>
          <dd className="mt-1 text-slate-800">{FORAGE_VC_FORMULA}</dd>
          <dd className="mt-1 text-slate-700">{FORAGE_VIABILITY_NOTE}</dd>
        </div>
      ) : (
        <>
          <div>
            <dt className="text-xs uppercase text-slate-500">Faixa de referência{goalLabel ? ` (${goalLabel})` : ""}</dt>
            <dd className="font-semibold text-slate-900">
              {rec.range ? (
                formatKgHaRange(rec.range)
              ) : (
                <span className="font-normal text-slate-700">
                  Sem faixa de referência cadastrada.
                  {canConfigureCatalog ? (
                    <>
                      {" "}
                      <Link to={TECHNICAL_CATALOG_SETTINGS_PATH} className="text-emerald-700 underline">
                        Cadastrar em Configurações
                      </Link>
                    </>
                  ) : null}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">População recomendada</dt>
            <dd className="text-slate-800">
              {culture.populationTargetDefault != null && culture.populationTargetDefault > 0
                ? `${formatNumber(culture.populationTargetDefault, 0)} plantas/ha`
                : "—"}
            </dd>
          </div>
        </>
      )}
      <div>
        <dt className="text-xs uppercase text-slate-500">Observações</dt>
        <dd className="whitespace-pre-line text-slate-700">{culture.notes || "Sem observações cadastradas."}</dd>
      </div>
      <div>
        <dt className="text-xs uppercase text-slate-500">Fonte</dt>
        <dd className="text-slate-700">
          {offline
            ? "Lista reduzida, sem conexão. Confira os valores quando a conexão voltar."
            : "Catálogo Técnico (germinação e pureza padrão: mínimo legal do MAPA)."}
        </dd>
      </div>
    </dl>
  );

  return (
    <article className="rounded-2xl border border-emerald-200 bg-white p-4 shadow-sm sm:p-6" data-testid="seeding-recommendation">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-800">Recomendação de semeadura</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1" role="group" aria-label="Modo">
            <button type="button" aria-pressed={!complete} onClick={() => changeMode("simple")} className={chipClass(!complete)}>
              Simples
            </button>
            <button type="button" aria-pressed={complete} onClick={() => changeMode("complete")} className={chipClass(complete)}>
              Completo
            </button>
          </div>
          <button
            type="button"
            onClick={clearForm}
            className="min-h-11 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
          >
            Limpar
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <div className="min-w-0 space-y-5">
          {/* 1. Cultura e orientações */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-sm text-slate-700">
              Cultura
              <select
                className={inputClass}
                value={cultureId}
                onChange={(event) => selectCulture(cultures.find((item) => item.id === event.target.value) ?? null)}
              >
                {cultures.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>

            {goalOptions.length ? (
              <label className="block text-sm text-slate-700">
                Objetivo
                <select className={inputClass} value={form.goal} onChange={(event) => setField("goal", event.target.value)}>
                  <option value="">Geral</option>
                  {goalOptions.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label} ({formatKgHaRange(option.range)})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 sm:col-span-2">
              <button
                type="button"
                aria-expanded={guidanceOpen}
                onClick={() => setGuidanceOpen((open) => !open)}
                className="flex min-h-11 w-full items-center justify-between text-left text-sm font-semibold text-slate-800 lg:hidden"
              >
                Orientações da cultura
                <span aria-hidden="true">{guidanceOpen ? "▴" : "▾"}</span>
              </button>
              <p className="hidden text-sm font-semibold text-slate-800 lg:block">Orientações da cultura</p>
              <div className={`${guidanceOpen ? "block" : "hidden"} mt-2 lg:block`}>{guidance}</div>
            </div>
          </section>

          {/* 2. Plantio (sementes por metro) ou dose (forrageira) */}
          {forage ? (
            <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {complete ? (
                <label className="flex min-h-11 items-center gap-3 text-sm text-slate-700 sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={form.forageDoseInput === "physical"}
                    onChange={(event) => setField("forageDoseInput", event.target.checked ? "physical" : "spv")}
                  />
                  Já tenho a dose física
                </label>
              ) : null}
              {physicalInput ? (
                <NumberField
                  label="Dose física (kg/ha)"
                  placeholder="kg/ha do lote"
                  value={form.physicalDose}
                  onChange={(value) => setField("physicalDose", value)}
                />
              ) : (
                <NumberField
                  label="Dose de SPV desejada (kg/ha)"
                  placeholder="kg SPV/ha"
                  value={form.spvDose}
                  onChange={(value) => setField("spvDose", value)}
                />
              )}
            </section>
          ) : (
            <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <fieldset className="sm:col-span-2">
                <legend className="text-sm text-slate-700">Espaçamento entre linhas (cm)</legend>
                <div className="mt-1 flex flex-wrap gap-2">
                  {SPACING_OPTIONS_CM.map((option) => {
                    const active = !otherSpacing && parseFloat(form.spacingCm.replace(",", ".")) === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        aria-pressed={active}
                        onClick={() => {
                          setOtherSpacing(false);
                          setField("spacingCm", String(option));
                        }}
                        className={chipClass(active)}
                      >
                        {option}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    aria-pressed={otherSpacing}
                    onClick={() => {
                      setOtherSpacing(true);
                      setField("spacingCm", "");
                    }}
                    className={chipClass(otherSpacing)}
                  >
                    outro
                  </button>
                </div>
                {otherSpacing ? (
                  <input
                    {...decimalInputProps}
                    aria-label="Outro espaçamento (cm)"
                    placeholder="Espaçamento (cm)"
                    className={inputClass}
                    value={form.spacingCm}
                    onChange={(event) => setField("spacingCm", event.target.value)}
                  />
                ) : null}
              </fieldset>

              <NumberField
                label="População (plantas/ha)"
                placeholder={defaultPlaceholder(culture.populationTargetDefault, "Padrão", "", 0, "Plantas/ha")}
                value={form.population}
                onChange={(value) => setField("population", value)}
              />
            </section>
          )}

          {/* 3. Lote */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {forage && complete ? (
              <fieldset className="sm:col-span-2">
                <legend className="text-sm text-slate-700">Análise do termo</legend>
                <div className="mt-1 flex flex-wrap gap-2" role="group" aria-label="Análise do termo">
                  {(Object.keys(FORAGE_ANALYSIS_LABEL) as ForageAnalysis[]).map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={form.forageAnalysis === option}
                      onClick={() => setField("forageAnalysis", option)}
                      className={chipClass(form.forageAnalysis === option)}
                    >
                      {FORAGE_ANALYSIS_LABEL[option]}
                    </button>
                  ))}
                </div>
                {form.forageAnalysis === "viability" ? (
                  <p className="mt-1 text-xs text-slate-500">
                    O tetrazólio já conta a semente dura viável: sementes duras não entram no VC.
                  </p>
                ) : null}
              </fieldset>
            ) : null}
            <NumberField
              label={germinationFieldLabel(forage)}
              placeholder={defaultPlaceholder(
                catalogDefault(culture.germinationDefault),
                "Mínimo MAPA",
                "%",
                1,
                forage ? "Germinação ou viabilidade do lote (%)" : "Germinação do lote (%)"
              )}
              hint={CONFORMITY_TERM_HINT}
              value={form.germination}
              onChange={(value) => setField("germination", value)}
            />
            {complete ? (
              <>
                <NumberField
                  label="Pureza (%)"
                  placeholder={defaultPlaceholder(catalogDefault(culture.purityDefault), "Mínimo MAPA", "%", 1, "Pureza do lote (%)")}
                  value={form.purity}
                  onChange={(value) => setField("purity", value)}
                />
                {forage ? null : (
                  <NumberField
                    label="PMS (g)"
                    placeholder={defaultPlaceholder(catalogDefault(culture.pmsDefault), "Catálogo", " g", 2, "Peso de 1.000 sementes (g)")}
                    value={form.pms}
                    onChange={(value) => setField("pms", value)}
                  />
                )}
                {hardSeedsVisible ? (
                  <NumberField
                    label="Sementes duras (%)"
                    placeholder="Entra só no VC"
                    value={form.hardSeeds}
                    onChange={(value) => setField("hardSeeds", value)}
                  />
                ) : null}
                {forage ? null : (
                  <NumberField
                    label="Perda a campo (%)"
                    placeholder="0"
                    value={form.fieldLoss}
                    onChange={(value) => setField("fieldLoss", value)}
                  />
                )}
              </>
            ) : (
              <p className="self-end text-xs text-slate-500">
                Modo Simples: pureza e PMS do catálogo, sem perda a campo. Use o Completo para o lote.
              </p>
            )}
          </section>
        </div>

        {/* Resultado */}
        <div className="min-w-0 lg:sticky lg:top-4 lg:self-start" aria-live="polite">
          {rec.prompts.length ? (
            <ul className="mb-3 space-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
              {rec.prompts.map((prompt) => (
                <li key={prompt}>{prompt}</li>
              ))}
            </ul>
          ) : null}

          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            {rec.path === "seeds" ? (
              <>
                <p className="text-4xl font-bold leading-tight text-emerald-700">
                  {rec.seedsPerMeter != null ? formatSeedsPerMeter(rec.seedsPerMeter) : "—"}
                </p>
                <p className="text-sm font-semibold text-emerald-800">sementes por metro</p>
                {rec.seedsPer10m != null ? <p className="mt-1 text-sm text-emerald-800">≈ {rec.seedsPer10m} a cada 10 m</p> : null}

                <div className="mt-3">
                  <ResultRow label="Plantas por m²">{rec.plantsM2 != null ? formatNumber(rec.plantsM2, 1) : "—"}</ResultRow>
                  <ResultRow label="Sementes por m²">{rec.seedsM2 != null ? formatNumber(rec.seedsM2, 1) : "—"}</ResultRow>
                  <ResultRow label="kg/ha">{rec.kgHa != null ? formatNumber(rec.kgHa, 2) : "—"}</ResultRow>
                  {rec.kgHaBase != null ? (
                    <p className="pb-2 text-right text-xs text-slate-600">{formatNumber(rec.kgHaBase, 2)} kg/ha sem a perda a campo</p>
                  ) : null}
                  {rec.kgHaUnavailableReason ? <p className="pb-2 text-xs text-slate-600">{rec.kgHaUnavailableReason}</p> : null}
                </div>
              </>
            ) : (
              <>
                <p className="text-4xl font-bold leading-tight text-emerald-700">
                  {rec.physicalDose != null ? formatNumber(rec.physicalDose, 1) : "—"}
                </p>
                <p className="text-sm font-semibold text-emerald-800">kg/ha do lote (dose física)</p>
                <div className="mt-3">
                  <ResultRow label="Dose de SPV">{rec.spvDose != null ? `${formatNumber(rec.spvDose, 1)} kg/ha` : "—"}</ResultRow>
                  <ResultRow label="Pontos de VC">{rec.vcPoints != null ? formatNumber(rec.vcPoints, 0) : "—"}</ResultRow>
                </div>
              </>
            )}

            <ResultRow label="VC do lote">{rec.vc != null ? `${formatNumber(rec.vc, 1)}%` : "—"}</ResultRow>
            <ResultRow label="Fator de correção">{rec.correctionFactor != null ? formatNumber(rec.correctionFactor, 2) : "—"}</ResultRow>
            {rec.vcUnavailableReason ? <p className="pb-2 text-xs text-slate-600">{rec.vcUnavailableReason}</p> : null}

            <ul className="mt-2 space-y-1.5 border-t border-emerald-100 pt-2 text-xs text-slate-700">
              {rec.population ? (
                <li className="flex flex-wrap items-center gap-1.5">
                  População {formatNumber(rec.population.value, 0)} plantas/ha <OriginBadge used={rec.population} />
                </li>
              ) : null}
              {rec.germination ? (
                <li className="flex flex-wrap items-center gap-1.5">
                  {germinationLabelText(rec.path === "forage")} {formatNumber(rec.germination.value, 1)}% <OriginBadge used={rec.germination} />
                  {rec.hardSeeds > 0 ? <span>+ sementes duras {formatNumber(rec.hardSeeds, 1)}% (só no VC)</span> : null}
                </li>
              ) : null}
              {rec.purity ? (
                <li className="flex flex-wrap items-center gap-1.5">
                  Pureza {formatNumber(rec.purity.value, 1)}% <OriginBadge used={rec.purity} />
                </li>
              ) : null}
              {rec.path === "seeds" && rec.pms ? (
                <li className="flex flex-wrap items-center gap-1.5">
                  PMS {formatNumber(rec.pms.value, 2)} g <OriginBadge used={rec.pms} />
                </li>
              ) : null}
              {rec.path === "seeds" && rec.rowSpacingCm != null ? (
                <li>
                  Espaçamento {formatNumber(rec.rowSpacingCm, 1)} cm, perda a campo {formatNumber(rec.fieldLossApplied, 1)}%
                </li>
              ) : null}
            </ul>

            {rec.germinationWarning ? <p className="mt-2 text-xs text-slate-600">{rec.germinationWarning}</p> : null}
            {rec.fieldLossWarning ? <p className="mt-2 text-xs font-medium text-amber-800">{rec.fieldLossWarning}</p> : null}
            {rec.rangeCheck ? (
              <p
                role={rec.rangeCheck.status === "within" ? undefined : "alert"}
                className={`mt-2 rounded-lg border px-3 py-2 text-xs ${rec.rangeCheck.status === "within" ? "border-emerald-200 bg-white text-emerald-800" : "border-amber-300 bg-amber-50 text-amber-900"}`}
              >
                {kgHaRangeMessage(rec.rangeCheck)}
              </p>
            ) : null}

            {rec.ready ? (
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleCopy}
                  className="min-h-11 rounded-lg border border-emerald-600 bg-white px-3 text-sm font-medium text-emerald-700 transition hover:bg-emerald-100"
                >
                  Copiar
                </button>
                <button
                  type="button"
                  onClick={handleWhatsApp}
                  className="min-h-11 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white transition hover:bg-emerald-500"
                >
                  WhatsApp
                </button>
              </div>
            ) : null}
            {message ? <p className="mt-2 text-sm text-slate-600">{message}</p> : null}
          </div>
        </div>
      </div>
    </article>
  );
}
