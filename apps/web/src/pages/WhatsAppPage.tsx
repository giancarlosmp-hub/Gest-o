import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Copy, ExternalLink, MessageCircle, Search, Sparkles, Check } from "lucide-react";
import api from "../lib/apiClient";

type Client = {
  id: string;
  name: string;
  fantasyName?: string | null;
  city: string;
  state: string;
  region: string;
  ownerSeller?: { id: string; name: string } | null;
};

type Contact = { id: string; name: string; phone: string; isPrimary?: boolean };

type GeneratedMessage = { message: string; source: "ai" | "deterministic"; fallback: boolean };

const normalizePhone = (value?: string | null) => String(value || "").replace(/\D/g, "");

export default function WhatsAppPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [search, setSearch] = useState("");
  const [selectedClientId, setSelectedClientId] = useState("");
  const [draft, setDraft] = useState("");
  const [loadingClients, setLoadingClients] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [lastGeneration, setLastGeneration] = useState<GeneratedMessage | null>(null);

  useEffect(() => {
    let active = true;
    setLoadingClients(true);
    api
      .get<Client[] | { items: Client[] }>("/clients")
      .then((response) => {
        if (!active) return;
        const data = Array.isArray(response.data) ? response.data : response.data.items || [];
        setClients(data);
        setSelectedClientId((current) => current || data[0]?.id || "");
      })
      .catch(() => toast.error("Não foi possível carregar clientes."))
      .finally(() => active && setLoadingClients(false));
    return () => {
      active = false;
    };
  }, []);

  const selectedClient = clients.find((client) => client.id === selectedClientId) || null;

  useEffect(() => {
    if (!selectedClient) {
      setContacts([]);
      return;
    }
    let active = true;
    api
      .get<Contact[]>(`/clients/${selectedClient.id}/contacts`)
      .then((response) => active && setContacts(response.data || []))
      .catch(() => active && setContacts([]));
    return () => {
      active = false;
    };
  }, [selectedClient]);

  const visibleClients = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return clients;
    return clients.filter((client) => [client.name, client.fantasyName, client.city, client.state, client.region].some((value) => String(value || "").toLowerCase().includes(term)));
  }, [clients, search]);

  const primaryContact = contacts.find((contact) => contact.isPrimary) || contacts[0] || null;
  const phone = normalizePhone(primaryContact?.phone);

  const generateMessage = async () => {
    if (!selectedClient) return;
    setGenerating(true);
    try {
      const response = await api.post<GeneratedMessage>("/ai/assistant-whatsapp-message", { clientId: selectedClient.id });
      setDraft(response.data.message);
      setLastGeneration(response.data);
      toast.success(response.data.fallback ? "Mensagem gerada com fallback." : "Mensagem gerada pela IA.");
    } catch {
      toast.error("Não foi possível gerar a mensagem.");
    } finally {
      setGenerating(false);
    }
  };

  const copyMessage = async () => {
    if (!draft.trim()) return;
    await navigator.clipboard.writeText(draft.trim());
    toast.success("Mensagem copiada.");
  };

  const openWhatsApp = () => {
    const encodedText = encodeURIComponent(draft.trim());
    const url = phone ? `https://wa.me/55${phone}?text=${encodedText}` : `https://web.whatsapp.com/send?text=${encodedText}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const registerContact = async () => {
    if (!selectedClient) return;
    setRegistering(true);
    try {
      await api.post("/assistant-whatsapp/contact", { clientId: selectedClient.id });
      toast.success("Contato registrado na timeline e atividades.");
    } catch {
      toast.error("Não foi possível registrar o contato.");
    } finally {
      setRegistering(false);
    }
  };

  return (
    <section className="space-y-4">
      <header className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h1 className="text-2xl font-bold text-slate-900">Assistente Comercial WhatsApp</h1>
        <p className="mt-1 text-sm text-slate-600">Gere, edite, copie e abra o WhatsApp. Nenhuma mensagem é enviada automaticamente.</p>
      </header>

      <div className="grid overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm md:grid-cols-[340px_1fr]">
        <aside className="border-r border-slate-200">
          <div className="border-b border-slate-200 p-4">
            <label className="relative block">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar cliente" className="w-full rounded-lg border border-slate-200 py-2 pl-9 pr-3 text-sm outline-none transition focus:border-brand-500" />
            </label>
          </div>
          <ul className="max-h-[calc(100vh-300px)] overflow-y-auto">
            {loadingClients && <li className="p-4 text-sm text-slate-500">Carregando clientes...</li>}
            {visibleClients.map((client) => (
              <li key={client.id}>
                <button onClick={() => { setSelectedClientId(client.id); setDraft(""); setLastGeneration(null); }} className={`w-full border-b border-slate-100 px-4 py-3 text-left transition ${selectedClientId === client.id ? "bg-brand-50" : "hover:bg-slate-50"}`}>
                  <p className="line-clamp-1 font-semibold text-slate-800">{client.name}</p>
                  <p className="mt-1 text-xs text-slate-500">{client.city}/{client.state} · {client.ownerSeller?.name || "Vendedor não informado"}</p>
                </button>
              </li>
            ))}
            {!loadingClients && visibleClients.length === 0 && <li className="p-4 text-sm text-slate-500">Nenhum cliente encontrado.</li>}
          </ul>
        </aside>

        <main className="space-y-4 bg-slate-50 p-4">
          {selectedClient ? (
            <>
              <article className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">{selectedClient.name}</h2>
                    <p className="text-sm text-slate-600">{selectedClient.city}/{selectedClient.state} · {selectedClient.region}</p>
                    <p className="mt-1 text-xs text-slate-500">Contato: {primaryContact ? `${primaryContact.name} ${primaryContact.phone ? `(${primaryContact.phone})` : ""}` : "não cadastrado"}</p>
                  </div>
                  <button onClick={generateMessage} disabled={generating} className="inline-flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60">
                    <Sparkles size={16} /> {generating ? "Gerando..." : "Gerar mensagem IA"}
                  </button>
                </div>
              </article>

              <article className="rounded-xl border border-slate-200 bg-white p-4">
                <label className="text-sm font-semibold text-slate-700" htmlFor="whatsapp-draft">Mensagem editável</label>
                <textarea id="whatsapp-draft" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Clique em Gerar mensagem IA ou escreva sua mensagem." className="mt-2 min-h-44 w-full rounded-xl border border-slate-200 p-3 text-sm text-slate-700 outline-none transition focus:border-brand-500" />
                <div className="mt-3 flex flex-wrap gap-2">
                  <button onClick={copyMessage} disabled={!draft.trim()} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Copy size={16} /> Copiar</button>
                  <button onClick={openWhatsApp} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"><ExternalLink size={16} /> Abrir WhatsApp</button>
                  <button onClick={registerContact} disabled={registering} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"><Check size={16} /> {registering ? "Registrando..." : "Registrar contato"}</button>
                </div>
                {lastGeneration && <p className="mt-3 text-xs text-slate-500">Origem: {lastGeneration.source === "ai" ? "IA" : "fallback determinístico"}. Envio automático desabilitado.</p>}
              </article>

              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                <MessageCircle className="mr-2 inline" size={16} /> Este assistente apenas prepara a abordagem e registra o contato. O envio depende de ação manual do vendedor no WhatsApp.
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Selecione um cliente para gerar uma mensagem.</div>
          )}
        </main>
      </div>
    </section>
  );
}
