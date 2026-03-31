import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import api from "../lib/apiClient";
import TimelineEventList, { TimelineEventItem } from "../components/TimelineEventList";
import ClientAutoSummaryCard from "../components/clients/ClientAutoSummaryCard";

type CommercialSummary = {
  openOpportunitiesCount: number;
  lastActivityAt: string | null;
  lastPurchaseDate: string | null;
  lastPurchaseValue: number | null;
  totalCompletedActivities: number;
  clientCode?: string | null;
  fantasyName?: string | null;
  erpUpdatedAt?: string | null;
};

type Client = {
  id: string;
  name: string;
  city: string;
  state: string;
  region: string;
  potentialHa?: number | null;
  farmSizeHa?: number | null;
  commercialSummary?: CommercialSummary | null;
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

type ClientSuggestion = {
  status?: string | null;
  summary?: string | null;
  recommendation?: string | null;
  nextAction?: string | null;
  risk?: string | null;
  source?: "ai" | "deterministic" | null;
} | null;

const isValidSuggestion = (
  data: unknown
): data is {
  status?: string | null;
  summary?: string | null;
  recommendation?: string | null;
  nextAction?: string | null;
  risk?: string | null;
  source?: "ai" | "deterministic" | null;
} => {
  if (!data || typeof data !== "object") return false;

  const value = data as Record<string, unknown>;
  return (
    "status" in value &&
    (value.status === null || value.status === undefined || typeof value.status === "string") &&
    (!("source" in value) ||
      value.source === null ||
      value.source === undefined ||
      value.source === "ai" ||
      value.source === "deterministic")
  );
};

const emptyContactForm: ContactFormState = {
  name: "",
  roleSector: "",
  phone: "",
  email: "",
  isPrimary: false
};

type DetailsTab = "timeline" | "contacts";

const brDateFormatter = new Intl.DateTimeFormat("pt-BR");
const brlCurrencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL"
});

const formatDate = (value?: string | null) => {
  if (!value) return "-";

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) return "-";

  return brDateFormatter.format(parsedDate);
};

const formatCurrency = (value?: number | null) => {
  if (value == null) return "-";

  return brlCurrencyFormatter.format(value);
};

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
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [savingContact, setSavingContact] = useState(false);
  const [removingContactId, setRemovingContactId] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<ClientSuggestion>(null);
  const [loadingSuggestion, setLoadingSuggestion] = useState(false);

  const fetchSuggestion = useCallback(async (clientId: string) => {
    setSuggestion(null);
    setLoadingSuggestion(true);

    try {
      const response = await api.post("/ai/client-suggestion", { clientId });
      const data: unknown = response?.data;

      if (!isValidSuggestion(data) || !data.status) {
        setSuggestion(null);
        return;
      }

      setSuggestion(data);
    } catch (err) {
      console.error("[ClientDetailsPage] Falha ao carregar sugestão inteligente do cliente", {
        clientId,
        endpoint: "/ai/client-suggestion",
        err
      });
      setSuggestion(null);
    } finally {
      setLoadingSuggestion(false);
    }
  }, []);

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
    } catch (error) {
      console.error("[ClientDetailsPage] Falha ao carregar contatos do cliente", {
        clientId: id,
        endpoint: `/clients/${id}/contacts`,
        error
      });
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
      setEventsError(null);

      try {
        const clientRes = await api.get(`/clients/${id}`);
        setClient(clientRes.data);
      } catch (error) {
        console.error("[ClientDetailsPage] Falha ao carregar dados principais do cliente", {
          clientId: id,
          endpoint: `/clients/${id}`,
          error
        });
        toast.error("Não foi possível carregar os detalhes do cliente");
        navigate("/clientes");
        setLoading(false);
        return;
      }

      try {
        const eventsRes = await api.get(`/events?clientId=${id}&take=20`);
        setEvents(eventsRes.data?.items || []);
        setEventsCursor(eventsRes.data?.nextCursor || null);
      } catch (error) {
        console.error("[ClientDetailsPage] Falha ao carregar linha do tempo do cliente", {
          clientId: id,
          endpoint: `/events?clientId=${id}&take=20`,
          error
        });
        setEvents([]);
        setEventsCursor(null);
        setEventsError("Não foi possível carregar a linha do tempo deste cliente.");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [id, navigate]);

  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  useEffect(() => {
    if (!id) return;
    void fetchSuggestion(id);
  }, [id, fetchSuggestion]);

  const loadMoreEvents = async () => {
    if (!id || !eventsCursor) return;

    setLoadingMoreEvents(true);

    try {
      const response = await api.get(`/events?clientId=${id}&take=20&cursor=${eventsCursor}`);
      setEvents((current) => [...current, ...(response.data?.items || [])]);
      setEventsCursor(response.data?.nextCursor || null);
      setEventsError(null);
    } catch (error) {
      console.error("[ClientDetailsPage] Falha ao carregar mais eventos do cliente", {
        clientId: id,
        endpoint: `/events?clientId=${id}&take=20&cursor=${eventsCursor}`,
        error
      });
      setEventsError("Não foi possível carregar mais itens da linha do tempo.");
    } finally {
      setLoadingMoreEvents(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-slate-500">
        Carregando detalhes do cliente...
      </div>
    );
  }

  if (!client) return null;

  const formatPtBrDate = (value?: string | null) => {
    if (!value) return "-";

    const normalizedValue = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
    const parsedDate = new Date(normalizedValue);
    if (Number.isNaN(parsedDate.getTime())) return "-";

    return new Intl.DateTimeFormat("pt-BR").format(parsedDate);
  };

  const formatPtBrCurrency = (value?: number | null) => {
    if (typeof value !== "number") return "-";

    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL"
    }).format(value);
  };

  const erpData = {
    clientCode: client.commercialSummary?.clientCode,
    fantasyName: client.commercialSummary?.fantasyName,
    lastPurchaseDate: client.commercialSummary?.lastPurchaseDate,
    lastPurchaseValue: client.commercialSummary?.lastPurchaseValue,
    erpUpdatedAt: client.commercialSummary?.erpUpdatedAt
  };

  const hasErpData = Object.values(erpData).some((value) => value !== null && value !== undefined && value !== "");

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
        <button
          type="button"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          onClick={() => navigate("/clientes")}
        >
          Voltar
        </button>
      </div>

      <ClientAutoSummaryCard clientId={id} />

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-lg font-semibold">Resumo comercial</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Oportunidades abertas</p>
            <p className="mt-2 text-xl font-semibold text-slate-900">
              {client.commercialSummary?.openOpportunitiesCount ?? "-"}
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Última atividade</p>
            <p className="mt-2 text-xl font-semibold text-slate-900">
              {formatDate(client.commercialSummary?.lastActivityAt)}
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Última compra</p>
            <p className="mt-2 text-xl font-semibold text-slate-900">
              {formatDate(client.commercialSummary?.lastPurchaseDate)}
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Valor última compra</p>
            <p className="mt-2 text-xl font-semibold text-slate-900">
              {formatCurrency(client.commercialSummary?.lastPurchaseValue)}
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Atividades concluídas</p>
            <p className="mt-2 text-xl font-semibold text-slate-900">
              {client.commercialSummary?.totalCompletedActivities ?? "-"}
            </p>
          </div>
        </div>
      </section>

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

      {hasErpData ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-lg font-semibold">Dados ERP</h3>
          <div className="grid gap-2 text-sm md:grid-cols-2 lg:grid-cols-3">
            <p><strong>Código:</strong> {erpData.clientCode || "-"}</p>
            <p><strong>Nome fantasia:</strong> {erpData.fantasyName || "-"}</p>
            <p><strong>Última compra:</strong> {formatPtBrDate(erpData.lastPurchaseDate)}</p>
            <p><strong>Valor:</strong> {formatPtBrCurrency(erpData.lastPurchaseValue)}</p>
            <p><strong>Atualizado em:</strong> {formatPtBrDate(erpData.erpUpdatedAt)}</p>
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="text-lg font-semibold">Sugestão inteligente</h3>
          {!loadingSuggestion && suggestion?.source ? (
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-600">
              Fonte: {suggestion.source === "ai" ? "IA" : "sistema"}
            </span>
          ) : null}
        </div>

        {loadingSuggestion ? (
          <div className="space-y-3 animate-pulse">
            <div className="h-4 w-1/3 rounded bg-slate-200" />
            <div className="h-4 w-4/5 rounded bg-slate-200" />
            <div className="h-4 w-3/5 rounded bg-slate-200" />
            <div className="h-4 w-2/3 rounded bg-slate-200" />
            <div className="h-4 w-1/4 rounded bg-slate-200" />
          </div>
        ) : suggestion ? (
          <div className="grid gap-2 text-sm md:grid-cols-2">
            <p><strong>Status:</strong> {suggestion.status || "-"}</p>
            <p><strong>Risco:</strong> {suggestion.risk || "-"}</p>
            <p className="md:col-span-2"><strong>Resumo:</strong> {suggestion.summary || "-"}</p>
            <p className="md:col-span-2"><strong>Recomendação:</strong> {suggestion.recommendation || "-"}</p>
            <p className="md:col-span-2"><strong>Próxima ação:</strong> {suggestion.nextAction || "-"}</p>
          </div>
        ) : (
          <p className="text-sm text-slate-500">Sem sugestão disponível</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">
            <button
              type="button"
              onClick={() => setActiveTab("contacts")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                activeTab === "contacts"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-800"
              }`}
            >
              Contatos
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("timeline")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                activeTab === "timeline"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-800"
              }`}
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
          <div className="w-full overflow-x-auto">
            <table className="min-w-[600px] w-full text-sm">
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
                        <span className="inline-flex rounded-full bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-700">
                          Principal
                        </span>
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
            {eventsError ? (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                {eventsError}
              </div>
            ) : null}
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
          role="dialog"
          aria-modal="true"
        >
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
                  onChange={(event) =>
                    setContactForm((current) => ({ ...current, name: event.target.value }))
                  }
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-600"
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-slate-700">Função/Setor</span>
                <input
                  value={contactForm.roleSector}
                  onChange={(event) =>
                    setContactForm((current) => ({ ...current, roleSector: event.target.value }))
                  }
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-600"
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-slate-700">Telefone</span>
                <input
                  value={contactForm.phone}
                  onChange={(event) =>
                    setContactForm((current) => ({ ...current, phone: event.target.value }))
                  }
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-600"
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-slate-700">Email</span>
                <input
                  type="email"
                  value={contactForm.email}
                  onChange={(event) =>
                    setContactForm((current) => ({ ...current, email: event.target.value }))
                  }
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-600"
                />
              </label>
            </div>

            <label className="mt-3 inline-flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={contactForm.isPrimary}
                onChange={(event) =>
                  setContactForm((current) => ({ ...current, isPrimary: event.target.checked }))
                }
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
