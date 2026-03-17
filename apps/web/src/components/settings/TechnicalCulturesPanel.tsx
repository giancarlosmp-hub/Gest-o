import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import api from "../../lib/apiClient";
import { type CultureFormInput, type TechnicalCulture, fetchTechnicalCultures } from "../../lib/technicalCultures";
import { getApiErrorMessage } from "../../lib/apiError";

const extractFriendlyCultureError = (error: unknown) => {
  const message = getApiErrorMessage(error, "Não foi possível salvar o catálogo técnico.");
  const normalized = message.toLowerCase();

  if (normalized.includes("slug") && (normalized.includes("já") || normalized.includes("duplicate") || normalized.includes("exists"))) {
    return "Slug já existente. Escolha outro identificador para a cultura.";
  }

  if (normalized.includes("nome da cultura") || normalized.includes("label") || normalized.includes("nome")) {
    return "Nome da cultura é obrigatório.";
  }

  if (normalized.includes("germinationdefault") || normalized.includes("germinação")) {
    return "Germinação padrão deve estar entre 0 e 100.";
  }

  if (normalized.includes("puritydefault") || normalized.includes("pureza")) {
    return "Pureza padrão deve estar entre 0 e 100.";
  }

  if (normalized.includes("categoria")) {
    return "Categoria é obrigatória.";
  }

  return "Não foi possível salvar o catálogo técnico. Revise os campos e tente novamente.";
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

type CultureRowProps = {
  item: TechnicalCulture;
  onEdit: (item: TechnicalCulture) => void;
  disableEdit?: boolean;
};

const CultureTableRow = memo(function CultureTableRow({ item, onEdit, disableEdit = false }: CultureRowProps) {
  return (
    <tr className="border-t border-slate-200 text-slate-700">
      <td className="px-3 py-2.5">{item.label}</td>
      <td className="px-3 py-2.5">{item.category}</td>
      <td className="px-3 py-2.5">{item.isActive ? "Sim" : "Não"}</td>
      <td className="px-3 py-2.5">{item.defaultKgHaMin ?? "—"}</td>
      <td className="px-3 py-2.5">{item.defaultKgHaMax ?? "—"}</td>
      <td className="px-3 py-2.5">
        <button className="text-brand-700 disabled:cursor-not-allowed disabled:opacity-50" type="button" onClick={() => onEdit(item)} disabled={disableEdit}>Editar</button>
      </td>
    </tr>
  );
});

export default function TechnicalCulturesPanel() {
  const [cultures, setCultures] = useState<TechnicalCulture[]>([]);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<TechnicalCulture | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [form, setForm] = useState<CultureFormInput>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const loadCultures = async ({ keepLoading = false }: { keepLoading?: boolean } = {}) => {
    if (!keepLoading) {
      setLoading(true);
    }
    setLoadError("");

    try {
      const data = await fetchTechnicalCultures();
      setCultures(data);
      return data;
    } catch (error) {
      const friendlyMessage = "Não foi possível carregar o catálogo técnico. Tente novamente.";
      console.error("Falha ao carregar catálogo técnico em configurações", {
        reason: getApiErrorMessage(error, friendlyMessage),
        error,
      });
      setLoadError(friendlyMessage);
      setCultures([]);
      return null;
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

  const isDegradedMode = Boolean(loadError) || cultures.some((item) => item.id.startsWith("fallback-"));

  const openEditor = useCallback((item?: TechnicalCulture) => {
    setSaveSuccess(false);
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
  }, []);

  const save = async () => {
    if (isDegradedMode) {
      toast.error("Catálogo em modo degradado. Salvar está bloqueado até reconectar com a API.");
      return;
    }

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
      setSaving(true);
      setSaveSuccess(false);

      const response = editing
        ? await api.put<TechnicalCulture>(`/technical/cultures/${editing.id}`, payload)
        : await api.post<TechnicalCulture>("/technical/cultures", payload);

      const refreshed = await loadCultures({ keepLoading: true });
      const persisted = refreshed?.some((item) => item.id === response.data.id);

      if (!persisted) {
        toast.error("Não foi possível confirmar a persistência na API após salvar. Tente recarregar.");
        return;
      }

      toast.success("Cultura salva com sucesso.");
      setSaveSuccess(true);
      setEditing(null);
      setIsFormOpen(false);
      setForm(emptyForm);
    } catch (error) {
      toast.error(extractFriendlyCultureError(error));
    } finally {
      setSaving(false);
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
        <button className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60" onClick={() => openEditor()} type="button" disabled={isDegradedMode || loading || saving}>Nova cultura</button>
      </div>

      {isDegradedMode ? (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Modo degradado ativo: sem persistência confiável na API. A edição foi bloqueada até a conexão ser restabelecida.
        </div>
      ) : null}

      {saveSuccess ? (
        <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          Persistência confirmada na API. Dados sincronizados com o backend.
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(22rem,1fr)]">
        <section className="rounded-xl border border-slate-200 bg-slate-50/40 p-3">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nome/categoria" className="mb-3 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" />
          {loading ? (
            <div className="flex min-h-[14rem] items-center justify-center rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">Carregando catálogo técnico...</div>
          ) : null}

          {!loading && loadError ? (
            <div className="space-y-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
              <p>{loadError}</p>
              <button type="button" className="rounded border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold" onClick={() => loadCultures()}>
                Tentar novamente
              </button>
            </div>
          ) : null}

          {!loading && !loadError ? (
            <>
              <div className="max-h-[52vh] overflow-auto rounded-lg border border-slate-200 bg-white">
                <table className="min-w-[600px] w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-slate-100 text-left text-slate-600">
                    <tr>
                      <th className="px-3 py-2.5 font-semibold">Nome</th>
                      <th className="px-3 py-2.5 font-semibold">Categoria</th>
                      <th className="px-3 py-2.5 font-semibold">Ativo</th>
                      <th className="px-3 py-2.5 font-semibold">kg/ha min</th>
                      <th className="px-3 py-2.5 font-semibold">kg/ha max</th>
                      <th className="px-3 py-2.5 font-semibold">Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((item) => (
                      <CultureTableRow key={item.id} item={item} onEdit={openEditor} disableEdit={isDegradedMode || saving} />
                    ))}
                  </tbody>
                </table>
              </div>
              {!loading && filtered.length === 0 ? <p className="mt-2 text-xs text-slate-500">Nenhuma cultura encontrada no catálogo técnico.</p> : null}
            </>
          ) : null}
        </section>

        {isFormOpen ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{editing ? "Modo edição" : "Modo criação"}</p>
              <h4 className="text-sm font-semibold text-slate-900">{editing ? `Editando cultura: ${editing.label}` : "Nova cultura"}</h4>
            </div>
            <button type="button" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700" onClick={() => openEditor()}>
              Nova cultura
            </button>
          </div>

          <div className="max-h-[56vh] space-y-4 overflow-y-auto pr-1">
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
          </div>

          <div className="sticky bottom-0 mt-4 flex items-center gap-2 border-t border-slate-200 bg-slate-50 pt-3">
            <button type="button" className="rounded bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60" onClick={save} disabled={saving || loading || isDegradedMode}>{saving ? "Salvando..." : "Salvar cultura"}</button>
            <button type="button" className="rounded border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700" onClick={cancelEditing}>Cancelar edição</button>
          </div>
          </div>
        ) : (
          <div className="flex min-h-[14rem] items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-sm text-slate-500">
            Selecione <span className="mx-1 font-semibold text-slate-700">Editar</span> em uma cultura ou clique em <span className="mx-1 font-semibold text-slate-700">Nova cultura</span> para abrir o formulário.
          </div>
        )}
      </div>
    </div>
  );
}
