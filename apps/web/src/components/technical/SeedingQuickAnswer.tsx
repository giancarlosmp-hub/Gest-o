import { useEffect, useMemo, useState } from "react";
import type { TechnicalCulture } from "../../lib/technicalCultures";
import {
  QUICK_ORIGIN_LABEL,
  QUICK_SPACING_OPTIONS_CM,
  type QuickOrigin,
  isQuickAnswerCulture,
  quickAnswerText,
  quickSeedingAnswer,
  whatsappShareUrl,
} from "../../lib/seedingQuickAnswer";

type Props = {
  cultures: TechnicalCulture[];
  /** Lista reduzida sem conexão: a germinação é pedida e o kg/ha não aparece. */
  offline: boolean;
};

const inputClass =
  "mt-1 w-full max-w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-800 shadow-sm outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200";

const chipBaseClass = "min-h-11 rounded-lg border px-3 text-sm font-medium transition";

const decimalInputProps = { type: "text", inputMode: "decimal", autoComplete: "off" } as const;

const formatValue = (value: number, digits: number) =>
  value.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: digits });

function OriginBadge({ origin }: { origin: QuickOrigin | null }) {
  if (!origin) return null;
  return (
    <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
      {QUICK_ORIGIN_LABEL[origin]}
    </span>
  );
}

function spacingFromCulture(culture: TechnicalCulture | null) {
  const value = culture?.rowSpacingCmDefault;
  if (value == null || !(value > 0)) return { espacamentoCm: "", other: false };
  const isPreset = (QUICK_SPACING_OPTIONS_CM as readonly number[]).includes(value);
  return { espacamentoCm: formatValue(value, 1), other: !isPreset };
}

export default function SeedingQuickAnswer({ cultures, offline }: Props) {
  const quickCultures = useMemo(() => cultures.filter(isQuickAnswerCulture), [cultures]);
  // Começa na primeira cultura da lista; se a lista chegar depois, o efeito abaixo escolhe.
  const [initial] = useState(() => {
    const first = cultures.find(isQuickAnswerCulture) ?? null;
    return { cultureId: first?.id ?? "", ...spacingFromCulture(first) };
  });
  const [cultureId, setCultureId] = useState(initial.cultureId);
  const [populacaoHa, setPopulacaoHa] = useState("");
  const [germinacao, setGerminacao] = useState("");
  const [perdaCampo, setPerdaCampo] = useState("0");
  const [espacamentoCm, setEspacamentoCm] = useState(initial.espacamentoCm);
  const [otherSpacing, setOtherSpacing] = useState(initial.other);
  const [message, setMessage] = useState("");

  const culture = quickCultures.find((item) => item.id === cultureId) ?? null;

  // Trocar de cultura limpa o que foi digitado e volta ao espaçamento padrão dela; a perda fica.
  const selectCulture = (next: TechnicalCulture | null) => {
    setCultureId(next?.id ?? "");
    setPopulacaoHa("");
    setGerminacao("");
    const spacing = spacingFromCulture(next);
    setEspacamentoCm(spacing.espacamentoCm);
    setOtherSpacing(spacing.other);
  };

  useEffect(() => {
    if (!quickCultures.length) return;
    if (!quickCultures.some((item) => item.id === cultureId)) selectCulture(quickCultures[0]);
  }, [quickCultures, cultureId]);

  const answer = useMemo(
    () => (culture ? quickSeedingAnswer(culture, { populacaoHa, germinacao, perdaCampo, espacamentoCm }, { offline }) : null),
    [culture, populacaoHa, germinacao, perdaCampo, espacamentoCm, offline]
  );
  const text = culture && answer ? quickAnswerText(culture.label, answer) : "";

  useEffect(() => {
    setMessage("");
  }, [text]);

  const handleCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setMessage("Resposta copiada.");
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

  if (!quickCultures.length) return null;

  const populationPlaceholder =
    culture?.populationTargetDefault != null && culture.populationTargetDefault > 0
      ? `Padrão: ${formatValue(culture.populationTargetDefault, 0)}`
      : "Plantas/ha";
  const germinationPlaceholder =
    !offline && culture?.germinationDefault != null && culture.germinationDefault > 0
      ? `Mínimo MAPA: ${formatValue(culture.germinationDefault, 1)}%`
      : "Germinação do lote (%)";

  return (
    <article className="rounded-2xl border border-emerald-200 bg-white p-4 shadow-sm sm:p-6" data-testid="seeding-quick-answer">
      <h2 className="text-base font-semibold text-slate-800">Resposta rápida: sementes por metro</h2>
      <p className="mt-1 text-xs text-slate-500">Sem o lote: use a germinação do lote quando o cliente tiver.</p>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block text-sm text-slate-700 sm:col-span-2">
          Cultura
          <select
            className={inputClass}
            value={cultureId}
            onChange={(event) => selectCulture(quickCultures.find((item) => item.id === event.target.value) ?? null)}
          >
            {quickCultures.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="sm:col-span-2">
          <legend className="text-sm text-slate-700">Espaçamento entre linhas (cm)</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {QUICK_SPACING_OPTIONS_CM.map((option) => {
              const active = !otherSpacing && parseFloat(espacamentoCm.replace(",", ".")) === option;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setOtherSpacing(false);
                    setEspacamentoCm(String(option));
                  }}
                  className={`${chipBaseClass} ${active ? "border-emerald-600 bg-emerald-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"}`}
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
                setEspacamentoCm("");
              }}
              className={`${chipBaseClass} ${otherSpacing ? "border-emerald-600 bg-emerald-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"}`}
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
              value={espacamentoCm}
              onChange={(event) => setEspacamentoCm(event.target.value)}
            />
          ) : null}
        </fieldset>

        <label className="block text-sm text-slate-700">
          População (plantas/ha)
          <input
            {...decimalInputProps}
            placeholder={populationPlaceholder}
            className={inputClass}
            value={populacaoHa}
            onChange={(event) => setPopulacaoHa(event.target.value)}
          />
        </label>

        <label className="block text-sm text-slate-700">
          Germinação (%)
          <input
            {...decimalInputProps}
            placeholder={germinationPlaceholder}
            className={inputClass}
            value={germinacao}
            onChange={(event) => setGerminacao(event.target.value)}
          />
        </label>

        <label className="block text-sm text-slate-700">
          Perda a campo (%)
          <input
            {...decimalInputProps}
            className={inputClass}
            value={perdaCampo}
            onChange={(event) => setPerdaCampo(event.target.value)}
          />
        </label>
      </div>

      {answer && answer.prompts.length ? (
        <ul className="mt-4 space-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
          {answer.prompts.map((prompt) => (
            <li key={prompt}>{prompt}</li>
          ))}
        </ul>
      ) : null}

      {answer && answer.ready && answer.seedsPerMeter != null ? (
        <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4" aria-live="polite">
          <p className="text-4xl font-bold leading-tight text-emerald-700">{formatValue(answer.seedsPerMeter, 1)}</p>
          <p className="text-sm font-semibold text-emerald-800">sementes por metro</p>
          <p className="mt-1 text-sm text-emerald-800">≈ {answer.seedsPer10m} a cada 10 m</p>

          <ul className="mt-3 space-y-1.5 text-xs text-slate-700">
            <li className="flex flex-wrap items-center gap-1.5">
              População {formatValue(answer.populationHa ?? 0, 0)} plantas/ha <OriginBadge origin={answer.populationOrigin} />
            </li>
            <li className="flex flex-wrap items-center gap-1.5">
              Germinação {formatValue(answer.germination ?? 0, 1)}% <OriginBadge origin={answer.germinationOrigin} />
            </li>
            <li className="flex flex-wrap items-center gap-1.5">
              Espaçamento {formatValue(answer.rowSpacingCm ?? 0, 1)} cm, perda a campo {formatValue(answer.fieldLossApplied, 1)}%
            </li>
          </ul>

          {answer.germinationWarning ? <p className="mt-2 text-xs text-slate-600">{answer.germinationWarning}</p> : null}
          {answer.fieldLossWarning ? <p className="mt-2 text-xs font-medium text-amber-800">{answer.fieldLossWarning}</p> : null}

          {answer.kgHa != null ? (
            <p className="mt-3 flex flex-wrap items-center gap-1.5 text-sm text-slate-700">
              Cerca de {formatValue(answer.kgHa, 2)} kg/ha, com PMS {formatValue(answer.pms ?? 0, 2)} g
              <OriginBadge origin={answer.pmsOrigin} /> e pureza {formatValue(answer.purity ?? 0, 1)}%
              <OriginBadge origin={answer.purityOrigin} />
            </p>
          ) : answer.kgHaUnavailableReason ? (
            <p className="mt-3 text-xs text-slate-600">{answer.kgHaUnavailableReason}</p>
          ) : null}

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
          {message ? <p className="mt-2 text-sm text-slate-600">{message}</p> : null}
        </div>
      ) : null}
    </article>
  );
}
