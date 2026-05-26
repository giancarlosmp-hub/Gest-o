import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import api from "../lib/apiClient";
import { formatCurrencyBRL, formatDateBR, formatPercentBR } from "../lib/formatters";
import { triggerDashboardRefresh } from "../lib/dashboardRefresh";
import { getApiErrorMessage } from "../lib/apiError";
import ClientAutoSummaryCard from "../components/clients/ClientAutoSummaryCard";

type Stage = "prospeccao" | "negociacao" | "proposta" | "ganho" | "perdido";
type EventType = "comentario" | "mudanca_etapa" | "status";

type OpportunityInsight = {
  risk: "baixo" | "medio" | "alto";
  nextAction: string;
  message: string;
  observationInsight?: {
    sentiment: "positivo" | "neutro" | "negativo";
    interestLevel: "alto" | "medio" | "baixo";
    detectedIntent:
      | "pediu_proposta"
      | "negociacao_preco"
      | "aguardando_decisao"
      | "sem_interesse"
      | "quer_retorno"
      | "indefinido";
    suggestedNextAction: string;
    suggestedFollowUpDays: number | null;
    keywords: string[];
  };
};

type EventItem = {
  id: string;
  type: EventType;
  description: string;
  createdAt: string;
  ownerSeller?: {
    id: string;
    name: string;
  } | null;
};

type Opportunity = {
  id: string;
  clientId: string;
  title: string;
  client?: string;
  owner?: string;
  ownerSeller?: {
    id: string;
    name: string;
    erpCode?: string | null;
    erpOperatorCode?: string | null;
  } | null;
  stage: Stage;
  value: number;
  probability?: number | null;
  weightedValue?: number;
  proposalDate: string;
  expectedCloseDate: string;
  plantingForecastDate?: string | null;
  crop?: string | null;
  season?: string | null;
  areaHa?: number | null;
  productOffered?: string | null;
  expectedTicketPerHa?: number | null;
  lastContactAt?: string | null;
  notes?: string | null;
  daysOverdue?: number | null;
};

type ClientErpSummary = {
  id: string;
  name: string;
  fantasyName?: string | null;
  code?: string | null;
  city?: string | null;
  state?: string | null;
  cnpj?: string | null;
};

type OpportunityItem = {
  id: string;
  lineNumber: number;
  erpProductCode?: string | null;
  erpProductClassCode?: string | null;
  productNameSnapshot: string;
  unit?: string | null;
  quantity: number;
  unitPrice: number;
  grossTotal: number;
  discountTotal: number;
  netTotal: number;
  product?: {
    id: string;
    erpProductCode?: string | null;
    stockQuantity?: number | null;
    defaultPrice?: number | null;
    minPrice?: number | null;
  } | null;
};

type OpportunityItemTotals = {
  grossTotal: number;
  discountTotal: number;
  netTotal: number;
};

type ErpOption = {
  code: string;
  label: string;
  description?: string;
};

type ErpOrderForm = {
  paymentMethodCode: string;
  receivingConditionCode: string;
  priceTableCode: string;
  branchCode: string;
  operationCode: string;
  simulateOnly: boolean;
};

type ErpOrderFeedback = {
  status: "enviado" | "simulado" | "erro";
  pedidoIdImportacao?: string;
  erpOrderNumber?: string | null;
  message?: string;
};

type ErpOrderSync = {
  id: string;
  pedidoIdImportacao: string;
  numPedido?: string | null;
  erpOrderNumber?: string | null;
  status: "pending" | "sent" | "error";
  orderStatus?: "pendente" | "faturado" | "parcial" | "cancelado" | "entregue" | null;
  createdAt: string;
  sentAt?: string | null;
  statusSyncedAt?: string | null;
};

const stageFlow: Stage[] = ["prospeccao", "negociacao", "proposta", "ganho"];
const stageLabel: Record<Stage, string> = {
  prospeccao: "Prospecção",
  negociacao: "Negociação",
  proposta: "Proposta",
  ganho: "Ganho",
  perdido: "Perdido"
};

const eventLabel: Record<EventType, string> = {
  comentario: "Comentário",
  mudanca_etapa: "Mudança de etapa",
  status: "Status"
};


const riskLabel: Record<OpportunityInsight["risk"], string> = {
  baixo: "Baixo",
  medio: "Médio",
  alto: "Alto"
};

const riskClassName: Record<OpportunityInsight["risk"], string> = {
  baixo: "text-emerald-700",
  medio: "text-amber-700",
  alto: "text-red-700"
};

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short"
});

const emptyErpOrderForm: ErpOrderForm = {
  paymentMethodCode: "",
  receivingConditionCode: "",
  priceTableCode: "",
  branchCode: "",
  operationCode: "",
  simulateOnly: false
};

const getTextValue = (value: unknown) => (value == null ? "" : String(value).trim());

const readFirstText = (source: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = getTextValue(source[key]);
    if (value) return value;
  }
  return "";
};

const toErpOptions = (payload: unknown): ErpOption[] => {
  const rows = Array.isArray(payload) ? payload : Array.isArray((payload as any)?.items) ? (payload as any).items : Array.isArray((payload as any)?.data) ? (payload as any).data : [];

  return rows
    .map((row: unknown) => {
      if (!row || typeof row !== "object") return null;
      const record = row as Record<string, unknown>;
      const code = readFirstText(record, ["code", "codigo", "CODIGO", "id", "ID", "value", "COD", "cod", "CODFILIAL", "CODOPER", "CODCONDREC", "FORMA", "TABELA_PRECO"]);
      if (!code) return null;
      const name = readFirstText(record, ["name", "nome", "NOME", "description", "descricao", "DESCRICAO", "label", "fantasyName", "razaoSocial"]);
      const detail = readFirstText(record, ["type", "tipo", "city", "cidade", "state", "uf"]);
      return {
        code,
        label: name ? `${name} · ${code}` : code,
        description: detail || undefined
      };
    })
    .filter((option: ErpOption | null): option is ErpOption => Boolean(option));
};

const firstOptionCode = (options: ErpOption[]) => options[0]?.code || "";

const statusPillClassName: Record<"success" | "warning" | "danger" | "neutral", string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  danger: "border-red-200 bg-red-50 text-red-700",
  neutral: "border-slate-200 bg-slate-50 text-slate-600"
};

function StatusPill({ tone, children }: { tone: keyof typeof statusPillClassName; children: string }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${statusPillClassName[tone]}`}>{children}</span>;
}

function SearchableSelect({
  label,
  value,
  options,
  loading,
  placeholder,
  onChange
}: {
  label: string;
  value: string;
  options: ErpOption[];
  loading?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const selectedOption = options.find((option) => option.code === value);
  const [query, setQuery] = useState(selectedOption?.label || "");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setQuery(selectedOption?.label || value || "");
  }, [selectedOption?.label, value]);

  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options.slice(0, 20);
    return options.filter((option) => `${option.label} ${option.code} ${option.description || ""}`.toLowerCase().includes(normalized)).slice(0, 20);
  }, [options, query]);

  return (
    <label className="relative block text-sm">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <input
        value={query}
        disabled={loading}
        placeholder={loading ? "Carregando..." : placeholder || "Pesquisar e selecionar"}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(event) => {
          const nextQuery = event.target.value;
          setQuery(nextQuery);
          setOpen(true);
          const exact = options.find((option) => option.label === nextQuery || option.code === nextQuery);
          onChange(exact?.code || "");
        }}
        className="w-full rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-sm font-medium text-slate-800 shadow-sm outline-none transition focus:border-brand-500 focus:ring-4 focus:ring-brand-100 disabled:bg-slate-100 disabled:text-slate-500"
      />
      {open && !loading ? (
        <div className="absolute z-50 mt-2 max-h-64 w-full overflow-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl shadow-slate-900/10">
          {filteredOptions.length ? filteredOptions.map((option) => (
            <button
              key={`${label}-${option.code}`}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(option.code);
                setQuery(option.label);
                setOpen(false);
              }}
              className={`w-full rounded-xl px-3 py-2 text-left text-sm transition hover:bg-brand-50 ${option.code === value ? "bg-brand-50 text-brand-800" : "text-slate-700"}`}
            >
              <span className="block font-semibold">{option.label}</span>
              {option.description ? <span className="block text-xs text-slate-500">{option.description}</span> : null}
            </button>
          )) : <div className="px-3 py-2 text-sm text-slate-500">Nenhuma opção encontrada.</div>}
        </div>
      ) : null}
    </label>
  );
}

export default function OpportunityDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [item, setItem] = useState<Opportunity | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [interactionNote, setInteractionNote] = useState("");
  const [showLossModal, setShowLossModal] = useState(false);
  const [lossReason, setLossReason] = useState("");
  const [events, setEvents] = useState<EventItem[]>([]);
  const [insight, setInsight] = useState<OpportunityInsight | null>(null);
  const [salesMessage, setSalesMessage] = useState("");
  const [loadingSalesMessage, setLoadingSalesMessage] = useState(false);
  const [showErpOrderModal, setShowErpOrderModal] = useState(false);
  const [loadingErpOrderData, setLoadingErpOrderData] = useState(false);
  const [sendingErpOrder, setSendingErpOrder] = useState(false);
  const [clientErpSummary, setClientErpSummary] = useState<ClientErpSummary | null>(null);
  const [opportunityItems, setOpportunityItems] = useState<OpportunityItem[]>([]);
  const [opportunityItemTotals, setOpportunityItemTotals] = useState<OpportunityItemTotals>({ grossTotal: 0, discountTotal: 0, netTotal: 0 });
  const [paymentMethods, setPaymentMethods] = useState<ErpOption[]>([]);
  const [receivingConditions, setReceivingConditions] = useState<ErpOption[]>([]);
  const [priceTables, setPriceTables] = useState<ErpOption[]>([]);
  const [branches, setBranches] = useState<ErpOption[]>([]);
  const [operations, setOperations] = useState<ErpOption[]>([]);
  const [erpOrderForm, setErpOrderForm] = useState<ErpOrderForm>(emptyErpOrderForm);
  const [erpOrderFeedback, setErpOrderFeedback] = useState<ErpOrderFeedback | null>(null);
  const [erpOrders, setErpOrders] = useState<ErpOrderSync[]>([]);
  const [syncingErpOrderStatus, setSyncingErpOrderStatus] = useState(false);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [opportunityResponse, eventsResponse, insightResponse, itemsResponse] = await Promise.all([
        api.get(`/opportunities/${id}`),
        api.get(`/events?opportunityId=${id}`),
        api.post("/ai/opportunity-insight", { opportunityId: id }),
        api.get(`/opportunities/${id}/items`)
      ]);
      setItem(opportunityResponse.data);
      setEvents(eventsResponse.data?.items || []);
      setInsight(insightResponse.data || null);
      setOpportunityItems(Array.isArray(itemsResponse.data?.items) ? itemsResponse.data.items : []);
      setOpportunityItemTotals(itemsResponse.data?.totals || { grossTotal: 0, discountTotal: 0, netTotal: 0 });
    } catch {
      toast.error("Não foi possível carregar a oportunidade");
      navigate("/oportunidades");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load().catch(() => toast.error("Erro ao carregar detalhes"));
  }, [id]);

  const valuePerHa = useMemo(() => {
    if (!item?.areaHa || item.areaHa <= 0) return null;
    return item.value / item.areaHa;
  }, [item]);

  const estimatedTicketTotal = useMemo(() => {
    if (!item?.areaHa || !item?.expectedTicketPerHa) return null;
    return item.areaHa * item.expectedTicketPerHa;
  }, [item]);

  const sellerErpCode = item?.ownerSeller?.erpCode?.trim() || "";
  const clientErpCode = clientErpSummary?.code?.trim() || "";
  const itemsWithMissingErp = opportunityItems.filter((opportunityItem) => !opportunityItem.erpProductCode?.trim());
  const itemsWithInsufficientStock = opportunityItems.filter((opportunityItem) => {
    const stockQuantity = opportunityItem.product?.stockQuantity;
    return typeof stockQuantity === "number" && stockQuantity < Number(opportunityItem.quantity || 0);
  });
  const orderTotal = opportunityItemTotals.netTotal || item?.value || 0;
  const erpOrderEligibilityReasons = [
    item?.stage !== "ganho" ? "A oportunidade precisa estar na etapa Ganha." : null,
    opportunityItems.length === 0 ? "A oportunidade precisa ter pelo menos um item." : null,
    !clientErpCode ? "Cliente sem código ERP vinculado." : null,
    !sellerErpCode || !item?.ownerSeller?.erpOperatorCode?.trim() ? "Vendedor sem vínculo ERP/Login FV3 configurado." : null
  ].filter(Boolean) as string[];
  const canGenerateErpOrder = erpOrderEligibilityReasons.length === 0;
  const erpOrderDisabledReason = erpOrderEligibilityReasons[0] || null;

  const setErpOrderField = (field: keyof Omit<ErpOrderForm, "simulateOnly">, value: string) => {
    setErpOrderForm((current) => ({ ...current, [field]: value }));
  };

  const loadErpOrderData = async () => {
    if (!item) return;
    setLoadingErpOrderData(true);
    setErpOrderFeedback(null);
    try {
      const [itemsResponse, clientResponse, paymentMethodsResponse, receivingConditionsResponse, priceTablesResponse, branchesResponse, operationsResponse, erpOrdersResponse] = await Promise.all([
        api.get(`/opportunities/${item.id}/items`),
        api.get(`/clients/${item.clientId}`),
        api.get("/erp/ultrafv3/payment-methods"),
        api.get("/erp/ultrafv3/receiving-conditions"),
        api.get("/erp/ultrafv3/price-tables"),
        api.get("/erp/ultrafv3/branches"),
        api.get("/erp/ultrafv3/operations"),
        api.get(`/opportunities/${item.id}/erp/orders`)
      ]);

      const nextPaymentMethods = toErpOptions(paymentMethodsResponse.data);
      const nextReceivingConditions = toErpOptions(receivingConditionsResponse.data);
      const nextPriceTables = toErpOptions(priceTablesResponse.data);
      const nextBranches = toErpOptions(branchesResponse.data);
      const nextOperations = toErpOptions(operationsResponse.data);

      setOpportunityItems(Array.isArray(itemsResponse.data?.items) ? itemsResponse.data.items : []);
      setOpportunityItemTotals(itemsResponse.data?.totals || { grossTotal: 0, discountTotal: 0, netTotal: 0 });
      setClientErpSummary(clientResponse.data || null);
      setPaymentMethods(nextPaymentMethods);
      setReceivingConditions(nextReceivingConditions);
      setPriceTables(nextPriceTables);
      setBranches(nextBranches);
      setOperations(nextOperations);
      setErpOrders(Array.isArray(erpOrdersResponse.data?.items) ? erpOrdersResponse.data.items : []);
      setErpOrderForm((current) => ({
        ...current,
        paymentMethodCode: current.paymentMethodCode || firstOptionCode(nextPaymentMethods),
        receivingConditionCode: current.receivingConditionCode || firstOptionCode(nextReceivingConditions),
        priceTableCode: current.priceTableCode || firstOptionCode(nextPriceTables),
        branchCode: current.branchCode || firstOptionCode(nextBranches),
        operationCode: current.operationCode || firstOptionCode(nextOperations)
      }));
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível carregar dados do ERP"));
    } finally {
      setLoadingErpOrderData(false);
    }
  };

  const openErpOrderModal = () => {
    setShowErpOrderModal(true);
    loadErpOrderData().catch((error) => toast.error(getApiErrorMessage(error, "Não foi possível preparar o pedido ERP")));
  };

  useEffect(() => {
    if (!item || searchParams.get("openErpOrder") !== "1") return;
    if (!showErpOrderModal && canGenerateErpOrder) openErpOrderModal();
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("openErpOrder");
    setSearchParams(nextParams, { replace: true });
  }, [item?.id, canGenerateErpOrder, showErpOrderModal]);

  const onSendErpOrder = async () => {
    if (!item) return;
    setSendingErpOrder(true);
    setErpOrderFeedback(null);
    try {
      const response = await api.post(`/opportunities/${item.id}/erp/orders`, erpOrderForm);
      setErpOrderFeedback({ status: response.data?.simulated ? "simulado" : "enviado", pedidoIdImportacao: response.data?.pedidoIdImportacao, erpOrderNumber: response.data?.erpOrderNumber });
      if (!response.data?.simulated) {
        const ordersResponse = await api.get(`/opportunities/${item.id}/erp/orders`);
        setErpOrders(Array.isArray(ordersResponse.data?.items) ? ordersResponse.data.items : []);
      }
      toast.success(response.data?.simulated ? "Simulação ERP validada sem envio real" : "Pedido enviado ao ERP");
    } catch (error) {
      const message = getApiErrorMessage(error, "Erro ERP ao enviar pedido");
      const maybeResponse = (error as any)?.response?.data;
      setErpOrderFeedback({ status: "erro", pedidoIdImportacao: maybeResponse?.pedidoIdImportacao, message });
      toast.error(message);
    } finally {
      setSendingErpOrder(false);
    }
  };


  const onSyncErpOrderStatus = async () => {
    if (!item) return;
    setSyncingErpOrderStatus(true);
    try {
      const response = await api.post(`/opportunities/${item.id}/erp/orders/status`);
      setErpOrders(Array.isArray(response.data?.items) ? response.data.items : []);
      toast.success("Status ERP atualizado");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível atualizar status ERP"));
    } finally {
      setSyncingErpOrderStatus(false);
    }
  };

  const registerEvent = async (payload: { type?: EventType; description: string }) => {
    if (!item) return;

    await api.post("/events", {
      type: payload.type || "comentario",
      description: payload.description,
      opportunityId: item.id,
    });
  };

  const updateOpportunity = async (payload: Partial<Opportunity>) => {
    if (!item) return;
    setSaving(true);
    try {
      await api.put(`/opportunities/${item.id}`, payload);
      await load();
      triggerDashboardRefresh({ month: new Date().toISOString().slice(0, 7) });
    } finally {
      setSaving(false);
    }
  };

  const onRegisterInteraction = async (event: FormEvent) => {
    event.preventDefault();
    if (!item) return;

    const newEntry = interactionNote.trim();
    if (!newEntry) {
      toast.error("Escreva uma nota para registrar a interação");
      return;
    }

    const now = new Date();

    await Promise.all([
      registerEvent({ type: "comentario", description: newEntry }),
      updateOpportunity({ lastContactAt: now.toISOString() })
    ]);

    setInteractionNote("");
    toast.success("Interação registrada");
  };

  const onAdvanceStage = async () => {
    if (!item) return;
    if (item.stage === "ganho" || item.stage === "perdido") {
      toast.error("A oportunidade já está encerrada");
      return;
    }
    const currentIndex = stageFlow.indexOf(item.stage);
    const nextStage = stageFlow[Math.min(currentIndex + 1, stageFlow.length - 1)];
    await updateOpportunity({ stage: nextStage });
    toast.success("Etapa avançada");
  };

  const onMarkWon = async () => {
    await updateOpportunity({ stage: "ganho" });
    await registerEvent({ type: "status", description: "Oportunidade marcada como ganho" });
    toast.success("Oportunidade marcada como ganho");
  };

  const onMarkLost = async (event: FormEvent) => {
    event.preventDefault();
    if (!lossReason.trim()) {
      toast.error("Informe o motivo da perda");
      return;
    }

    await updateOpportunity({ stage: "perdido" });
    await registerEvent({ type: "status", description: `Motivo da perda: ${lossReason.trim()}` });

    toast.success("Oportunidade marcada como perdida");
    setLossReason("");
    setShowLossModal(false);
  };

  const onGenerateSalesMessage = async () => {
    if (!item?.id) return;
    setLoadingSalesMessage(true);
    try {
      const response = await api.get("/ai/opportunity-message", { params: { opportunityId: item.id } });
      const generatedMessage = response.data?.message;
      if (!generatedMessage) {
        toast.error("Não foi possível gerar a mensagem");
        return;
      }
      setSalesMessage(generatedMessage);
      toast.success("Mensagem gerada");
    } catch {
      toast.error("Erro ao gerar mensagem comercial");
    } finally {
      setLoadingSalesMessage(false);
    }
  };

  const onCopySalesMessage = async () => {
    if (!salesMessage) return;
    try {
      await navigator.clipboard.writeText(salesMessage);
      toast.success("Mensagem copiada");
    } catch {
      toast.error("Não foi possível copiar a mensagem");
    }
  };

  if (loading) {
    return <div className="rounded-2xl border border-slate-200 bg-white p-6 text-slate-500">Carregando detalhes da oportunidade...</div>;
  }

  if (!item) return null;

  return (
    <div className="space-y-4 pb-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h2 className="text-2xl font-bold text-slate-900">Visão da Oportunidade</h2>
        <div className="mobile-action-stack md:justify-end">
          <button
            type="button"
            disabled={!canGenerateErpOrder}
            className="mobile-primary-button rounded-xl bg-gradient-to-r from-brand-700 to-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-brand-900/20 hover:from-brand-800 hover:to-slate-950 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-400"
            onClick={openErpOrderModal}
            title={!canGenerateErpOrder ? erpOrderDisabledReason || undefined : undefined}
          >
            Gerar pedido ERP
          </button>
          <button type="button" className="mobile-secondary-half rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={() => navigate("/oportunidades")}>Voltar</button>
        </div>
      </div>

      {item.daysOverdue && item.daysOverdue > 0 ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          Atenção: oportunidade atrasada há {item.daysOverdue} dia(s).
        </div>
      ) : null}
      {!canGenerateErpOrder ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <strong>Gerar pedido ERP indisponível:</strong> {erpOrderDisabledReason}
        </div>
      ) : null}

      <ClientAutoSummaryCard clientId={item.clientId} />

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-lg font-semibold">Resumo</h3>
        <div className="grid gap-2 text-sm md:grid-cols-2 lg:grid-cols-3">
          <p><strong>Título:</strong> {item.title}</p>
          <p><strong>Cliente:</strong> {item.clientId ? <Link className="text-brand-700" to={`/clientes/${item.clientId}`}>{item.client || "-"}</Link> : (item.client || "-")}</p>
          <p><strong>Vendedor:</strong> {item.owner || "-"}</p>
          <p><strong>Etapa:</strong> {stageLabel[item.stage]}</p>
          <p><strong>Valor:</strong> {formatCurrencyBRL(item.value)}</p>
          <p><strong>Probabilidade:</strong> {formatPercentBR(item.probability || 0, 0)}</p>
          <p><strong>Ponderado:</strong> {formatCurrencyBRL(item.weightedValue || 0)}</p>
          <p><strong>Entrada proposta:</strong> {formatDateBR(item.proposalDate)}</p>
          <p><strong>Retorno previsto:</strong> {formatDateBR(item.expectedCloseDate)}</p>
          <p><strong>Previsão plantio:</strong> {formatDateBR(item.plantingForecastDate || "")}</p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-lg font-semibold">Bloco Agro</h3>
        <div className="grid gap-2 text-sm md:grid-cols-2 lg:grid-cols-3">
          <p><strong>Cultura:</strong> {item.crop || "-"}</p>
          <p><strong>Safra:</strong> {item.season || "-"}</p>
          <p><strong>Área (ha):</strong> {item.areaHa ?? "-"}</p>
          <p><strong>Produto ofertado:</strong> {item.productOffered || "-"}</p>
          <p><strong>Ticket por ha:</strong> {item.expectedTicketPerHa ? formatCurrencyBRL(item.expectedTicketPerHa) : "-"}</p>
          <p><strong>Valor/ha:</strong> {valuePerHa ? formatCurrencyBRL(valuePerHa) : "-"}</p>
          <p><strong>Ticket estimado total:</strong> {estimatedTicketTotal ? formatCurrencyBRL(estimatedTicketTotal) : "-"}</p>
        </div>
      </section>


      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-lg font-semibold">🧠 Sugestão do sistema</h3>
        {insight ? (
          <div className="space-y-2 text-sm">
            <p><strong>Risco:</strong> <span className={riskClassName[insight.risk]}>{riskLabel[insight.risk]}</span></p>
            <p><strong>Próxima ação:</strong> {insight.nextAction}</p>
            <p><strong>Mensagem:</strong> {insight.message}</p>
            <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 p-3">
              <p><strong>Intenção detectada:</strong> {insight.observationInsight?.detectedIntent || "indefinido"}</p>
              <p><strong>Interesse:</strong> {insight.observationInsight?.interestLevel || "medio"}</p>
              <p><strong>Palavras-chave:</strong> {insight.observationInsight?.keywords?.length ? insight.observationInsight.keywords.join(", ") : "-"}</p>
            </div>
          </div>
        ) : <p className="text-sm text-slate-500">Sem sugestão disponível no momento.</p>}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-lg font-semibold">📩 Mensagem comercial</h3>
        <div className="mobile-action-stack">
          <button
            type="button"
            disabled={loadingSalesMessage}
            onClick={onGenerateSalesMessage}
            className="mobile-primary-button rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:bg-slate-500"
          >
            📩 Gerar mensagem
          </button>
          {salesMessage ? (
            <button
              type="button"
              onClick={onCopySalesMessage}
              className="mobile-secondary-half rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              Copiar
            </button>
          ) : null}
        </div>
        {salesMessage ? (
          <p className="mt-3 whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{salesMessage}</p>
        ) : (
          <p className="text-sm text-slate-500">Gere um texto rápido para contato com o cliente.</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-lg font-semibold">Registrar Interação</h3>
        <p className="text-sm"><strong>Última interação:</strong> {item.lastContactAt ? formatDateBR(item.lastContactAt) : "Sem interação registrada"}</p>
        <form className="mt-3 space-y-2" onSubmit={onRegisterInteraction}>
          <textarea className="w-full rounded-lg border border-slate-200 p-2 text-sm" rows={3} placeholder="Escreva um resumo da interação" value={interactionNote} onChange={(event) => setInteractionNote(event.target.value)} />
          <button type="submit" disabled={saving} className="mobile-primary-button rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:bg-slate-500">Salvar</button>
        </form>

        <h3 className="mt-5 mb-3 text-lg font-semibold">Linha do Tempo</h3>
        <div className="space-y-2">
          {events.length ? events.map((event) => (
            <div key={event.id} className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-800">{eventLabel[event.type]}</span>
                <span className="text-xs text-slate-500">{dateTimeFormatter.format(new Date(event.createdAt))}</span>
              </div>
              <p className="mt-1 text-slate-700">{event.description}</p>
              <p className="mt-1 text-xs text-slate-500">por {event.ownerSeller?.name || "Usuário"}</p>
            </div>
          )) : <p className="text-sm text-slate-500">Sem interações registradas.</p>}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-lg font-semibold">Ações</h3>
        <div className="mobile-action-stack">
          <button type="button" disabled={saving} onClick={onAdvanceStage} className="mobile-secondary-half rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-50">Avançar etapa</button>
          <button type="button" disabled={saving} onClick={onMarkWon} className="mobile-primary-button rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white disabled:opacity-50">Marcar como ganho</button>
          <button type="button" disabled={saving} onClick={() => setShowLossModal(true)} className="mobile-primary-button rounded-lg bg-red-600 px-3 py-2 text-sm text-white disabled:opacity-50">Marcar como perdido</button>
        </div>
      </section>

      {showErpOrderModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-3 backdrop-blur-sm md:p-6" onClick={() => setShowErpOrderModal(false)}>
          <div className="flex max-h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-[2rem] border border-white/20 bg-slate-50 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="relative overflow-hidden bg-gradient-to-br from-slate-950 via-brand-900 to-slate-800 px-5 py-5 text-white md:px-7">
              <div className="absolute right-0 top-0 h-40 w-40 rounded-full bg-white/10 blur-3xl" />
              <div className="relative flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.25em] text-brand-100">UltraFV3</p>
                  <h3 className="mt-2 text-2xl font-bold md:text-3xl">Gerar pedido ERP</h3>
                  <p className="mt-2 max-w-3xl text-sm text-slate-200">Revise vínculos, estoque, itens e parâmetros comerciais antes do envio. As validações críticas permanecem no backend.</p>
                </div>
                <button type="button" className="rounded-full border border-white/20 px-4 py-2 text-sm font-semibold text-white/90 hover:bg-white/10" onClick={() => setShowErpOrderModal(false)}>Fechar</button>
              </div>
            </div>

            <div className="overflow-y-auto p-4 md:p-6">
              {loadingErpOrderData ? (
                <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-slate-500 shadow-sm">Carregando dados comerciais e referências ERP...</div>
              ) : (
                <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
                  <div className="space-y-5">
                    <div className="grid gap-4 lg:grid-cols-2">
                      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Cliente ERP</p>
                            <h4 className="mt-1 text-lg font-bold text-slate-900">{clientErpSummary?.fantasyName || clientErpSummary?.name || item.client || "Cliente"}</h4>
                            <p className="text-sm text-slate-500">{[clientErpSummary?.city, clientErpSummary?.state].filter(Boolean).join(" / ") || "Localização não informada"}</p>
                          </div>
                          {clientErpCode ? <StatusPill tone="success">ERP vinculado</StatusPill> : <StatusPill tone="danger">Cliente sem ERP</StatusPill>}
                        </div>
                        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                          <div className="rounded-2xl bg-slate-50 p-3"><span className="block text-xs text-slate-500">Código ERP</span><strong>{clientErpCode || "Sem vínculo"}</strong></div>
                          <div className="rounded-2xl bg-slate-50 p-3"><span className="block text-xs text-slate-500">CPF/CNPJ</span><strong>{clientErpSummary?.cnpj || "-"}</strong></div>
                        </div>
                      </section>

                      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Vendedor ERP</p>
                            <h4 className="mt-1 text-lg font-bold text-slate-900">{item.ownerSeller?.name || item.owner || "Vendedor"}</h4>
                            <p className="text-sm text-slate-500">Responsável comercial da oportunidade</p>
                          </div>
                          {sellerErpCode ? <StatusPill tone="success">ERP vinculado</StatusPill> : <StatusPill tone="warning">Sem vínculo</StatusPill>}
                        </div>
                        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                          <div className="rounded-2xl bg-slate-50 p-3"><span className="block text-xs text-slate-500">Código vendedor</span><strong>{sellerErpCode || "Sem vínculo"}</strong></div>
                          <div className="rounded-2xl bg-slate-50 p-3"><span className="block text-xs text-slate-500">Operador</span><strong>{item.ownerSeller?.erpOperatorCode || "-"}</strong></div>
                        </div>
                      </section>
                    </div>

                    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                      <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Parâmetros do pedido</p>
                          <h4 className="text-lg font-bold text-slate-900">Condições comerciais UltraFV3</h4>
                        </div>
                        <StatusPill tone="neutral">Selects pesquisáveis</StatusPill>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                        <SearchableSelect label="Forma de pagamento" value={erpOrderForm.paymentMethodCode} options={paymentMethods} loading={loadingErpOrderData} onChange={(value) => setErpOrderField("paymentMethodCode", value)} />
                        <SearchableSelect label="Condição de recebimento" value={erpOrderForm.receivingConditionCode} options={receivingConditions} loading={loadingErpOrderData} onChange={(value) => setErpOrderField("receivingConditionCode", value)} />
                        <SearchableSelect label="Tabela de preço" value={erpOrderForm.priceTableCode} options={priceTables} loading={loadingErpOrderData} onChange={(value) => setErpOrderField("priceTableCode", value)} />
                        <SearchableSelect label="Filial" value={erpOrderForm.branchCode} options={branches} loading={loadingErpOrderData} onChange={(value) => setErpOrderField("branchCode", value)} />
                        <SearchableSelect label="Operação" value={erpOrderForm.operationCode} options={operations} loading={loadingErpOrderData} onChange={(value) => setErpOrderField("operationCode", value)} />
                      </div>
                      <label className="mt-4 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4 rounded border-amber-300"
                          checked={erpOrderForm.simulateOnly}
                          onChange={(event) => setErpOrderForm((current) => ({ ...current, simulateOnly: event.target.checked }))}
                        />
                        <span><strong>Simulação ERP:</strong> validar payload, vínculos, parâmetros, preço e estoque sem enviar pedido real ao UltraFV3.</span>
                      </label>
                    </section>

                    <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
                      <div className="border-b border-slate-100 p-5">
                        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Produtos da oportunidade</p>
                            <h4 className="text-lg font-bold text-slate-900">Itens, estoque disponível e totais</h4>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {itemsWithMissingErp.length ? <StatusPill tone="danger">Produto sem ERP</StatusPill> : <StatusPill tone="success">Produtos vinculados</StatusPill>}
                            {itemsWithInsufficientStock.length ? <StatusPill tone="warning">Estoque insuficiente</StatusPill> : <StatusPill tone="success">Estoque disponível</StatusPill>}
                          </div>
                        </div>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-slate-100 text-sm">
                          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                            <tr>
                              <th className="px-5 py-3 font-semibold">Produto</th>
                              <th className="px-5 py-3 font-semibold">ERP</th>
                              <th className="px-5 py-3 font-semibold">Qtd.</th>
                              <th className="px-5 py-3 font-semibold">Estoque</th>
                              <th className="px-5 py-3 font-semibold">Preço</th>
                              <th className="px-5 py-3 font-semibold">Total</th>
                              <th className="px-5 py-3 font-semibold">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 bg-white">
                            {opportunityItems.length ? opportunityItems.map((opportunityItem) => {
                              const stockQuantity = opportunityItem.product?.stockQuantity;
                              const insufficientStock = typeof stockQuantity === "number" && stockQuantity < Number(opportunityItem.quantity || 0);
                              const missingErp = !opportunityItem.erpProductCode?.trim();
                              return (
                                <tr key={opportunityItem.id} className="align-top">
                                  <td className="px-5 py-4">
                                    <p className="font-semibold text-slate-900">{opportunityItem.productNameSnapshot}</p>
                                    <p className="text-xs text-slate-500">Linha {opportunityItem.lineNumber} · {opportunityItem.unit || "sem unidade"}</p>
                                  </td>
                                  <td className="px-5 py-4 text-slate-700">{opportunityItem.erpProductCode || "-"}</td>
                                  <td className="px-5 py-4 text-slate-700">{Number(opportunityItem.quantity || 0).toLocaleString("pt-BR")}</td>
                                  <td className="px-5 py-4 text-slate-700">{typeof stockQuantity === "number" ? stockQuantity.toLocaleString("pt-BR") : "Não informado"}</td>
                                  <td className="px-5 py-4 text-slate-700">{formatCurrencyBRL(opportunityItem.unitPrice || 0)}</td>
                                  <td className="px-5 py-4 font-semibold text-slate-900">{formatCurrencyBRL(opportunityItem.netTotal || 0)}</td>
                                  <td className="px-5 py-4">
                                    <div className="flex flex-col gap-1">
                                      {missingErp ? <StatusPill tone="danger">Produto sem ERP</StatusPill> : <StatusPill tone="success">ERP vinculado</StatusPill>}
                                      {insufficientStock ? <StatusPill tone="warning">Estoque insuficiente</StatusPill> : null}
                                    </div>
                                  </td>
                                </tr>
                              );
                            }) : (
                              <tr><td colSpan={7} className="px-5 py-8 text-center text-slate-500">Nenhum produto cadastrado na oportunidade.</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  </div>

                  <aside className="space-y-5">
                    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm xl:sticky xl:top-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Resumo financeiro</p>
                      <h4 className="mt-1 text-lg font-bold text-slate-900">Pedido ERP</h4>
                      <div className="mt-5 space-y-3">
                        <div className="flex items-center justify-between rounded-2xl bg-slate-50 p-3"><span className="text-slate-500">Valor bruto</span><strong>{formatCurrencyBRL(opportunityItemTotals.grossTotal || item.value || 0)}</strong></div>
                        <div className="flex items-center justify-between rounded-2xl bg-slate-50 p-3"><span className="text-slate-500">Descontos</span><strong>{formatCurrencyBRL(opportunityItemTotals.discountTotal || 0)}</strong></div>
                        <div className="rounded-2xl bg-gradient-to-br from-brand-700 to-slate-900 p-4 text-white shadow-lg shadow-brand-900/20">
                          <span className="text-sm text-brand-100">Total líquido</span>
                          <strong className="mt-1 block text-2xl">{formatCurrencyBRL(orderTotal)}</strong>
                        </div>
                      </div>
                      <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
                        <div className="rounded-2xl border border-slate-100 p-3"><span className="block text-xs text-slate-500">Itens</span><strong>{opportunityItems.length}</strong></div>
                        <div className="rounded-2xl border border-slate-100 p-3"><span className="block text-xs text-slate-500">Oportunidade</span><strong>{stageLabel[item.stage]}</strong></div>
                      </div>

                      {erpOrderFeedback ? (
                        <div className={`mt-5 rounded-2xl border p-4 text-sm ${erpOrderFeedback.status !== "erro" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"}`}>
                          <p className="font-bold">{erpOrderFeedback.status === "simulado" ? "Simulação ERP validada" : erpOrderFeedback.status === "enviado" ? "Pedido enviado" : "Erro ERP"}</p>
                          {erpOrderFeedback.pedidoIdImportacao ? <p className="mt-1 break-all">pedidoIdImportacao: <strong>{erpOrderFeedback.pedidoIdImportacao}</strong></p> : null}
                          {erpOrderFeedback.erpOrderNumber ? <p className="mt-1">Pedido ERP: <strong>{erpOrderFeedback.erpOrderNumber}</strong></p> : null}
                          {erpOrderFeedback.message ? <p className="mt-1">{erpOrderFeedback.message}</p> : null}
                        </div>
                      ) : null}


                      <div className="mt-5 rounded-2xl border border-slate-100 bg-slate-50 p-3 text-sm">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <strong>Pedidos ERP gerados</strong>
                          <button type="button" className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold disabled:opacity-60" disabled={syncingErpOrderStatus || !erpOrders.length} onClick={onSyncErpOrderStatus}>
                            {syncingErpOrderStatus ? "Atualizando..." : "Atualizar status"}
                          </button>
                        </div>
                        {erpOrders.length ? (
                          <div className="space-y-2">
                            {erpOrders.map((order) => (
                              <div key={order.id} className="rounded-xl bg-white p-3">
                                <div className="flex flex-wrap items-center gap-2">
                                  <StatusPill tone={order.status === "sent" ? "success" : order.status === "error" ? "danger" : "warning"}>{order.status === "sent" ? "enviado" : order.status === "error" ? "erro" : "pendente"}</StatusPill>
                                  {order.orderStatus ? <StatusPill tone={order.orderStatus === "cancelado" ? "danger" : order.orderStatus === "pendente" ? "warning" : "success"}>{order.orderStatus}</StatusPill> : null}
                                </div>
                                <p className="mt-2 break-all text-xs text-slate-600">Importação: {order.pedidoIdImportacao}</p>
                                <p className="text-xs text-slate-600">Pedido: {order.erpOrderNumber || order.numPedido || "-"}</p>
                              </div>
                            ))}
                          </div>
                        ) : <p className="text-xs text-slate-500">Nenhum pedido ERP enviado para esta oportunidade.</p>}
                      </div>

                      <button
                        type="button"
                        disabled={sendingErpOrder || loadingErpOrderData || !canGenerateErpOrder}
                        onClick={onSendErpOrder}
                        className="mt-5 w-full rounded-2xl bg-slate-950 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-slate-900/20 transition hover:bg-brand-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                      >
                        {sendingErpOrder ? (erpOrderForm.simulateOnly ? "Validando simulação..." : "Enviando ao ERP...") : erpOrderForm.simulateOnly ? "Validar simulação ERP" : "Enviar pedido ao ERP"}
                      </button>
                      <p className="mt-3 text-center text-xs text-slate-500">O backend bloqueia cliente/vendedor sem ERP, oportunidade sem itens, preço zerado, estoque insuficiente e payload inválido antes do envio.</p>
                    </section>
                  </aside>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {showLossModal ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4" onClick={() => setShowLossModal(false)}>
          <form className="w-full max-w-lg space-y-3 rounded-2xl bg-white p-5" onSubmit={onMarkLost} onClick={(event) => event.stopPropagation()}>
            <h4 className="text-lg font-semibold text-slate-900">Motivo da perda</h4>
            <textarea className="w-full rounded-lg border border-slate-200 p-2 text-sm" rows={4} placeholder="Descreva o motivo" value={lossReason} onChange={(event) => setLossReason(event.target.value)} />
            <div className="mobile-action-stack justify-end">
              <button type="button" className="mobile-secondary-half rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={() => setShowLossModal(false)}>Cancelar</button>
              <button type="submit" className="mobile-primary-button rounded-lg bg-red-600 px-3 py-2 text-sm text-white">Confirmar perda</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
