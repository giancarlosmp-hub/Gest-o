import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CULTURE_FALLBACKS, type TechnicalCulture, fetchTechnicalCultures } from "../lib/technicalCultures";

const cardClass = "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm";
const inputClass = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm outline-none focus:border-emerald-500";

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
  correcaoCampo: "0"
};

const parseNumber = (value: string) => {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatValue = (value: number, digits = 2) => value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export default function AssistenteTecnico() {
  const [form, setForm] = useState<SemeaduraForm>(initialForm);
  const [cultures, setCultures] = useState<TechnicalCulture[]>([]);
  const [loading, setLoading] = useState(true);
  const [fallbackMessage, setFallbackMessage] = useState("");

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const data = await fetchTechnicalCultures();
        if (!mounted) return;
        setCultures(data.filter((item) => item.isActive));
      } catch (error) {
        console.error("Falha ao carregar catálogo técnico", error);
        if (!mounted) return;
        setCultures(CULTURE_FALLBACKS);
        setFallbackMessage("Não foi possível carregar o catálogo da API. Exibindo catálogo local temporário.");
        toast.warning("Falha ao carregar catálogo técnico. Usando fallback local.");
      } finally {
        if (mounted) setLoading(false);
      }
    };

    load();
    return () => {
      mounted = false;
    };
  }, []);

  const selectedCulture = useMemo(() => cultures.find((item) => item.id === form.culturaId) ?? null, [cultures, form.culturaId]);

  useEffect(() => {
    if (!cultures.length) return;
    if (!form.culturaId || !cultures.some((item) => item.id === form.culturaId)) {
      const first = cultures[0];
      setForm((prev) => ({ ...prev, culturaId: first.id }));
      return;
    }
  }, [cultures, form.culturaId]);

  useEffect(() => {
    if (!selectedCulture) return;
    setForm((prev) => ({
      ...prev,
      populacaoHa: prev.populacaoHa || (selectedCulture.populationTargetDefault ? String(selectedCulture.populationTargetDefault) : ""),
      espacamentoCm: prev.espacamentoCm || (selectedCulture.rowSpacingCmDefault ? String(selectedCulture.rowSpacingCmDefault) : ""),
      pms: prev.pms || (selectedCulture.pmsDefault ? String(selectedCulture.pmsDefault) : ""),
      germinacao: prev.germinacao || (selectedCulture.germinationDefault ? String(selectedCulture.germinationDefault) : ""),
      pureza: prev.pureza || (selectedCulture.purityDefault ? String(selectedCulture.purityDefault) : "")
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

    if (fator <= 0 || espacamentoCm <= 0 || pms <= 0 || populacaoHa <= 0) return { plantasM2, sementesM2: 0, sementesMetro: 0, kgHaFinal: 0 };

    const sementesM2 = plantasM2 / fator;
    const sementesMetro = sementesM2 * (espacamentoCm / 100);
    const kgHa = (sementesM2 * pms) / 1000;
    return { plantasM2, sementesM2, sementesMetro, kgHaFinal: kgHa * (1 + correcaoCampo / 100) };
  }, [form]);

  if (loading) return <div className="p-6 text-sm text-slate-600">Carregando Assistente Técnico...</div>;

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">Assistente Técnico</h1>
        <p className="text-sm text-slate-600">Ferramentas para apoio técnico e regulagem de plantio.</p>
      </header>

      {fallbackMessage ? <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{fallbackMessage}</p> : null}

      <div className="grid gap-4 md:grid-cols-2">
        <article className={cardClass}>
          <h2 className="text-base font-semibold text-slate-800">Calculadora de Semeadura</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="block text-sm text-slate-700">Cultura
              <select value={form.culturaId} onChange={(e) => setForm((prev) => ({ ...prev, culturaId: e.target.value }))} className={inputClass}>
                {cultures.map((culture) => <option key={culture.id} value={culture.id}>{culture.label}</option>)}
              </select>
            </label>
            <label className="block text-sm text-slate-700">Objetivo (opcional)<input value={form.objetivo} onChange={(e) => setForm((prev) => ({ ...prev, objetivo: e.target.value }))} className={inputClass} /></label>
            <label className="block text-sm text-slate-700">População desejada (plantas/ha)<input value={form.populacaoHa} onChange={(e) => setForm((prev) => ({ ...prev, populacaoHa: e.target.value }))} className={inputClass} /></label>
            <label className="block text-sm text-slate-700">Espaçamento (cm)<input value={form.espacamentoCm} onChange={(e) => setForm((prev) => ({ ...prev, espacamentoCm: e.target.value }))} className={inputClass} /></label>
            <label className="block text-sm text-slate-700">PMS (g)<input value={form.pms} onChange={(e) => setForm((prev) => ({ ...prev, pms: e.target.value }))} className={inputClass} /></label>
            <label className="block text-sm text-slate-700">Germinação (%)<input value={form.germinacao} onChange={(e) => setForm((prev) => ({ ...prev, germinacao: e.target.value }))} className={inputClass} /></label>
            <label className="block text-sm text-slate-700">Pureza (%)<input value={form.pureza} onChange={(e) => setForm((prev) => ({ ...prev, pureza: e.target.value }))} className={inputClass} /></label>
          </div>

          <div className="mt-5 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2">
            <div><p className="text-xs uppercase text-slate-500">Plantas por m²</p><p className="text-lg font-semibold">{formatValue(results.plantasM2)}</p></div>
            <div><p className="text-xs uppercase text-slate-500">Sementes por m²</p><p className="text-lg font-semibold">{formatValue(results.sementesM2)}</p></div>
            <div><p className="text-xs uppercase text-slate-500">Sementes por metro</p><p className="text-lg font-semibold">{formatValue(results.sementesMetro)}</p></div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3"><p className="text-xs uppercase text-emerald-700">kg/ha recomendado</p><p className="text-2xl font-bold text-emerald-700">{formatValue(results.kgHaFinal)} kg/ha</p></div>
          </div>
        </article>

        <article className={cardClass}>
          <h2 className="text-base font-semibold text-slate-800">Indicação rápida kg/ha</h2>
          <p className="mt-2 text-sm text-slate-600">{selectedCulture?.label || "Selecione uma cultura"}</p>
          {selectedCulture?.defaultKgHaMin != null && selectedCulture?.defaultKgHaMax != null ? (
            <p className="mt-3 text-2xl font-bold text-slate-900">{formatValue(selectedCulture.defaultKgHaMin, 0)}–{formatValue(selectedCulture.defaultKgHaMax, 0)} kg/ha</p>
          ) : (
            <p className="mt-3 text-sm font-medium text-amber-700">Não configurado — ajuste em Configurações.</p>
          )}
          <p className="mt-2 text-sm text-slate-600">{selectedCulture?.notes || "Sem observações cadastradas."}</p>
          <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">Categoria: {selectedCulture?.category || "—"}</p>
        </article>
      </div>
    </section>
  );
}
