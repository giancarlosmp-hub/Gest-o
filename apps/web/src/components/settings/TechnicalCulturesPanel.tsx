import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import api from "../../lib/apiClient";
import { CULTURE_FALLBACKS, type CultureFormInput, type TechnicalCulture, fetchTechnicalCultures } from "../../lib/technicalCultures";

const emptyForm: CultureFormInput = {
  slug: "",
  label: "",
  category: "Outras",
  isActive: true,
  defaultKgHaMin: null,
  defaultKgHaMax: null,
  notes: "",
  pmsDefault: null,
  germinationDefault: null,
  purityDefault: null,
  populationTargetDefault: null,
  rowSpacingCmDefault: null,
  goalsJson: {},
  tags: []
};

const toNumber = (value: string) => {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};

export default function TechnicalCulturesPanel() {
  const [cultures, setCultures] = useState<TechnicalCulture[]>([]);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<TechnicalCulture | null>(null);
  const [form, setForm] = useState<CultureFormInput>(emptyForm);

  const loadCultures = async () => {
    try {
      const data = await fetchTechnicalCultures();
      setCultures(data);
    } catch {
      setCultures(CULTURE_FALLBACKS);
      toast.warning("Não foi possível carregar da API. Exibindo fallback local.");
    }
  };

  useEffect(() => {
    loadCultures();
  }, []);

  const filtered = useMemo(
    () => cultures.filter((item) => item.label.toLowerCase().includes(search.toLowerCase()) || item.category.toLowerCase().includes(search.toLowerCase())),
    [cultures, search]
  );

  const openEditor = (item?: TechnicalCulture) => {
    if (!item) {
      setEditing(null);
      setForm(emptyForm);
      return;
    }

    setEditing(item);
    setForm({
      slug: item.slug,
      label: item.label,
      category: item.category,
      isActive: item.isActive,
      defaultKgHaMin: item.defaultKgHaMin,
      defaultKgHaMax: item.defaultKgHaMax,
      notes: item.notes,
      pmsDefault: item.pmsDefault,
      germinationDefault: item.germinationDefault,
      purityDefault: item.purityDefault,
      populationTargetDefault: item.populationTargetDefault,
      rowSpacingCmDefault: item.rowSpacingCmDefault,
      goalsJson: {},
      tags: []
    });
  };

  const save = async () => {
    if (!form.label.trim() || !form.slug.trim() || !form.category.trim()) {
      toast.error("Preencha nome, slug e categoria.");
      return;
    }

    if (form.defaultKgHaMin != null && form.defaultKgHaMax != null && form.defaultKgHaMin > form.defaultKgHaMax) {
      toast.error("Faixa de kg/ha inválida (mínimo maior que máximo).");
      return;
    }

    try {
      if (editing) await api.put(`/technical/cultures/${editing.id}`, form);
      else await api.post("/technical/cultures", form);
      toast.success("Catálogo técnico salvo.");
      setEditing(null);
      setForm(emptyForm);
      loadCultures();
    } catch {
      toast.error("Falha ao salvar cultura.");
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-slate-900">Catálogo Técnico (Culturas)</h3>
        <button className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white" onClick={() => openEditor()} type="button">Nova cultura</button>
      </div>
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nome/categoria" className="mb-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead><tr className="text-left text-slate-500"><th>Nome</th><th>Categoria</th><th>Ativo</th><th>kg/ha min</th><th>kg/ha max</th><th>Ações</th></tr></thead>
          <tbody>
            {filtered.map((item) => (
              <tr key={item.id} className="border-t border-slate-200">
                <td>{item.label}</td><td>{item.category}</td><td>{item.isActive ? "Sim" : "Não"}</td><td>{item.defaultKgHaMin ?? "—"}</td><td>{item.defaultKgHaMax ?? "—"}</td>
                <td><button className="text-brand-700" type="button" onClick={() => openEditor(item)}>Editar</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-2">
        <input className="rounded border px-2 py-1" placeholder="Slug" value={form.slug} onChange={(e) => setForm((prev) => ({ ...prev, slug: e.target.value.toLowerCase().replace(/\s+/g, "-") }))} />
        <input className="rounded border px-2 py-1" placeholder="Nome" value={form.label} onChange={(e) => setForm((prev) => ({ ...prev, label: e.target.value }))} />
        <input className="rounded border px-2 py-1" placeholder="Categoria" value={form.category} onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm((prev) => ({ ...prev, isActive: e.target.checked }))} />Ativo</label>
        <input className="rounded border px-2 py-1" placeholder="kg/ha mínimo" value={form.defaultKgHaMin ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, defaultKgHaMin: toNumber(e.target.value) }))} />
        <input className="rounded border px-2 py-1" placeholder="kg/ha máximo" value={form.defaultKgHaMax ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, defaultKgHaMax: toNumber(e.target.value) }))} />
        <input className="rounded border px-2 py-1" placeholder="População alvo (plantas/ha)" value={form.populationTargetDefault ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, populationTargetDefault: toNumber(e.target.value) }))} />
        <input className="rounded border px-2 py-1" placeholder="Espaçamento padrão (cm)" value={form.rowSpacingCmDefault ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, rowSpacingCmDefault: toNumber(e.target.value) }))} />
        <input className="rounded border px-2 py-1" placeholder="PMS padrão" value={form.pmsDefault ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, pmsDefault: toNumber(e.target.value) }))} />
        <input className="rounded border px-2 py-1" placeholder="Germinação padrão (%)" value={form.germinationDefault ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, germinationDefault: toNumber(e.target.value) }))} />
        <input className="rounded border px-2 py-1" placeholder="Pureza padrão (%)" value={form.purityDefault ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, purityDefault: toNumber(e.target.value) }))} />
        <textarea className="rounded border px-2 py-1 md:col-span-2" placeholder="Observações técnicas" value={form.notes ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))} />
      </div>
      <div className="mt-3">
        <button type="button" className="rounded bg-emerald-600 px-3 py-2 text-xs font-semibold text-white" onClick={save}>Salvar cultura</button>
      </div>
    </div>
  );
}
