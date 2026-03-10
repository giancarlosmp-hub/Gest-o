import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import api from "../../lib/apiClient";
import { type CultureFormInput, type TechnicalCulture, fetchTechnicalCultures } from "../../lib/technicalCultures";
import { getApiErrorMessage } from "../../lib/apiError";

const extractFriendlyCultureError = (error: unknown) => {
  const message = getApiErrorMessage(error, "Falha ao salvar cultura.");
  const normalized = message.toLowerCase();

  if (normalized.includes("germinationdefault") || normalized.includes("germinação")) {
    return "Germinação padrão deve estar entre 0 e 100.";
  }

  if (normalized.includes("puritydefault") || normalized.includes("pureza")) {
    return "Pureza padrão deve estar entre 0 e 100.";
  }

  return message;
};

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
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [form, setForm] = useState<CultureFormInput>(emptyForm);
  const [loading, setLoading] = useState(true);

  const loadCultures = async () => {
    try {
      const data = await fetchTechnicalCultures();
      setCultures(data);
    } catch (error) {
      console.error("Falha ao carregar catálogo técnico em configurações", {
        reason: getApiErrorMessage(error, "Erro ao carregar catálogo técnico."),
        error,
      });
      toast.error(getApiErrorMessage(error, "Falha ao carregar catálogo técnico da API."));
      setCultures([]);
    } finally {
      setLoading(false);
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
    setIsFormOpen(true);

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
      goalsJson: item.goalsJson,
      tags: item.tags
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

    if (form.germinationDefault != null && (form.germinationDefault < 0 || form.germinationDefault > 100)) {
      toast.error("Germinação padrão deve estar entre 0 e 100.");
      return;
    }

    if (form.purityDefault != null && (form.purityDefault < 0 || form.purityDefault > 100)) {
      toast.error("Pureza padrão deve estar entre 0 e 100.");
      return;
    }

    const payload: CultureFormInput = {
      slug: form.slug.trim().toLowerCase(),
      label: form.label.trim(),
      category: form.category.trim(),
      isActive: form.isActive,
      defaultKgHaMin: form.defaultKgHaMin,
      defaultKgHaMax: form.defaultKgHaMax,
      notes: form.notes,
      pmsDefault: form.pmsDefault,
      germinationDefault: form.germinationDefault,
      purityDefault: form.purityDefault,
      populationTargetDefault: form.populationTargetDefault,
      rowSpacingCmDefault: form.rowSpacingCmDefault,
      goalsJson: form.goalsJson ?? {},
      tags: form.tags ?? []
    };

    try {
      if (editing) await api.put(`/technical/cultures/${editing.id}`, payload);
      else await api.post("/technical/cultures", payload);
      toast.success("Catálogo técnico salvo.");
      setEditing(null);
      setIsFormOpen(false);
      setForm(emptyForm);
      await loadCultures();
    } catch (error) {
      toast.error(extractFriendlyCultureError(error));
    }
  };

  const cancelEditing = () => {
    setEditing(null);
    setForm(emptyForm);
    setIsFormOpen(false);
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
      {!loading && filtered.length === 0 ? <p className="mt-2 text-xs text-slate-500">Nenhuma cultura encontrada.</p> : null}

      {isFormOpen ? (
        <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{editing ? "Modo edição" : "Modo criação"}</p>
              <h4 className="text-sm font-semibold text-slate-900">{editing ? `Editando cultura: ${editing.label}` : "Nova cultura"}</h4>
            </div>
            <button type="button" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700" onClick={() => openEditor()}>
              Nova cultura
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-xs font-medium text-slate-700">
              Slug
              <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={form.slug} onChange={(e) => setForm((prev) => ({ ...prev, slug: e.target.value.toLowerCase().replace(/\s+/g, "-") }))} />
            </label>

            <label className="text-xs font-medium text-slate-700">
              Nome
              <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={form.label} onChange={(e) => setForm((prev) => ({ ...prev, label: e.target.value }))} />
            </label>

            <label className="text-xs font-medium text-slate-700">
              Categoria
              <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={form.category} onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))} />
            </label>

            <label className="flex items-center gap-2 self-end rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((prev) => ({ ...prev, isActive: e.target.checked }))} />
              Ativo
            </label>

            <label className="text-xs font-medium text-slate-700">
              kg/ha mínimo
              <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={form.defaultKgHaMin ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, defaultKgHaMin: toNumber(e.target.value) }))} />
            </label>

            <label className="text-xs font-medium text-slate-700">
              kg/ha máximo
              <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={form.defaultKgHaMax ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, defaultKgHaMax: toNumber(e.target.value) }))} />
            </label>

            <label className="text-xs font-medium text-slate-700">
              População alvo (plantas/ha)
              <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={form.populationTargetDefault ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, populationTargetDefault: toNumber(e.target.value) }))} />
            </label>

            <label className="text-xs font-medium text-slate-700">
              Espaçamento padrão (cm)
              <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={form.rowSpacingCmDefault ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, rowSpacingCmDefault: toNumber(e.target.value) }))} />
            </label>

            <label className="text-xs font-medium text-slate-700">
              PMS padrão
              <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={form.pmsDefault ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, pmsDefault: toNumber(e.target.value) }))} />
            </label>

            <label className="text-xs font-medium text-slate-700">
              Germinação padrão (%)
              <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={form.germinationDefault ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, germinationDefault: toNumber(e.target.value) }))} />
            </label>

            <label className="text-xs font-medium text-slate-700">
              Pureza padrão (%)
              <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={form.purityDefault ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, purityDefault: toNumber(e.target.value) }))} />
            </label>

            <label className="text-xs font-medium text-slate-700 md:col-span-2">
              Observações técnicas
              <textarea className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={form.notes ?? ""} onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))} />
            </label>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <button type="button" className="rounded bg-emerald-600 px-3 py-2 text-xs font-semibold text-white" onClick={save}>Salvar cultura</button>
            <button type="button" className="rounded border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700" onClick={cancelEditing}>Cancelar edição</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
