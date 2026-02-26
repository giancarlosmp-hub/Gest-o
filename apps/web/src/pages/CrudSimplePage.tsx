import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../lib/apiClient";
import { toast } from "sonner";

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
  const [items, setItems] = useState<any[]>([]);
  const [form, setForm] = useState<any>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

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

  useEffect(() => {
    void load();
  }, [endpoint]);

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

      <div className="overflow-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        {loading ? <div className="p-4 text-slate-500">Carregando...</div> : null}
        {error ? <div className="p-4 text-amber-600">{error}</div> : null}
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
              {items.map((it) => (
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
            </tbody>
          </table>
        ) : null}
      </div>

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
