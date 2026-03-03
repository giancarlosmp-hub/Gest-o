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

export default function AssistenteTecnico() {
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

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">Assistente Técnico</h1>
        <p className="text-sm text-slate-600">Ferramentas para apoio técnico e regulagem de plantio.</p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
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

        <article className={cardClass}>
          <h2 className="text-base font-semibold text-slate-800">Indicação de Plantio (kg/ha)</h2>
          <p className="mt-2 text-sm text-slate-500">Em breve.</p>
        </article>
      </div>
    </section>
  );
}
