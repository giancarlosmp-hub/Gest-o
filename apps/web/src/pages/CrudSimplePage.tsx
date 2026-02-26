import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../lib/apiClient";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";

type CrudSimplePageProps = {
  endpoint: string;
  title: string;
  fields: { key: string; label: string; type?: string }[];
  readOnly?: boolean;
  detailsPath?: string;
  createInModal?: boolean;
  createButtonLabel?: string;
  createModalTitle?: string;
};

export default function CrudSimplePage({
  endpoint,
  title,
  fields,
  readOnly = false,
  detailsPath,
  createInModal = false,
  createButtonLabel = "Adicionar",
  createModalTitle = "Novo registro"
}: CrudSimplePageProps) {
  const { user } = useAuth();
  const [items, setItems] = useState<any[]>([]);
  const [users, setUsers] = useState<Array<{ id: string; name: string; role?: string }>>([]);
  const [form, setForm] = useState<any>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [quickFilters, setQuickFilters] = useState({ uf: "", region: "", clientType: "", ownerSellerId: "" });
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [totalItems, setTotalItems] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isApplyingFilters, setIsApplyingFilters] = useState(false);

  const isClientsPage = endpoint === "/clients";
  const canFilterBySeller = isClientsPage && (user?.role === "diretor" || user?.role === "gerente");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get(endpoint);
      setItems(Array.isArray(response.data) ? response.data : []);
    } catch (e: any) {
      setItems([]);
      setError(e.response?.data?.message || "Não foi possível carregar os dados.");
    } finally {
      setLoading(false);
    }
  };

  const loadClients = async () => {
    setError(null);
    setIsApplyingFilters(true);

    const params: Record<string, string | number> = {
      page,
      pageSize
    };

    if (debouncedSearch) params.q = debouncedSearch;
    if (quickFilters.uf) params.state = quickFilters.uf;
    if (quickFilters.region) params.region = quickFilters.region;
    if (quickFilters.clientType) params.clientType = quickFilters.clientType;
    if (canFilterBySeller && quickFilters.ownerSellerId) params.ownerSellerId = quickFilters.ownerSellerId;

    try {
      const response = await api.get(endpoint, { params });
      const payload = response.data;
      setItems(Array.isArray(payload?.data) ? payload.data : []);
      setTotalItems(Number(payload?.total ?? 0));
      setTotalPages(Math.max(1, Number(payload?.totalPages ?? 1)));
    } catch (e: any) {
      setItems([]);
      setTotalItems(0);
      setTotalPages(1);
      setError(e.response?.data?.message || "Não foi possível carregar os clientes.");
    } finally {
      setLoading(false);
      setIsApplyingFilters(false);
    }
  };

  useEffect(() => {
    if (isClientsPage) {
      setLoading(true);
      void loadClients();
      return;
    }

    void load();
  }, [endpoint, isClientsPage, page, pageSize, debouncedSearch, quickFilters.uf, quickFilters.region, quickFilters.clientType, quickFilters.ownerSellerId, canFilterBySeller]);

  useEffect(() => {
    if (!isClientsPage || !canFilterBySeller) {
      setUsers([]);
      return;
    }

    api.get("/users")
      .then((response) => {
        const allUsers = Array.isArray(response.data) ? response.data : [];
        const sellers = allUsers.filter((item: any) => item?.role === "vendedor" && item?.id && item?.name);
        setUsers(sellers);
      })
      .catch(() => {
        setUsers([]);
      });
  }, [canFilterBySeller, isClientsPage]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filterOptions = useMemo(() => ({
    ufs: ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"],
    regions: ["Norte", "Nordeste", "Centro-Oeste", "Sudeste", "Sul"],
    clientTypes: ["PJ", "PF"]
  }), []);

  const visibleItems = items;

  const clearClientFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setQuickFilters({ uf: "", region: "", clientType: "", ownerSellerId: "" });
    setPage(1);
  };

  useEffect(() => {
    if (!isClientsPage) return;
    setPage(1);
  }, [debouncedSearch, quickFilters.uf, quickFilters.region, quickFilters.clientType, quickFilters.ownerSellerId, isClientsPage]);

  const parseFormValue = (fieldKey: string, fieldType: string | undefined, rawValue: string) => {
    if (fieldType === "number") return rawValue === "" ? "" : Number(rawValue);
    if (fieldKey === "state") return rawValue.toUpperCase();
    return rawValue;
  };

  const validateForm = () => {
    if (endpoint !== "/clients") return null;

    const name = String(form.name ?? "").trim();
    const state = String(form.state ?? "").trim();

    if (!name) return "Nome é obrigatório.";
    if (state && !/^[A-Za-z]{2}$/.test(state)) return "UF deve conter exatamente 2 letras.";

    return null;
  };

  const closeCreateModal = () => {
    setIsCreateModalOpen(false);
    setEditing(null);
    setForm({});
    setFormError(null);
  };

  const openCreateModal = () => {
    setEditing(null);
    setForm({});
    setFormError(null);
    setIsCreateModalOpen(true);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const validationError = validateForm();
    if (validationError) {
      setFormError(validationError);
      toast.error(validationError);
      return;
    }

    setSaving(true);
    try {
      if (editing) await api.put(`${endpoint}/${editing}`, form);
      else await api.post(endpoint, form);

      toast.success(editing ? "Registro atualizado com sucesso." : "Registro criado com sucesso.");

      setForm({});
      setEditing(null);
      await load();
      if (createInModal) closeCreateModal();
    } catch (e: any) {
      toast.error(e.response?.data?.message || "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  const onEdit = (item: any) => {
    setFormError(null);
    if (createInModal) {
      setEditing(item.id);
      setForm(item);
      setIsCreateModalOpen(true);
      return;
    }

    setEditing(item.id);
    setForm(item);
  };

  const onDelete = async (id: string) => {
    await api.delete(`${endpoint}/${id}`);
    await load();
  };

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-slate-900">{title}</h2>

      {!readOnly && !createInModal && (
        <form onSubmit={submit} className="grid gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-3">
          {fields.map((f) => (
            <input
              key={f.key}
              required
              className="rounded-lg border p-2"
              type={f.type || "text"}
              placeholder={f.label}
              value={form[f.key] ?? ""}
              onChange={(e) => setForm({ ...form, [f.key]: parseFormValue(f.key, f.type, e.target.value) })}
            />
          ))}
          <button disabled={saving} className="rounded-lg bg-brand-700 px-3 py-2 font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60">{saving ? "Salvando..." : editing ? "Atualizar" : "Criar"}</button>
        </form>
      )}

      {!readOnly && createInModal ? (
        <div className="flex justify-end">
          <button type="button" onClick={openCreateModal} className="rounded-lg bg-brand-700 px-4 py-2 font-medium text-white hover:bg-brand-800">
            {createButtonLabel}
          </button>
        </div>
      ) : null}

      {isClientsPage ? (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <input
              className="rounded-lg border border-slate-300 px-3 py-2"
              placeholder="Buscar clientes..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="rounded-lg border border-slate-300 px-3 py-2"
              value={quickFilters.uf}
              onChange={(e) => setQuickFilters((prev) => ({ ...prev, uf: e.target.value }))}
            >
              <option value="">UF (todas)</option>
              {filterOptions.ufs.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
            </select>
            <select
              className="rounded-lg border border-slate-300 px-3 py-2"
              value={quickFilters.region}
              onChange={(e) => setQuickFilters((prev) => ({ ...prev, region: e.target.value }))}
            >
              <option value="">Região (todas)</option>
              {filterOptions.regions.map((region) => <option key={region} value={region}>{region}</option>)}
            </select>
            <select
              className="rounded-lg border border-slate-300 px-3 py-2"
              value={quickFilters.clientType}
              onChange={(e) => setQuickFilters((prev) => ({ ...prev, clientType: e.target.value }))}
            >
              <option value="">Tipo (todos)</option>
              {filterOptions.clientTypes.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
            {canFilterBySeller ? (
              <select
                className="rounded-lg border border-slate-300 px-3 py-2"
                value={quickFilters.ownerSellerId}
                onChange={(e) => setQuickFilters((prev) => ({ ...prev, ownerSellerId: e.target.value }))}
              >
                <option value="">Vendedor (todos)</option>
                {users.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
              </select>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-slate-600">{totalItems} clientes encontrados</span>
            <button
              type="button"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
              onClick={clearClientFilters}
            >
              Limpar filtros
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        {loading ? <div className="p-4 text-slate-500">Carregando...</div> : null}
        {error ? (
          <div className="space-y-3 p-4 text-amber-700">
            <p>{error}</p>
            <button type="button" className="rounded-lg border border-amber-300 px-3 py-1.5 text-sm font-medium" onClick={() => (isClientsPage ? void loadClients() : void load())}>Tentar novamente</button>
          </div>
        ) : null}
        {!loading && !error ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-brand-50 text-brand-800">
                {fields.map((f) => (
                  <th className="p-2 text-left" key={f.key}>{f.label}</th>
                ))}
                {detailsPath ? <th className="p-2 text-left">Detalhes</th> : null}
                {!readOnly ? <th className="p-2 text-left" /> : null}
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((it) => (
                <tr key={it.id} className="border-t border-slate-100">
                  {fields.map((f) => <td key={f.key} className="p-2 text-slate-700">{String(it[f.key] ?? "")}</td>)}
                  {detailsPath ? <td className="p-2"><Link className="font-medium text-brand-700 hover:text-brand-800" to={`${detailsPath}/${it.id}`}>Abrir</Link></td> : null}
                  {!readOnly ? (
                    <td className="space-x-3 p-2">
                      <button className="font-medium text-brand-700" onClick={() => onEdit(it)}>Editar</button>
                      <button className="font-medium text-amber-700" onClick={() => onDelete(it.id)}>Excluir</button>
                    </td>
                  ) : null}
                </tr>
              ))}
              {visibleItems.length === 0 ? (
                <tr>
                  <td colSpan={fields.length + (detailsPath ? 1 : 0) + (!readOnly ? 1 : 0)} className="p-8 text-center text-slate-500">
                    Nenhum registro encontrado com os filtros atuais.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </div>

      {isClientsPage && !loading && !error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-sm text-slate-600">
            Página <span className="font-semibold text-slate-900">{page}</span> de <span className="font-semibold text-slate-900">{totalPages}</span> · Total de <span className="font-semibold text-slate-900">{totalItems}</span> clientes
            {isApplyingFilters ? <span className="ml-2 text-slate-500">Atualizando...</span> : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              disabled={page <= 1 || isApplyingFilters}
            >
              Anterior
            </button>
            <button
              type="button"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
              disabled={page >= totalPages || isApplyingFilters}
            >
              Próximo
            </button>
          </div>
        </div>
      ) : null}

      {createInModal && isCreateModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-4xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="mb-4">
              <h3 className="text-xl font-semibold text-slate-900">{createModalTitle}</h3>
              <p className="text-sm text-slate-500">Preencha os dados para cadastrar um cliente.</p>
            </div>

            <form onSubmit={submit} className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                {fields.map((f) => {
                  const isRequired = endpoint === "/clients" ? f.key === "name" : true;
                  return (
                    <div key={f.key} className="space-y-1">
                      <label className="block text-sm font-medium text-slate-700" htmlFor={`modal-${f.key}`}>{f.label}</label>
                      <input
                        id={`modal-${f.key}`}
                        required={isRequired}
                        className="w-full rounded-lg border border-slate-300 p-2 text-slate-800"
                        type={f.type || "text"}
                        placeholder={f.label}
                        value={form[f.key] ?? ""}
                        onChange={(e) => {
                          setFormError(null);
                          setForm({ ...form, [f.key]: parseFormValue(f.key, f.type, e.target.value) });
                        }}
                      />
                    </div>
                  );
                })}
              </div>

              {formError ? <p className="text-sm text-rose-600">{formError}</p> : null}

              <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
                <button type="button" onClick={closeCreateModal} className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100" disabled={saving}>
                  Cancelar
                </button>
                <button type="submit" className="rounded-lg bg-brand-700 px-4 py-2 font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60" disabled={saving}>
                  {saving ? "Salvando..." : "Salvar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
