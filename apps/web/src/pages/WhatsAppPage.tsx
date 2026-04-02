import { useMemo, useState } from "react";
import {
  ArrowLeft,
  AudioLines,
  MessageCircle,
  Paperclip,
  Search,
  Send,
  UserRound,
  Workflow
} from "lucide-react";

type ConversationFilter = "all" | "unread" | "no-response";
type MessageDirection = "inbound" | "outbound";

type ConversationItem = {
  id: string;
  clientName: string;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
  noResponse: boolean;
  city: string;
  state: string;
  region: string;
  mainContact: string;
  phone: string;
};

type ChatMessage = {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  text: string;
  sentAt: string;
};

const filters: { id: ConversationFilter; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "unread", label: "Não lidas" },
  { id: "no-response", label: "Sem resposta" }
];

const mockConversations: ConversationItem[] = [
  {
    id: "1",
    clientName: "Fazenda Santa Helena",
    lastMessage: "Podemos revisar as condições para o fechamento?",
    lastMessageAt: "09:42",
    unreadCount: 2,
    noResponse: false,
    city: "Rio Verde",
    state: "GO",
    region: "Sudoeste Goiano",
    mainContact: "Marcelo Silva",
    phone: "(64) 99999-1111"
  },
  {
    id: "2",
    clientName: "Grupo Campo Forte",
    lastMessage: "Ainda sem retorno do comprador da unidade 3.",
    lastMessageAt: "Ontem",
    unreadCount: 0,
    noResponse: true,
    city: "Rondonópolis",
    state: "MT",
    region: "Sul Mato-Grossense",
    mainContact: "Rita Souza",
    phone: "(66) 98888-2222"
  },
  {
    id: "3",
    clientName: "Cooperativa Nova Safra",
    lastMessage: "Recebido, vamos validar internamente.",
    lastMessageAt: "08:17",
    unreadCount: 1,
    noResponse: false,
    city: "Uberlândia",
    state: "MG",
    region: "Triângulo Mineiro",
    mainContact: "Paulo Andrade",
    phone: "(34) 97777-3333"
  }
];

const mockMessages: ChatMessage[] = [
  {
    id: "m1",
    conversationId: "1",
    direction: "inbound",
    text: "Bom dia! Conseguimos antecipar a entrega do lote?",
    sentAt: "09:01"
  },
  {
    id: "m2",
    conversationId: "1",
    direction: "outbound",
    text: "Bom dia, Marcelo! Consigo confirmar com logística ainda hoje.",
    sentAt: "09:10"
  },
  {
    id: "m3",
    conversationId: "1",
    direction: "inbound",
    text: "Perfeito. Também queremos revisar as condições para o fechamento.",
    sentAt: "09:42"
  },
  {
    id: "m4",
    conversationId: "2",
    direction: "outbound",
    text: "Rita, seguimos aguardando a aprovação da proposta da unidade 3.",
    sentAt: "Ontem"
  },
  {
    id: "m5",
    conversationId: "3",
    direction: "inbound",
    text: "Recebemos o material técnico, obrigado.",
    sentAt: "08:17"
  }
];

export default function WhatsAppPage() {
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<ConversationFilter>("all");
  const [selectedConversationId, setSelectedConversationId] = useState(mockConversations[0]?.id ?? "");
  const [draft, setDraft] = useState("");
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const [localMessages, setLocalMessages] = useState(mockMessages);

  const visibleConversations = useMemo(() => {
    return mockConversations.filter((conversation) => {
      const byFilter =
        activeFilter === "all" ||
        (activeFilter === "unread" && conversation.unreadCount > 0) ||
        (activeFilter === "no-response" && conversation.noResponse);
      const bySearch =
        conversation.clientName.toLowerCase().includes(search.toLowerCase()) ||
        conversation.lastMessage.toLowerCase().includes(search.toLowerCase());

      return byFilter && bySearch;
    });
  }, [activeFilter, search]);

  const activeConversation =
    visibleConversations.find((conversation) => conversation.id === selectedConversationId) || visibleConversations[0] || null;

  const conversationMessages = localMessages.filter((message) => message.conversationId === activeConversation?.id);

  const openConversation = (conversationId: string) => {
    setSelectedConversationId(conversationId);
    setMobileView("chat");
  };

  const handleSend = () => {
    if (!draft.trim() || !activeConversation) return;

    setLocalMessages((current) => [
      ...current,
      {
        id: `${activeConversation.id}-${Date.now()}`,
        conversationId: activeConversation.id,
        direction: "outbound",
        text: draft.trim(),
        sentAt: "Agora"
      }
    ]);
    setDraft("");
  };

  return (
    <section className="space-y-4">
      <header className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h1 className="text-2xl font-bold text-slate-900">WhatsApp</h1>
        <p className="mt-1 text-sm text-slate-600">Canal visual de comunicação pronto para futura integração oficial.</p>
      </header>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="md:hidden">
          {mobileView === "list" && (
            <ConversationList
              conversations={visibleConversations}
              activeConversationId={activeConversation?.id}
              activeFilter={activeFilter}
              search={search}
              onChangeSearch={setSearch}
              onChangeFilter={setActiveFilter}
              onOpenConversation={openConversation}
            />
          )}

          {mobileView === "chat" && activeConversation && (
            <div className="flex h-[calc(100vh-210px)] flex-col">
              <button
                className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 text-sm font-medium text-slate-700"
                onClick={() => setMobileView("list")}
              >
                <ArrowLeft size={16} /> Voltar para conversas
              </button>
              <ChatColumn
                conversation={activeConversation}
                messages={conversationMessages}
                draft={draft}
                onChangeDraft={setDraft}
                onSend={handleSend}
              />
            </div>
          )}
        </div>

        <div className="hidden min-h-[calc(100vh-220px)] grid-cols-[340px_1fr_320px] md:grid">
          <ConversationList
            conversations={visibleConversations}
            activeConversationId={activeConversation?.id}
            activeFilter={activeFilter}
            search={search}
            onChangeSearch={setSearch}
            onChangeFilter={setActiveFilter}
            onOpenConversation={setSelectedConversationId}
          />

          {activeConversation ? (
            <ChatColumn
              conversation={activeConversation}
              messages={conversationMessages}
              draft={draft}
              onChangeDraft={setDraft}
              onSend={handleSend}
            />
          ) : (
            <div className="flex items-center justify-center border-x border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
              Selecione uma conversa para continuar.
            </div>
          )}

          {activeConversation && <ClientPanel conversation={activeConversation} />}
        </div>
      </div>
    </section>
  );
}

type ConversationListProps = {
  conversations: ConversationItem[];
  activeConversationId?: string;
  activeFilter: ConversationFilter;
  search: string;
  onChangeSearch: (value: string) => void;
  onChangeFilter: (value: ConversationFilter) => void;
  onOpenConversation: (conversationId: string) => void;
};

function ConversationList({
  conversations,
  activeConversationId,
  activeFilter,
  search,
  onChangeSearch,
  onChangeFilter,
  onOpenConversation
}: ConversationListProps) {
  return (
    <aside className="border-r border-slate-200 bg-white">
      <div className="space-y-3 border-b border-slate-200 p-4">
        <label className="relative block">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(event) => onChangeSearch(event.target.value)}
            placeholder="Buscar conversa"
            className="w-full rounded-lg border border-slate-200 py-2 pl-9 pr-3 text-sm outline-none transition focus:border-brand-500"
          />
        </label>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {filters.map((filter) => (
            <button
              key={filter.id}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                activeFilter === filter.id ? "bg-brand-700 text-white" : "bg-slate-100 text-slate-600"
              }`}
              onClick={() => onChangeFilter(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <ul className="max-h-[calc(100vh-340px)] overflow-y-auto md:max-h-[calc(100vh-300px)]">
        {conversations.map((conversation) => {
          const selected = activeConversationId === conversation.id;
          return (
            <li key={conversation.id}>
              <button
                onClick={() => onOpenConversation(conversation.id)}
                className={`w-full border-b border-slate-100 px-4 py-3 text-left transition ${
                  selected ? "bg-brand-50" : "hover:bg-slate-50"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="line-clamp-1 font-semibold text-slate-800">{conversation.clientName}</p>
                  <span className="shrink-0 text-xs text-slate-500">{conversation.lastMessageAt}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <p className="line-clamp-1 text-sm text-slate-600">{conversation.lastMessage}</p>
                  {conversation.unreadCount > 0 && (
                    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-emerald-600 px-1.5 py-0.5 text-[11px] font-bold text-white">
                      {conversation.unreadCount}
                    </span>
                  )}
                </div>
              </button>
            </li>
          );
        })}

        {conversations.length === 0 && <li className="p-4 text-sm text-slate-500">Nenhuma conversa encontrada.</li>}
      </ul>
    </aside>
  );
}

type ChatColumnProps = {
  conversation: ConversationItem;
  messages: ChatMessage[];
  draft: string;
  onChangeDraft: (value: string) => void;
  onSend: () => void;
};

function ChatColumn({ conversation, messages, draft, onChangeDraft, onSend }: ChatColumnProps) {
  return (
    <section className="flex h-full flex-col border-x border-slate-200 bg-[#f8fafc]">
      <header className="border-b border-slate-200 bg-white px-4 py-3">
        <p className="font-semibold text-slate-900">{conversation.clientName}</p>
        <p className="text-xs text-slate-500">Contato: {conversation.mainContact}</p>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((message) => (
          <div key={message.id} className={`flex ${message.direction === "outbound" ? "justify-end" : "justify-start"}`}>
            <article
              className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                message.direction === "outbound" ? "bg-brand-700 text-white" : "bg-white text-slate-700"
              }`}
            >
              <p>{message.text}</p>
              <p className={`mt-1 text-right text-[11px] ${message.direction === "outbound" ? "text-brand-100" : "text-slate-400"}`}>
                {message.sentAt}
              </p>
            </article>
          </div>
        ))}
      </div>

      <footer className="border-t border-slate-200 bg-white p-3">
        <div className="flex items-center gap-2">
          <button className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50" aria-label="Anexar arquivo">
            <Paperclip size={16} />
          </button>
          <input
            value={draft}
            onChange={(event) => onChangeDraft(event.target.value)}
            placeholder="Digite uma mensagem"
            className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-brand-500"
          />
          <button className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50" aria-label="Mensagem de áudio">
            <AudioLines size={16} />
          </button>
          <button className="rounded-lg bg-brand-700 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-800" onClick={onSend}>
            <Send size={16} />
          </button>
        </div>
      </footer>
    </section>
  );
}

function ClientPanel({ conversation }: { conversation: ConversationItem }) {
  return (
    <aside className="space-y-3 bg-white p-4">
      <article className="rounded-xl border border-slate-200 p-4">
        <h2 className="text-sm font-semibold text-slate-500">Cliente</h2>
        <p className="mt-1 text-lg font-bold text-slate-900">{conversation.clientName}</p>

        <dl className="mt-4 space-y-2 text-sm text-slate-600">
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Cidade/UF</dt>
            <dd>{conversation.city}/{conversation.state}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Região</dt>
            <dd>{conversation.region}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Contato</dt>
            <dd>{conversation.mainContact}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Telefone</dt>
            <dd>{conversation.phone}</dd>
          </div>
        </dl>
      </article>

      <div className="space-y-2">
        <button className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50">
          <UserRound size={15} /> Abrir cliente
        </button>
        <button className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50">
          <MessageCircle size={15} /> Criar atividade
        </button>
        <button className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50">
          <Workflow size={15} /> Vincular oportunidade
        </button>
      </div>
    </aside>
  );
}
