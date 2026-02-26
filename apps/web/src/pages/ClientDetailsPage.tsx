import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import api from "../lib/apiClient";
import TimelineEventList, { TimelineEventItem } from "../components/TimelineEventList";

type Client = {
  id: string;
  name: string;
  city: string;
  state: string;
  region: string;
  potentialHa?: number | null;
  farmSizeHa?: number | null;
};

type Contact = {
  id: string;
  name: string;
  roleSector: string;
  phone: string;
  email: string;
  isPrimary: boolean;
};

type ContactFormState = {
  name: string;
  roleSector: string;
  phone: string;
  email: string;
  isPrimary: boolean;
};

const emptyContactForm: ContactFormState = {
  name: "",
  roleSector: "",
  phone: "",
  email: "",
  isPrimary: false
};

type DetailsTab = "timeline" | "contacts";

export default function ClientDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [client, setClient] = useState<Client | null>(null);
  const [events, setEvents] = useState<TimelineEventItem[]>([]);
  const [eventsCursor, setEventsCursor] = useState<string | null>(null);
  const [loadingMoreEvents, setLoadingMoreEvents] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<DetailsTab>("contacts");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isContactModalOpen, setIsContactModalOpen] = useState(false);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [contactForm, setContactForm] = useState<ContactFormState>(emptyContactForm);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [savingContact, setSavingContact] = useState(false);
  const [removingContactId, setRemovingContactId] = useState<string | null>(null);

  const loadContacts = useCallback(async () => {
    if (!id) return;

    setLoadingContacts(true);
    setContactsError(null);

    try {
      const response = await api.get(`/clients/${id}/contacts`);
      const normalizedContacts: Contact[] = (response.data || []).map((contact: any) => ({
        id: String(contact.id),
        name: String(contact.name || ""),
        roleSector: String(contact.roleSector || ""),
        phone: String(contact.phone || ""),
        email: String(contact.email || ""),
        isPrimary: Boolean(contact.isPrimary)
      }));
      setContacts(normalizedContacts);
    } catch {
      setContacts([]);
      setContactsError("Não foi possível carregar os contatos deste cliente.");
    } finally {
      setLoadingContacts(false);
    }
  }, [id]);

  useEffect(() => {
    const load = async () => {
      if (!id) return;
      setLoading(true);
      try {
        const [clientRes, eventsRes] = await Promise.all([
          api.get(`/clients/${id}`),
          api.get(`/events?clientId=${id}&take=20`)
        ]);
        setClient(clientRes.data);
        setEvents(eventsRes.data?.items || []);
        setEventsCursor(eventsRes.data?.nextCursor || null);
      } catch {
        toast.error("Não foi possível carregar os detalhes do cliente");
        navigate("/clientes");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [id, navigate]);

  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  const loadMoreEvents = async () => {
    if (!id || !eventsCursor) return;
    setLoadingMoreEvents(true);
    try {
      const response = await api.get(`/events?clientId=${id}&take=20&cursor=${eventsCursor}`);
      setEvents((current) => [...current, ...(response.data?.items || [])]);
      setEventsCursor(response.data?.nextCursor || null);
    } finally {
      setLoadingMoreEvents(false);
    }
  };

  if (loading) {
    return <div className="rounded-2xl border border-slate-200 bg-white p-6 text-slate-500">Carregando detalhes do cliente...</div>;
  }

  if (!client) return null;

  const openAddContactModal = () => {
    setEditingContactId(null);
    setContactForm(emptyContactForm);
    setIsContactModalOpen(true);
  };

  const openEditContactModal = (contact: Contact) => {
    setEditingContactId(contact.id);
    setContactForm({
      name: contact.name,
      roleSector: contact.roleSector,
      phone: contact.phone,
      email: contact.email,
      isPrimary: contact.isPrimary
    });
    setIsContactModalOpen(true);
  };

  const closeContactModal = () => {
    setIsContactModalOpen(false);
    setEditingContactId(null);
    setContactForm(emptyContactForm);
  };

  const saveContact = async () => {
    if (!id) return;
    if (!contactForm.name.trim() || !contactForm.email.trim()) {
      toast.error("Preencha pelo menos nome e email do contato.");
      return;
    }

    const payload = {
      name: contactForm.name.trim(),
      roleSector: contactForm.roleSector.trim(),
      phone: contactForm.phone.trim(),
      email: contactForm.email.trim(),
      isPrimary: contactForm.isPrimary
    };

    setSavingContact(true);
    try {
      if (editingContactId) {
        await api.put(`/clients/${id}/contacts/${editingContactId}`, payload);
      } else {
        await api.post(`/clients/${id}/contacts`, payload);
      }

      await loadContacts();
      toast.success(editingContactId ? "Contato atualizado com sucesso." : "Contato adicionado com sucesso.");
      closeContactModal();
    } catch {
      toast.error(editingContactId ? "Não foi possível atualizar o contato." : "Não foi possível adicionar o contato.");
    } finally {
      setSavingContact(false);
    }
  };

  const removeContact = async (contactId: string) => {
    if (!id) return;

    setRemovingContactId(contactId);
    try {
      await api.delete(`/clients/${id}/contacts/${contactId}`);
      await loadContacts();
      toast.success("Contato removido.");
    } catch {
      toast.error("Não foi possível remover o contato.");
    } finally {
      setRemovingContactId(null);
    }
  };

  return (
    <div className="space-y-4 pb-5">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-900">Detalhes do Cliente</h2>
        <button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={() => navigate("/clientes")}>Voltar</button>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-lg font-semibold">Resumo</h3>
        <div className="grid gap-2 text-sm md:grid-cols-2 lg:grid-cols-3">
          <p><strong>Nome:</strong> {client.name}</p>
          <p><strong>Cidade:</strong> {client.city}</p>
          <p><strong>UF:</strong> {client.state}</p>
          <p><strong>Região:</strong> {client.region}</p>
          <p><strong>Potencial (ha):</strong> {client.potentialHa ?? "-"}</p>
          <p><strong>Área total (ha):</strong> {client.farmSizeHa ?? "-"}</p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">
            <button
              type="button"
              onClick={() => setActiveTab("contacts")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${activeTab === "contacts" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-800"}`}
            >
              Contatos
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("timeline")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${activeTab === "timeline" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-800"}`}
            >
              Linha do Tempo
            </button>
          </div>

          {activeTab === "contacts" && (
            <button
              type="button"
              onClick={openAddContactModal}
              disabled={savingContact || Boolean(removingContactId) || loadingContacts}
              className="rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white transition hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Adicionar contato
            </button>
          )}
        </div>

        {activeTab === "contacts" ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-3 font-semibold">Nome</th>
                  <th className="px-2 py-3 font-semibold">Função/Setor</th>
                  <th className="px-2 py-3 font-semibold">Telefone</th>
                  <th className="px-2 py-3 font-semibold">Email</th>
                  <th className="px-2 py-3 font-semibold">Principal</th>
                  <th className="px-2 py-3 font-semibold">Ações</th>
                </tr>
              </thead>
              <tbody>
                {loadingContacts && (
                  <tr>
                    <td colSpan={6} className="px-2 py-8 text-center text-sm text-slate-500">
                      Carregando contatos...
                    </td>
                  </tr>
                )}

                {!loadingContacts && contactsError && (
                  <tr>
                    <td colSpan={6} className="px-2 py-8 text-center text-sm text-rose-600">
                      {contactsError}
                    </td>
                  </tr>
                )}

                {!loadingContacts && !contactsError && contacts.map((contact) => (
                  <tr key={contact.id} className="border-b border-slate-100 text-slate-700">
                    <td className="px-2 py-3 font-medium text-slate-900">{contact.name}</td>
                    <td className="px-2 py-3">{contact.roleSector || "-"}</td>
                    <td className="px-2 py-3">{contact.phone || "-"}</td>
                    <td className="px-2 py-3">{contact.email}</td>
                    <td className="px-2 py-3">
                      {contact.isPrimary ? (
                        <span className="inline-flex rounded-full bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-700">Principal</span>
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </td>
                    <td className="px-2 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => openEditContactModal(contact)}
                          disabled={savingContact || Boolean(removingContactId)}
                          className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          onClick={() => removeContact(contact.id)}
                          disabled={savingContact || Boolean(removingContactId)}
                          className="rounded-md border border-rose-200 px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {removingContactId === contact.id ? "Removendo..." : "Remover"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}

                {!loadingContacts && !contactsError && !contacts.length && (
                  <tr>
                    <td colSpan={6} className="px-2 py-8 text-center text-sm text-slate-500">
                      Nenhum contato cadastrado para este cliente.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            <h3 className="mb-3 text-lg font-semibold">Linha do Tempo</h3>
            <TimelineEventList
              events={events}
              loading={loading}
              hasMore={Boolean(eventsCursor)}
              loadingMore={loadingMoreEvents}
              onLoadMore={() => void loadMoreEvents()}
              emptyMessage="Sem interações registradas."
              loadingMessage="Carregando timeline..."
            />
          </>
        )}
      </section>

      {isContactModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-xl rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-lg font-semibold text-slate-900">
              {editingContactId ? "Editar contato" : "Adicionar contato"}
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              {editingContactId
                ? "Atualize os dados do contato vinculado ao cliente."
                : "Cadastre um novo contato para o cliente."}
            </p>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Nome</span>
                <input
                  value={contactForm.name}
                  onChange={(event) => setContactForm((current) => ({ ...current, name: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-600"
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-slate-700">Função/Setor</span>
                <input
                  value={contactForm.roleSector}
                  onChange={(event) => setContactForm((current) => ({ ...current, roleSector: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-600"
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-slate-700">Telefone</span>
                <input
                  value={contactForm.phone}
                  onChange={(event) => setContactForm((current) => ({ ...current, phone: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-600"
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-slate-700">Email</span>
                <input
                  type="email"
                  value={contactForm.email}
                  onChange={(event) => setContactForm((current) => ({ ...current, email: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-600"
                />
              </label>
            </div>

            <label className="mt-3 inline-flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={contactForm.isPrimary}
                onChange={(event) => setContactForm((current) => ({ ...current, isPrimary: event.target.checked }))}
                className="h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-600"
              />
              Definir como contato principal
            </label>

            <div className="mt-5 flex items-center gap-2">
              <button
                type="button"
                onClick={closeContactModal}
                disabled={savingContact}
                className="inline-flex flex-1 items-center justify-center rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void saveContact()}
                disabled={savingContact}
                className="inline-flex flex-1 items-center justify-center rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {savingContact ? "Salvando..." : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
