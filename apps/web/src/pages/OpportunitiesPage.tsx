import { DragEvent, FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import api from "../lib/apiClient";
import { formatCurrencyBRL, formatDateBR, formatPercentBR } from "../lib/formatters";
import { useAuth } from "../context/AuthContext";
import TimelineEventList, { TimelineEventItem } from "../components/TimelineEventList";

type Stage = "prospeccao" | "negociacao" | "proposta" | "ganho" | "perdido";
type ReturnStatus = "overdue" | "dueSoon" | "ok";
type ViewMode = "list" | "pipeline";

type Opportunity = {
  id: string;
  title: string;
  value: number;
  stage: Stage;
  crop?: string | null;
  season?: string | null;
  proposalDate: string;
  followUpDate: string;
  expectedCloseDate: string;
  lastContactAt?: string | null;
  probability?: number | null;
  notes?: string | null;
  clientId: string;
  ownerSellerId: string;
  client?: { id: string; name: string } | string;
  ownerSeller?: { id: string; name: string };
  owner?: string;
  clientCity?: string | null;
  clientState?: string | null;
  weightedValue?: number;
  areaHa?: number | null;
  productOffered?: string | null;
  plantingForecastDate?: string | null;
  expectedTicketPerHa?: number | null;
};

type Client = { id: string; name: string };
type Summary = {
  totalPipelineValue: number;
  totalWeightedValue: number;
  overdueCount: number;
  overdueValue: number;
};

type Filters = {
  stage: string;
  ownerSellerId: string;
  clientId: string;
  crop: string;
  season: string;
  dateFrom: string;
  dateTo: string;
  overdue: boolean;
};

type FormState = {
  title: string;
  value: string;
  stage: Stage;
  probability: string;
  proposalEntryDate: string;
  expectedReturnDate: string;
  crop: string;
  season: string;
  areaHa: string;
  productOffered: string;
  plantingForecastDate: string;
  expectedTicketPerHa: string;
  lastContactAt: string;
  notes: string;
  clientId: string;
  ownerSellerId: string;
};

type DragOpportunityPayload = {
  opportunityId: string;
  sourceStage: Stage;
};

const stages: Stage[] = ["prospeccao", "negociacao", "proposta", "ganho", "perdido"];
const cropSelectOptions = ["soja", "milho", "trigo", "pasto", "cobertura", "outros"];

const stageLabel: Record<Stage, string> = {
  prospeccao: "Prospecção",
  negociacao: "Negociação",
  proposta: "Proposta",
  ganho: "Ganho",
  perdido: "Perdido"
};

const stageWeight: Record<Stage, number> = {
  prospeccao: 20,
  negociacao: 40,
  proposta: 70,
  ganho: 100,
  perdido: 0
};

const emptyForm: FormState = {
  title: "",
  value: "",
  stage: "prospeccao",
  probability: "",
  proposalEntryDate: "",
  expectedReturnDate: "",
  crop: "",
  season: "",
  areaHa: "",
  productOffered: "",
  plantingForecastDate: "",
  expectedTicketPerHa: "",
  lastContactAt: "",
  notes: "",
  clientId: "",
  ownerSellerId: ""
};

const emptySummary: Summary = {
  totalPipelineValue: 0,
  totalWeightedValue: 0,
  overdueCount: 0,
  overdueValue: 0
};

const PIPELINE_VIEW_STORAGE_KEY = "opportunities:viewMode";

function toDateInput(value?: string | null) {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function sanitizeNumericInput(value: string, allowDecimal = true) {
  const normalized = value.replace(/,/g, ".").replace(/[^\d.]/g, "");
  if (!allowDecimal) return normalized.replace(/\./g, "");
  const [int, ...decimals] = normalized.split(".");
  if (!decimals.length) return int;
  return `${int}.${decimals.join("")}`;
}

function toDayStart(dateLike?: string | null) {
  if (!dateLike) return null;
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export default function OpportunitiesPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<Opportunity[]>([]);
  const [summary, setSummary] = useState<Summary>(emptySummary);
  const [clients, setClients] = useState<Client[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isAddingComment, setIsAddingComment] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const navigate = useNavigate();
  const [filters, setFilters] = useState<Filters>({
    stage: "",
    ownerSellerId: "",
    clientId: "",
    crop: "",
    season: "",
    dateFrom: "",
    dateTo: "",
    overdue: false
  });
  const [opportunityEvents, setOpportunityEvents] = useState<TimelineEventItem[]>([]);
  const [loadingOpportunityEvents, setLoadingOpportunityEvents] = useState(false);
  const [opportunityComment, setOpportunityComment] = useState("");
  const [selectedOpportunity, setSelectedOpportunity] = useState<Opportunity | null>(null);
  const [isPipelineDrawerOpen, setIsPipelineDrawerOpen] = useState(false);
  const [pipelineInteraction, setPipelineInteraction] = useState("");
  const [isSavingPipelineInteraction, setIsSavingPipelineInteraction] = useState(false);
  const [pipelineEvents, setPipelineEvents] = useState<TimelineEventItem[]>([]);
  const [loadingPipelineEvents, setLoadingPipelineEvents] = useState(false);
  const [loadingMorePipelineEvents, setLoadingMorePipelineEvents] = useState(false);
  const [pipelineEventsCursor, setPipelineEventsCursor] = useState<string | null>(null);
  const [isQuickActionLoading, setIsQuickActionLoading] = useState<"ganho" | "perdido" | null>(null);
  const [isSchedulingFollowUp, setIsSchedulingFollowUp] = useState(false);
  const [pipelineFollowUpDate, setPipelineFollowUpDate] = useState("");
  const isSeller = user?.role === "vendedor";
  const canFilterByOwner = user?.role === "diretor" || user?.role === "gerente";

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 400);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!user?.id) return;
    const savedMode = localStorage.getItem(`${PIPELINE_VIEW_STORAGE_KEY}:${user.id}`);
    if (savedMode === "list" || savedMode === "pipeline") setViewMode(savedMode);
  }, [user?.id]);

  useEffect(() => {
    if (!isSeller || !user?.id) return;
    setFilters((prev) => ({ ...prev, ownerSellerId: user.id }));
  }, [isSeller, user?.id]);

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    if (!user?.id) return;
    localStorage.setItem(`${PIPELINE_VIEW_STORAGE_KEY}:${user.id}`, mode);
  };

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (typeof value === "boolean") {
          if (value) params.set(key, "true");
          return;
        }
        if (value) params.set(key, value);
      });
      if (debouncedSearch) params.set("search", debouncedSearch);

      const query = params.toString() ? `?${params}` : "";
      const [oppRes, summaryRes, clientsRes] = await Promise.all([
        api.get(`/opportunities${query}`),
        api.get("/opportunities/summary"),
        api.get("/clients")
      ]);

      setItems(oppRes.data || []);
      setSummary(summaryRes.data || emptySummary);
      setClients(clientsRes.data || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load().catch(() => toast.error("Erro ao carregar oportunidades"));
  }, [filters, debouncedSearch]);

  const sellers = useMemo(() => {
    const map = new Map<string, string>();
    items.forEach((item) => {
      if (item.ownerSeller?.id && item.ownerSeller?.name) map.set(item.ownerSeller.id, item.ownerSeller.name);
      if (item.ownerSellerId && item.owner) map.set(item.ownerSellerId, item.owner);
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [items]);

  const cropOptions = useMemo(() => {
    const dynamic = Array.from(new Set(items.map((item) => item.crop).filter(Boolean))) as string[];
    return Array.from(new Set([...cropSelectOptions, ...dynamic]));
  }, [items]);
  const seasonOptions = useMemo(() => Array.from(new Set(items.map((item) => item.season).filter(Boolean))) as string[], [items]);

  const getReturnStatus = (item: Opportunity): ReturnStatus => {
    if (["ganho", "perdido"].includes(item.stage)) return "ok";
    const todayStart = toDayStart(new Date().toISOString());
    const followUpDay = toDayStart(item.followUpDate || item.expectedCloseDate);

    if (!todayStart || !followUpDay) return "ok";
    if (followUpDay < todayStart) return "overdue";

    const limit = new Date(todayStart);
    limit.setDate(limit.getDate() + 2);
    if (followUpDay <= limit) return "dueSoon";

    return "ok";
  };

  const statusPriority: Record<ReturnStatus, number> = { overdue: 0, dueSoon: 1, ok: 2 };

  const sortByPipelinePriority = (a: Opportunity, b: Opportunity) => {
    const byStatus = statusPriority[getReturnStatus(a)] - statusPriority[getReturnStatus(b)];
    if (byStatus !== 0) return byStatus;
    return Number(b.value || 0) - Number(a.value || 0);
  };

  const sortedItems = useMemo(() => [...items].sort(sortByPipelinePriority), [items]);

  const conversionRate = useMemo(() => {
    if (!items.length) return 0;
    const won = items.filter((item) => item.stage === "ganho").length;
    return (won / items.length) * 100;
  }, [items]);

  const getClientName = (item: Opportunity) => {
    if (typeof item.client === "string") return item.client;
    return item.client?.name || item.clientId;
  };

  const getSellerName = (item: Opportunity) => item.ownerSeller?.name || item.owner || item.ownerSellerId;

  const opportunitiesByStage = useMemo(() => {
    return stages.reduce<Record<Stage, Opportunity[]>>((acc, stage) => {
      acc[stage] = sortedItems.filter((item) => item.stage === stage).sort(sortByPipelinePriority);
      return acc;
    }, { prospeccao: [], negociacao: [], proposta: [], ganho: [], perdido: [] });
  }, [sortedItems]);

  const getWeightedValue = (item: Opportunity) => {
    const probability = item.probability ?? stageWeight[item.stage];
    return Number(item.value || 0) * (Number(probability || 0) / 100);
  };

  const handlePipelineCardDragStart = (event: DragEvent<HTMLDivElement>, item: Opportunity) => {
    const payload: DragOpportunityPayload = {
      opportunityId: item.id,
      sourceStage: item.stage
    };
    event.dataTransfer.setData("application/json", JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "move";
  };

  const handlePipelineColumnDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handlePipelineColumnDrop = async (event: DragEvent<HTMLDivElement>, destinationStage: Stage) => {
    event.preventDefault();

    const payloadRaw = event.dataTransfer.getData("application/json");
    if (!payloadRaw) return;

    let payload: DragOpportunityPayload;
    try {
      payload = JSON.parse(payloadRaw) as DragOpportunityPayload;
    } catch {
      return;
    }

    if (payload.sourceStage === destinationStage) return;

    const previousItems = items;
    const targetOpportunity = previousItems.find((item) => item.id === payload.opportunityId);
    if (!targetOpportunity) return;

    setItems((currentItems) => currentItems.map((item) => (
      item.id === payload.opportunityId ? { ...item, stage: destinationStage } : item
    )));

    try {
      await api.put(`/opportunities/${payload.opportunityId}`, { stage: destinationStage });
    } catch {
      setItems(previousItems);
      toast.error("Não foi possível mover a oportunidade de etapa");
      load().catch(() => toast.error("Erro ao atualizar pipeline"));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();

    const value = Number(form.value);
    const probability = Number(form.probability);
    if (Number.isNaN(value) || value < 0) {
      toast.error("Valor precisa ser maior ou igual a zero");
      return;
    }
    if (Number.isNaN(probability) || probability < 0 || probability > 100) {
      toast.error("Probabilidade deve estar entre 0 e 100");
      return;
    }
    if (form.expectedReturnDate < form.proposalEntryDate) {
      toast.error("Retorno previsto não pode ser anterior à entrada da proposta");
      return;
    }

    const payload = {
      title: form.title,
      value,
      stage: form.stage,
      probability,
      proposalEntryDate: form.proposalEntryDate,
      expectedReturnDate: form.expectedReturnDate,
      proposalDate: form.proposalEntryDate,
      followUpDate: form.expectedReturnDate,
      expectedCloseDate: form.expectedReturnDate,
      lastContactAt: form.lastContactAt || undefined,
      notes: form.notes || undefined,
      clientId: form.clientId,
      ownerSellerId: form.ownerSellerId || undefined,
      crop: form.crop || undefined,
      season: form.season || undefined,
      areaHa: form.areaHa ? Number(form.areaHa) : undefined,
      productOffered: form.productOffered || undefined,
      plantingForecastDate: form.plantingForecastDate || undefined,
      expectedTicketPerHa: form.expectedTicketPerHa ? Number(form.expectedTicketPerHa) : undefined
    };

    setIsSaving(true);
    try {
      if (editing) await api.put(`/opportunities/${editing}`, payload);
      else await api.post("/opportunities", payload);

      setForm(emptyForm);
      setEditing(null);
      await load();
      toast.success(editing ? "Oportunidade atualizada" : "Oportunidade criada");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Erro ao salvar oportunidade");
    } finally {
      setIsSaving(false);
    }
  };

  const onEdit = (item: Opportunity) => {
    setEditing(item.id);
    setForm({
      title: item.title,
      value: item.value ? String(item.value) : "",
      stage: item.stage,
      probability: item.probability !== null && item.probability !== undefined ? String(item.probability) : "",
      proposalEntryDate: toDateInput(item.proposalDate),
      expectedReturnDate: toDateInput(item.expectedCloseDate),
      lastContactAt: toDateInput(item.lastContactAt),
      crop: item.crop ?? "",
      season: item.season ?? "",
      areaHa: item.areaHa ? String(item.areaHa) : "",
      productOffered: item.productOffered ?? "",
      plantingForecastDate: toDateInput(item.plantingForecastDate),
      expectedTicketPerHa: item.expectedTicketPerHa ? String(item.expectedTicketPerHa) : "",
      notes: item.notes ?? "",
      clientId: item.clientId,
      ownerSellerId: item.ownerSellerId
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const loadOpportunityEvents = async (opportunityId: string) => {
    setLoadingOpportunityEvents(true);
    try {
      const response = await api.get(`/events?opportunityId=${opportunityId}`);
      setOpportunityEvents(response.data?.items || []);
    } finally {
      setLoadingOpportunityEvents(false);
    }
  };

  useEffect(() => {
    if (!editing) {
      setOpportunityEvents([]);
      setOpportunityComment("");
      return;
    }

    loadOpportunityEvents(editing).catch(() => toast.error("Erro ao carregar histórico da oportunidade"));
  }, [editing]);

  const onAddOpportunityComment = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;

    const description = opportunityComment.trim();
    if (!description) {
      toast.error("Digite um comentário antes de adicionar");
      return;
    }

    setIsAddingComment(true);
    try {
      await api.post("/events", {
        type: "comentario",
        description,
        opportunityId: editing,
        clientId: form.clientId
      });
      setOpportunityComment("");
      await loadOpportunityEvents(editing);
      toast.success("Comentário adicionado ao histórico");
    } catch {
      toast.error("Não foi possível adicionar o comentário");
    } finally {
      setIsAddingComment(false);
    }
  };

  const onDelete = async (id: string) => {
    await api.delete(`/opportunities/${id}`);
    await load();
    toast.success("Oportunidade excluída");
  };

  const openPipelineDrawer = (item: Opportunity) => {
    setSelectedOpportunity(item);
    setIsPipelineDrawerOpen(true);
  };

  const closePipelineDrawer = () => {
    setIsPipelineDrawerOpen(false);
    setSelectedOpportunity(null);
    setPipelineInteraction("");
    setPipelineEvents([]);
    setPipelineEventsCursor(null);
    setPipelineFollowUpDate("");
  };

  const loadPipelineEvents = async (opportunityId: string) => {
    setLoadingPipelineEvents(true);
    try {
      const response = await api.get(`/events?opportunityId=${opportunityId}&take=20`);
      setPipelineEvents(response.data?.items || []);
      setPipelineEventsCursor(response.data?.nextCursor || null);
    } finally {
      setLoadingPipelineEvents(false);
    }
  };

  const loadMorePipelineEvents = async () => {
    if (!selectedOpportunity || !pipelineEventsCursor) return;
    setLoadingMorePipelineEvents(true);
    try {
      const response = await api.get(`/events?opportunityId=${selectedOpportunity.id}&take=20&cursor=${pipelineEventsCursor}`);
      setPipelineEvents((current) => [...current, ...(response.data?.items || [])]);
      setPipelineEventsCursor(response.data?.nextCursor || null);
    } finally {
      setLoadingMorePipelineEvents(false);
    }
  };

  useEffect(() => {
    if (!isPipelineDrawerOpen || !selectedOpportunity) return;

    setPipelineFollowUpDate(toDateInput(selectedOpportunity.followUpDate || selectedOpportunity.expectedCloseDate));
    loadPipelineEvents(selectedOpportunity.id).catch(() => toast.error("Erro ao carregar timeline da oportunidade"));
  }, [isPipelineDrawerOpen, selectedOpportunity?.id]);

  const updateOpportunityInState = (nextOpportunity: Opportunity) => {
    setItems((currentItems) => currentItems.map((item) => (item.id === nextOpportunity.id ? { ...item, ...nextOpportunity } : item)));
    setSelectedOpportunity((current) => (current?.id === nextOpportunity.id ? { ...current, ...nextOpportunity } : current));
  };

  const applyQuickStage = async (stage: "ganho" | "perdido") => {
    if (!selectedOpportunity) return;
    if (selectedOpportunity.stage === stage) {
      toast.message(`A oportunidade já está como ${stageLabel[stage]}`);
      return;
    }

    setIsQuickActionLoading(stage);
    try {
      const response = await api.put(`/opportunities/${selectedOpportunity.id}`, { stage });
      updateOpportunityInState(response.data);
      await loadPipelineEvents(selectedOpportunity.id);
      toast.success(`Oportunidade marcada como ${stageLabel[stage]}`);
    } catch {
      toast.error("Não foi possível atualizar a etapa");
    } finally {
      setIsQuickActionLoading(null);
    }
  };

  const onScheduleFollowUp = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedOpportunity) return;
    if (!pipelineFollowUpDate) {
      toast.error("Selecione a data de follow-up");
      return;
    }

    setIsSchedulingFollowUp(true);
    try {
      const response = await api.put(`/opportunities/${selectedOpportunity.id}`, { followUpDate: pipelineFollowUpDate });
      updateOpportunityInState(response.data);
      await loadPipelineEvents(selectedOpportunity.id);
      toast.success("Follow-up agendado com sucesso");
    } catch {
      toast.error("Não foi possível agendar o follow-up");
    } finally {
      setIsSchedulingFollowUp(false);
    }
  };

  const onSavePipelineInteraction = async (event: FormEvent) => {
    event.preventDefault();

    if (!selectedOpportunity) return;

    const description = pipelineInteraction.trim();
    if (!description) {
      toast.error("Digite uma interação antes de salvar");
      return;
    }

    setIsSavingPipelineInteraction(true);
    try {
      const response = await api.post("/events", {
        type: "comentario",
        description,
        opportunityId: selectedOpportunity.id,
        clientId: selectedOpportunity.clientId
      });

      setPipelineEvents((current) => [
        {
          ...response.data,
          ownerSeller: response.data?.ownerSeller || (user ? { id: user.id, name: user.name } : null)
        },
        ...current
      ]);
      setPipelineInteraction("");
      toast.success("Interação registrada com sucesso");
    } catch {
      toast.error("Não foi possível registrar a interação");
    } finally {
      setIsSavingPipelineInteraction(false);
    }
  };

  const clearFilters = () => {
    setFilters({
      stage: "",
      ownerSellerId: isSeller && user?.id ? user.id : "",
      clientId: "",
      crop: "",
      season: "",
      dateFrom: "",
      dateTo: "",
      overdue: false
    });
    setSearch("");
  };

  return (
    <div className="space-y-5 pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold text-slate-900">Oportunidades</h2>
        <div className="inline-flex rounded-lg border border-slate-300 bg-slate-100 p-1 text-sm font-medium">
          <button
            type="button"
            className={`rounded-md px-3 py-1.5 transition ${viewMode === "list" ? "bg-white text-slate-900 shadow" : "text-slate-600 hover:text-slate-900"}`}
            onClick={() => handleViewModeChange("list")}
          >
            Lista
          </button>
          <button
            type="button"
            className={`rounded-md px-3 py-1.5 transition ${viewMode === "pipeline" ? "bg-white text-slate-900 shadow" : "text-slate-600 hover:text-slate-900"}`}
            onClick={() => handleViewModeChange("pipeline")}
          >
            Pipeline
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card title="Pipeline total" value={formatCurrencyBRL(summary.totalPipelineValue)} loading={loading} />
        <Card title="Valor ponderado" value={formatCurrencyBRL(summary.totalWeightedValue)} loading={loading} />
        <Card title="Atrasadas" value={`${summary.overdueCount} • ${formatCurrencyBRL(summary.overdueValue)}`} loading={loading} />
        <Card title="Taxa de conversão" value={`${formatPercentBR(conversionRate)} (${items.filter((item) => item.stage === "ganho").length}/${items.length || 0})`} loading={loading} />
      </div>

      {viewMode === "list" ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-lg font-semibold text-slate-900">Filtros</h3>
          <div className="grid gap-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            <input className="rounded-lg border border-slate-200 p-2" placeholder="Busca por título ou cliente" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select className="rounded-lg border border-slate-200 p-2" value={filters.stage} onChange={(e) => setFilters((prev) => ({ ...prev, stage: e.target.value }))}>
              <option value="">Todos estágios</option>
              {stages.map((stage) => <option key={stage} value={stage}>{stageLabel[stage]}</option>)}
            </select>
            {canFilterByOwner ? (
              <select className="rounded-lg border border-slate-200 p-2" value={filters.ownerSellerId} onChange={(e) => setFilters((prev) => ({ ...prev, ownerSellerId: e.target.value }))}>
                <option value="">Todos vendedores</option>
                {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
              </select>
            ) : (
              <input disabled className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-slate-500" value={user?.name || "Meu pipeline"} />
            )}
            <select className="rounded-lg border border-slate-200 p-2" value={filters.clientId} onChange={(e) => setFilters((prev) => ({ ...prev, clientId: e.target.value }))}>
              <option value="">Todos clientes</option>
              {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
            </select>
            <select className="rounded-lg border border-slate-200 p-2" value={filters.crop} onChange={(e) => setFilters((prev) => ({ ...prev, crop: e.target.value }))}>
              <option value="">Todas culturas</option>
              {cropOptions.map((crop) => <option key={crop} value={crop}>{crop}</option>)}
            </select>
            <select className="rounded-lg border border-slate-200 p-2" value={filters.season} onChange={(e) => setFilters((prev) => ({ ...prev, season: e.target.value }))}>
              <option value="">Todas safras</option>
              {seasonOptions.map((season) => <option key={season} value={season}>{season}</option>)}
            </select>
            <input type="date" className="rounded-lg border border-slate-200 p-2" value={filters.dateFrom} onChange={(e) => setFilters((prev) => ({ ...prev, dateFrom: e.target.value }))} />
            <input type="date" className="rounded-lg border border-slate-200 p-2" value={filters.dateTo} onChange={(e) => setFilters((prev) => ({ ...prev, dateTo: e.target.value }))} />
            <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-700">
              <input type="checkbox" checked={filters.overdue} onChange={(e) => setFilters((prev) => ({ ...prev, overdue: e.target.checked }))} />Somente atrasadas
            </label>
            <button type="button" className="rounded-lg bg-slate-100 px-3 font-medium text-slate-700 hover:bg-slate-200" onClick={clearFilters}>
              Limpar filtros
            </button>
          </div>
        </div>
      ) : null}

      <form onSubmit={submit} className="grid gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-4">
        <input required className="rounded-lg border border-slate-200 p-2" placeholder="Título" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <select required className="rounded-lg border border-slate-200 p-2" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })}>
          <option value="">Selecione cliente</option>
          {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
        </select>
        {user?.role !== "vendedor" ? (
          <select required className="rounded-lg border border-slate-200 p-2" value={form.ownerSellerId} onChange={(e) => setForm({ ...form, ownerSellerId: e.target.value })}>
            <option value="">Selecione vendedor</option>
            {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
          </select>
        ) : <input disabled className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-slate-500" value={user.name} />}
        <select required className="rounded-lg border border-slate-200 p-2" value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value as Stage })}>{stages.map((stage) => <option key={stage} value={stage}>{stageLabel[stage]}</option>)}</select>

        <input required inputMode="decimal" className="rounded-lg border border-slate-200 p-2" placeholder="Valor" value={form.value} onChange={(e) => setForm({ ...form, value: sanitizeNumericInput(e.target.value) })} />
        <input required inputMode="numeric" min={0} max={100} className="rounded-lg border border-slate-200 p-2" placeholder="Probabilidade %" value={form.probability} onChange={(e) => setForm({ ...form, probability: sanitizeNumericInput(e.target.value, false) })} />
        <input required type="date" className="rounded-lg border border-slate-200 p-2" value={form.proposalEntryDate} onChange={(e) => setForm({ ...form, proposalEntryDate: e.target.value })} />
        <input required type="date" className="rounded-lg border border-slate-200 p-2" value={form.expectedReturnDate} onChange={(e) => setForm({ ...form, expectedReturnDate: e.target.value })} />

        <select className="rounded-lg border border-slate-200 p-2" value={form.crop} onChange={(e) => setForm({ ...form, crop: e.target.value })}>
          <option value="">Cultura (opcional)</option>
          {cropSelectOptions.map((crop) => <option key={crop} value={crop}>{crop}</option>)}
        </select>
        <input list="season-suggestions" className="rounded-lg border border-slate-200 p-2" placeholder="Safra (ex: 2025/26)" value={form.season} onChange={(e) => setForm({ ...form, season: e.target.value })} />
        <datalist id="season-suggestions">
          <option value="2024/25" />
          <option value="2025/26" />
          <option value="2026/27" />
        </datalist>
        <input inputMode="decimal" className="rounded-lg border border-slate-200 p-2" placeholder="Área (ha)" value={form.areaHa} onChange={(e) => setForm({ ...form, areaHa: sanitizeNumericInput(e.target.value) })} />
        <input className="rounded-lg border border-slate-200 p-2" placeholder="Produto ofertado" value={form.productOffered} onChange={(e) => setForm({ ...form, productOffered: e.target.value })} />
        <input type="date" className="rounded-lg border border-slate-200 p-2" value={form.plantingForecastDate} onChange={(e) => setForm({ ...form, plantingForecastDate: e.target.value })} />
        <input inputMode="decimal" className="rounded-lg border border-slate-200 p-2" placeholder="Ticket esperado/ha" value={form.expectedTicketPerHa} onChange={(e) => setForm({ ...form, expectedTicketPerHa: sanitizeNumericInput(e.target.value) })} />
        <input type="date" className="rounded-lg border border-slate-200 p-2" value={form.lastContactAt} onChange={(e) => setForm({ ...form, lastContactAt: e.target.value })} />

        <textarea className="rounded-lg border border-slate-200 p-2 md:col-span-4" placeholder="Notas" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        <button disabled={isSaving} className="rounded-lg bg-slate-900 px-3 py-2 text-white disabled:cursor-not-allowed disabled:bg-slate-500 md:col-span-4">{isSaving ? "Salvando..." : "Salvar"}</button>
      </form>

      {editing ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-lg font-semibold text-slate-900">Histórico</h3>
          <form className="space-y-2" onSubmit={onAddOpportunityComment}>
            <textarea
              className="w-full rounded-lg border border-slate-200 p-2 text-sm"
              rows={3}
              placeholder="Escreva um comentário para esta oportunidade"
              value={opportunityComment}
              onChange={(event) => setOpportunityComment(event.target.value)}
            />
            <button
              type="submit"
              disabled={isAddingComment}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-500"
            >
              {isAddingComment ? "Adicionando..." : "Adicionar comentário"}
            </button>
          </form>

          <div className="mt-4 space-y-2">
            <TimelineEventList
              events={opportunityEvents}
              loading={loadingOpportunityEvents}
              emptyMessage="Sem eventos registrados para esta oportunidade."
              loadingMessage="Carregando histórico..."
            />
          </div>
        </section>
      ) : null}

      {viewMode === "list" ? (
        <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-[1500px] w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-slate-600">
                <th className="p-2">Título</th><th className="p-2">Cliente</th><th className="p-2">Vendedor</th><th className="p-2">Etapa</th><th className="p-2">Valor</th><th className="p-2">Probabilidade</th><th className="p-2">Valor Ponderado</th><th className="p-2">Cultura</th><th className="p-2">Safra</th><th className="p-2">Área (ha)</th><th className="p-2">Produto ofertado</th><th className="p-2">Entrada proposta</th><th className="p-2">Retorno previsto</th><th className="p-2">Status retorno</th><th className="p-2">Ações</th>
              </tr>
            </thead>
            <tbody>
              {loading ? Array.from({ length: 6 }).map((_, index) => (
                <tr key={`skeleton-${index}`} className="border-t border-slate-100">
                  <td className="p-2" colSpan={15}><div className="h-8 animate-pulse rounded bg-slate-100" /></td>
                </tr>
              )) : sortedItems.length ? sortedItems.map((item) => {
                const weighted = getWeightedValue(item);
                return (
                  <tr key={item.id} className="border-t border-slate-100">
                    <td className="p-2 font-medium text-slate-800">{item.title}</td>
                    <td className="p-2">{getClientName(item)}</td>
                    <td className="p-2">{getSellerName(item)}</td>
                    <td className="p-2">{stageLabel[item.stage]}</td>
                    <td className="p-2">{formatCurrencyBRL(item.value)}</td>
                    <td className="p-2">{item.probability ?? 0}%</td>
                    <td className="p-2">{formatCurrencyBRL(weighted)}</td>
                    <td className="p-2">{item.crop || "-"}</td>
                    <td className="p-2">{item.season || "-"}</td>
                    <td className="p-2">{item.areaHa ?? "-"}</td>
                    <td className="p-2">{item.productOffered || "-"}</td>
                    <td className="p-2">{formatDateBR(item.proposalDate)}</td>
                    <td className="p-2">{formatDateBR(item.expectedCloseDate)}</td>
                    <td className="p-2"><ReturnStatusBadge status={getReturnStatus(item)} /></td>
                    <td className="space-x-2 whitespace-nowrap p-2">
                      <button type="button" className="text-blue-700" onClick={() => onEdit(item)}>Editar</button>
                      <button type="button" className="text-red-600" onClick={() => onDelete(item.id)}>Excluir</button>
                      <button type="button" className="text-slate-700" onClick={() => navigate(`/oportunidades/${item.id}`)}>Detalhes</button>
                    </td>
                  </tr>
                );
              }) : (
                <tr>
                  <td colSpan={15} className="p-8 text-center text-slate-500">Nenhuma oportunidade encontrada com os filtros aplicados. Tente ajustar os critérios para visualizar resultados.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="grid gap-2 border-b border-slate-100 pb-3 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
            <input className="rounded-lg border border-slate-200 p-2" placeholder="Buscar título ou cliente" value={search} onChange={(e) => setSearch(e.target.value)} />
            <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-700">
              <input type="checkbox" checked={filters.overdue} onChange={(e) => setFilters((prev) => ({ ...prev, overdue: e.target.checked }))} />Somente atrasadas
            </label>
            {canFilterByOwner ? (
              <select className="rounded-lg border border-slate-200 p-2" value={filters.ownerSellerId} onChange={(e) => setFilters((prev) => ({ ...prev, ownerSellerId: e.target.value }))}>
                <option value="">Todos responsáveis</option>
                {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
              </select>
            ) : (
              <input disabled className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-slate-500" value={user?.name || "Meu pipeline"} />
            )}
            <button type="button" className="rounded-lg bg-slate-100 px-3 font-medium text-slate-700 hover:bg-slate-200" onClick={clearFilters}>
              Limpar filtros
            </button>
          </div>

          <div className="overflow-x-auto">
            <div className="grid min-w-[1050px] grid-cols-5 gap-3">
              {stages.map((stage) => {
                const stageItems = opportunitiesByStage[stage];
                const stageTotal = stageItems.reduce((sum, item) => sum + Number(item.value || 0), 0);
                const stageWeightedTotal = stageItems.reduce((sum, item) => sum + getWeightedValue(item), 0);
                return (
                  <div
                    key={stage}
                    className="flex min-h-[430px] flex-col rounded-xl border border-slate-200 bg-slate-50"
                    onDragOver={handlePipelineColumnDragOver}
                    onDrop={(event) => {
                      handlePipelineColumnDrop(event, stage).catch(() => {
                        toast.error("Erro inesperado ao mover oportunidade");
                      });
                    }}
                  >
                    <div className="space-y-1 border-b border-slate-200 px-3 py-3">
                      <div className="font-semibold text-slate-800">{stageLabel[stage]}</div>
                      <div className="text-xs text-slate-500">{stageItems.length} oportunidade(s)</div>
                      <div className="flex items-center justify-between text-xs text-slate-600"><span>Total</span><span className="font-semibold text-slate-900">{formatCurrencyBRL(stageTotal)}</span></div>
                      <div className="flex items-center justify-between text-xs text-slate-600"><span>Ponderado</span><span className="font-semibold text-slate-900">{formatCurrencyBRL(stageWeightedTotal)}</span></div>
                    </div>
                    <div className="flex-1 space-y-2 overflow-y-auto p-3">
                      {loading ? Array.from({ length: 3 }).map((_, index) => (
                        <div key={`${stage}-skeleton-${index}`} className="h-24 animate-pulse rounded-lg bg-slate-200" />
                      )) : stageItems.length ? stageItems.map((item) => (
                        <div
                          key={item.id}
                          className={`space-y-2 rounded-lg border p-3 shadow-sm ${getReturnStatus(item) === "overdue" ? "border-red-200 bg-red-50/40" : "border-slate-200 bg-white"}`}
                          draggable
                          onDragStart={(event) => handlePipelineCardDragStart(event, item)}
                          onClick={() => openPipelineDrawer(item)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              openPipelineDrawer(item);
                            }
                          }}
                        >
                          <div className="text-sm font-semibold text-slate-800">{item.title}</div>
                          <div className="text-xs text-slate-600">{getClientName(item)}</div>
                          <div className="text-sm font-medium text-slate-900">{formatCurrencyBRL(item.value)}</div>
                          <div className="text-xs text-slate-500">Follow-up: {formatDateBR(item.followUpDate || item.expectedCloseDate)}</div>
                          <ReturnStatusBadge status={getReturnStatus(item)} />
                        </div>
                      )) : <div className="rounded-lg border border-dashed border-slate-300 bg-white p-3 text-center text-xs text-slate-500">Sem oportunidades</div>}
                    </div>
                    <div className="mt-auto border-t border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
                      <div className="flex items-center justify-between"><span>Total</span><span className="font-semibold text-slate-900">{formatCurrencyBRL(stageTotal)}</span></div>
                      <div className="mt-1 flex items-center justify-between"><span>Ponderado</span><span className="font-semibold text-slate-900">{formatCurrencyBRL(stageWeightedTotal)}</span></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {isPipelineDrawerOpen && selectedOpportunity ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={closePipelineDrawer}>
          <aside
            className="h-full w-full max-w-lg overflow-y-auto bg-white p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-semibold text-slate-900">{selectedOpportunity.title}</h3>
                <p className="mt-1 text-sm text-slate-500">{getClientName(selectedOpportunity)}</p>
              </div>
              <button type="button" className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-600" onClick={closePipelineDrawer}>
                Fechar
              </button>
            </div>

            <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Valor</span>
                <span className="font-semibold text-slate-900">{formatCurrencyBRL(selectedOpportunity.value)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Cliente</span>
                <span className="font-semibold text-right text-slate-900">{getClientName(selectedOpportunity)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Cidade/UF</span>
                <span className="font-semibold text-slate-900">
                  {selectedOpportunity.clientCity || selectedOpportunity.clientState
                    ? `${selectedOpportunity.clientCity || "-"}/${selectedOpportunity.clientState || "-"}`
                    : "-"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Status de prazo</span>
                <ReturnStatusBadge status={getReturnStatus(selectedOpportunity)} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Etapa</span>
                <span className="font-semibold text-slate-900">{stageLabel[selectedOpportunity.stage]}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Cultura</span>
                <span className="font-semibold text-slate-900">{selectedOpportunity.crop || "-"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Safra</span>
                <span className="font-semibold text-slate-900">{selectedOpportunity.season || "-"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Área (ha)</span>
                <span className="font-semibold text-slate-900">{selectedOpportunity.areaHa ? `${selectedOpportunity.areaHa} ha` : "-"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Produto ofertado</span>
                <span className="font-semibold text-right text-slate-900">{selectedOpportunity.productOffered || "-"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Entrada da proposta</span>
                <span className="font-semibold text-slate-900">{formatDateBR(selectedOpportunity.proposalDate)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Retorno / follow-up</span>
                <span className="font-semibold text-slate-900">{formatDateBR(selectedOpportunity.followUpDate || selectedOpportunity.expectedCloseDate)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Fechamento previsto</span>
                <span className="font-semibold text-slate-900">{formatDateBR(selectedOpportunity.expectedCloseDate)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Último contato</span>
                <span className="font-semibold text-slate-900">{selectedOpportunity.lastContactAt ? formatDateBR(selectedOpportunity.lastContactAt) : "-"}</span>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                disabled={isQuickActionLoading !== null}
                className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-emerald-300"
                onClick={() => applyQuickStage("ganho")}
              >
                {isQuickActionLoading === "ganho" ? "Atualizando..." : "Marcar como Ganho"}
              </button>
              <button
                type="button"
                disabled={isQuickActionLoading !== null}
                className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-rose-300"
                onClick={() => applyQuickStage("perdido")}
              >
                {isQuickActionLoading === "perdido" ? "Atualizando..." : "Marcar como Perdido"}
              </button>
            </div>

            <form className="mt-3 space-y-2" onSubmit={onScheduleFollowUp}>
              <label className="block text-sm font-medium text-slate-800" htmlFor="pipeline-followup-date">
                Agendar Follow-up
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="pipeline-followup-date"
                  type="date"
                  className="w-full rounded-lg border border-slate-200 p-2 text-sm"
                  value={pipelineFollowUpDate}
                  onChange={(event) => setPipelineFollowUpDate(event.target.value)}
                />
                <button
                  type="submit"
                  disabled={isSchedulingFollowUp}
                  className="whitespace-nowrap rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {isSchedulingFollowUp ? "Salvando..." : "Agendar Follow-up"}
                </button>
              </div>
            </form>

            <button
              type="button"
              className="mt-4 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white"
              onClick={() => navigate(`/oportunidades/${selectedOpportunity.id}`)}
            >
              Abrir detalhes
            </button>

            <form className="mt-6 space-y-3" onSubmit={onSavePipelineInteraction}>
              <label className="block text-sm font-medium text-slate-800" htmlFor="pipeline-interaction">
                Registrar Interação
              </label>
              <textarea
                id="pipeline-interaction"
                className="w-full rounded-lg border border-slate-200 p-2 text-sm"
                rows={4}
                placeholder="Ex.: Ligação com João, pediu revisão de preço e retorno na próxima terça."
                value={pipelineInteraction}
                onChange={(event) => setPipelineInteraction(event.target.value)}
              />
              <button
                type="submit"
                disabled={isSavingPipelineInteraction}
                className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-emerald-300"
              >
                {isSavingPipelineInteraction ? "Salvando..." : "Salvar interação"}
              </button>
            </form>

            <div className="mt-6">
              <h4 className="text-sm font-semibold text-slate-900">Timeline</h4>
              <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <TimelineEventList
                  events={pipelineEvents}
                  loading={loadingPipelineEvents}
                  loadingMore={loadingMorePipelineEvents}
                  hasMore={Boolean(pipelineEventsCursor)}
                  onLoadMore={() => void loadMorePipelineEvents()}
                  emptyMessage="Sem eventos registrados para esta oportunidade."
                  loadingMessage="Carregando timeline..."
                  compact
                />
              </div>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function ReturnStatusBadge({ status }: { status: ReturnStatus }) {
  if (status === "overdue") return <Badge className="bg-red-100 text-red-700">Atrasado</Badge>;
  if (status === "dueSoon") return <Badge className="bg-yellow-100 text-yellow-800">Vence em breve</Badge>;
  return <Badge className="bg-emerald-100 text-emerald-700">OK</Badge>;
}

function Card({ title, value, loading }: { title: string; value: string; loading?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="text-xs text-slate-500">{title}</div>
      {loading ? <div className="mt-1 h-6 w-3/4 animate-pulse rounded bg-slate-100" /> : <div className="font-bold text-slate-900">{value}</div>}
    </div>
  );
}

function Badge({ className, children }: { className: string; children: ReactNode }) {
  return <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${className}`}>{children}</span>;
}
