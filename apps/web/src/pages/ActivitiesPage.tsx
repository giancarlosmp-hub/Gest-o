import { FormEvent, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import api from "../lib/apiClient";

type Client = { id: string; name: string };
type Opportunity = { id: string; title: string; clientId: string };
type Seller = { id: string; name: string; role?: string };
type Activity = {
  id: string;
  type: string;
  notes: string;
  dueDate: string;
  done: boolean;
  ownerSellerId: string;
  ownerSeller?: { id: string; name: string };
  opportunity?: { id: string; title: string; client?: { id: string; name: string } } | null;
};

const initialForm = { type: "ligacao", notes: "", dueDate: "", clientId: "", opportunityId: "", ownerSellerId: "" };

export default function ActivitiesPage() {
  const { user } = useAuth();
  const isSeller = user?.role === "vendedor";
  const canChooseSeller = user?.role === "diretor" || user?.role === "gerente";

  const [activities, setActivities] = useState<Activity[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [form, setForm] = useState(initialForm);
  const [clientSearch, setClientSearch] = useState("");
  const [opportunitySearch, setOpportunitySearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const sellerMap = useMemo(() => new Map(sellers.map((item) => [item.id, item.name])), [sellers]);
  const filteredClients = useMemo(() => {
    const search = clientSearch.trim().toLowerCase();
    if (!search) return clients;
    return clients.filter((item) => item.name.toLowerCase().includes(search));
  }, [clients, clientSearch]);

  const opportunitiesByClient = useMemo(() => (form.clientId ? opportunities.filter((item) => item.clientId === form.clientId) : []), [opportunities, form.clientId]);
  const filteredOpportunities = useMemo(() => {
    const search = opportunitySearch.trim().toLowerCase();
    if (!search) return opportunitiesByClient;
    return opportunitiesByClient.filter((item) => item.title.toLowerCase().includes(search));
  }, [opportunitiesByClient, opportunitySearch]);

  const loadData = async () => {
    setLoading(true);
    try {
      const requests: Promise<any>[] = [api.get("/activities"), api.get("/clients"), api.get("/opportunities")];
      if (canChooseSeller) requests.push(api.get("/users"));
      const [activitiesRes, clientsRes, opportunitiesRes, usersRes] = await Promise.all(requests);

      setActivities(Array.isArray(activitiesRes.data) ? activitiesRes.data : []);
      const clientsPayload = Array.isArray(clientsRes.data?.items) ? clientsRes.data.items : clientsRes.data;
      setClients(Array.isArray(clientsPayload) ? clientsPayload.map((item: any) => ({ id: String(item.id), name: String(item.name) })) : []);
      setOpportunities(Array.isArray(opportunitiesRes.data) ? opportunitiesRes.data.map((item: any) => ({ id: String(item.id), title: String(item.title || ""), clientId: String(item.clientId || "") })) : []);

      if (canChooseSeller) {
        const users = Array.isArray(usersRes?.data) ? usersRes.data : [];
        setSellers(users.filter((item: any) => item?.role === "vendedor").map((item: any) => ({ id: String(item.id), name: String(item.name), role: String(item.role) })));
      } else if (user?.id && user?.name) {
        setSellers([{ id: user.id, name: user.name }]);
      } else {
        setSellers([]);
      }
    } catch {
      setActivities([]);
      toast.error("Não foi possível carregar as atividades.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [canChooseSeller]);

  const openCreateModal = () => {
    setForm({ ...initialForm, ownerSellerId: isSeller && user?.id ? user.id : "" });
    setClientSearch("");
    setOpportunitySearch("");
    setIsModalOpen(true);
  };

  const closeCreateModal = () => {
    setIsModalOpen(false);
    setForm(initialForm);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.clientId || !form.notes.trim() || !form.dueDate) {
      toast.error("Preencha cliente, notas e vencimento.");
      return;
    }

    setSaving(true);
    try {
      await api.post("/activities", {
        type: form.type,
        notes: form.notes.trim(),
        dueDate: new Date(form.dueDate).toISOString(),
        clientId: form.clientId,
        opportunityId: form.opportunityId || undefined,
        ownerSellerId: isSeller && user?.id ? user.id : form.ownerSellerId || undefined
      });
      toast.success("Atividade criada com sucesso.");
      closeCreateModal();
      await loadData();
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Não foi possível criar a atividade.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-900">Atividades</h2>
        <button type="button" onClick={openCreateModal} className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800">Nova atividade</button>
      </div>

      <div className="overflow-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        {loading ? <div className="p-4 text-slate-500">Carregando...</div> : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 bg-brand-50 text-left text-brand-800"><th className="p-2">Tipo</th><th className="p-2">Notas</th><th className="p-2">Cliente</th><th className="p-2">Oportunidade</th><th className="p-2">Vencimento</th><th className="p-2">Vendedor</th><th className="p-2">Status</th><th className="p-2">Ações</th></tr></thead>
            <tbody>{activities.map((item) => <tr key={item.id} className="border-t border-slate-100"><td className="p-2 capitalize">{item.type}</td><td className="p-2">{item.notes}</td><td className="p-2">{item.opportunity?.client?.name || "—"}</td><td className="p-2">{item.opportunity?.title || "—"}</td><td className="p-2">{new Date(item.dueDate).toLocaleDateString("pt-BR")}</td><td className="p-2">{item.ownerSeller?.name || sellerMap.get(item.ownerSellerId) || item.ownerSellerId}</td><td className="p-2">{item.done ? "Concluída" : "Pendente"}</td><td className="p-2"><button type="button" className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-700" disabled={removingId===item.id} onClick={async()=>{if(!window.confirm('Tem certeza que deseja excluir esta atividade?'))return;setRemovingId(item.id);try{await api.delete(`/activities/${item.id}`);await loadData();}finally{setRemovingId(null);}}}>Excluir</button></td></tr>)}</tbody>
          </table>
        )}
      </div>

      {isModalOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"><div className="w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"><h3 className="mb-4 text-xl font-semibold">Nova atividade</h3><form onSubmit={onSubmit} className="space-y-4"><div className="grid gap-3 md:grid-cols-2"><div><label className="text-sm">Tipo</label><select className="w-full rounded-lg border border-slate-300 p-2" value={form.type} onChange={(e)=>setForm((p)=>({...p,type:e.target.value}))}><option value="ligacao">Ligação</option><option value="whatsapp">WhatsApp</option><option value="visita">Visita</option><option value="reuniao">Reunião</option></select></div><div><label className="text-sm">Vencimento</label><input type="date" required className="w-full rounded-lg border border-slate-300 p-2" value={form.dueDate} onChange={(e)=>setForm((p)=>({...p,dueDate:e.target.value}))}/></div>{!isSeller ? <div className="md:col-span-2"><label className="text-sm">Vendedor responsável</label><select required className="w-full rounded-lg border border-slate-300 p-2" value={form.ownerSellerId} onChange={(e)=>setForm((p)=>({...p,ownerSellerId:e.target.value}))}><option value="">Selecione o vendedor</option>{sellers.map((s)=><option key={s.id} value={s.id}>{s.name}</option>)}</select></div> : null}<div className="md:col-span-2"><label className="text-sm">Buscar cliente por nome</label><input className="w-full rounded-lg border border-slate-300 p-2" value={clientSearch} onChange={(e)=>setClientSearch(e.target.value)} placeholder="Digite para filtrar clientes"/><select required className="mt-1 w-full rounded-lg border border-slate-300 p-2" value={form.clientId} onChange={(e)=>{setForm((p)=>({...p,clientId:e.target.value,opportunityId:""}));setOpportunitySearch("");}}><option value="">Selecione o cliente</option>{filteredClients.map((c)=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div><div className="md:col-span-2"><label className="text-sm">Buscar oportunidade por título (opcional)</label><input className="w-full rounded-lg border border-slate-300 p-2" value={opportunitySearch} disabled={!form.clientId} onChange={(e)=>setOpportunitySearch(e.target.value)} placeholder="Digite para filtrar oportunidades"/><select className="mt-1 w-full rounded-lg border border-slate-300 p-2" value={form.opportunityId} onChange={(e)=>setForm((p)=>({...p,opportunityId:e.target.value}))}><option value="">Sem oportunidade vinculada</option>{filteredOpportunities.map((o)=><option key={o.id} value={o.id}>{o.title}</option>)}</select></div><div className="md:col-span-2"><label className="text-sm">Notas</label><textarea required className="min-h-24 w-full rounded-lg border border-slate-300 p-2" value={form.notes} onChange={(e)=>setForm((p)=>({...p,notes:e.target.value}))}/></div></div><div className="flex justify-end gap-2 border-t border-slate-200 pt-4"><button type="button" onClick={closeCreateModal} className="rounded-lg border border-slate-300 px-4 py-2">Cancelar</button><button type="submit" disabled={saving} className="rounded-lg bg-brand-700 px-4 py-2 text-white">{saving?"Salvando...":"Salvar"}</button></div></form></div></div> : null}
    </div>
  );
}
