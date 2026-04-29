import { DragEvent, FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { MoreHorizontal, Search } from "lucide-react";
import api from "../lib/apiClient";
import { formatCurrencyBRL, formatDateBR, formatPercentBR } from "../lib/formatters";
import { useAuth } from "../context/AuthContext";
import { triggerDashboardRefresh } from "../lib/dashboardRefresh";
import TimelineEventList, { TimelineEventItem } from "../components/TimelineEventList";
import CreateOpportunityModal from "../components/opportunities/CreateOpportunityModal";
import OpportunityImportModal from "../components/opportunities/OpportunityImportModal";
import { getApiErrorMessage } from "../lib/apiError";
import ClientSearchSelect from "../components/clients/ClientSearchSelect";

type Stage = "prospeccao" | "negociacao" | "proposta" | "ganho" | "perdido";
type OpportunityStatus = "open" | "closed" | "all";
type ReturnStatus = "overdue" | "dueSoon" | "ok";
type ViewMode = "list" | "pipeline";
type OpportunityModalMode = "create" | "edit";
type OpportunityRisk = "alto" | "medio" | "baixo";

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
  risk?: OpportunityRisk;
};

type Client = {
  id: string;
  name: string;
  fantasyName?: string | null;
  code?: string | null;
  city?: string | null;
  state?: string | null;
  cnpj?: string | null;
};
type Summary = {
  pipelineTotal: number;
  weightedTotal: number;
  totalPipelineValue: number;
  totalWeightedValue: number;
  overdueCount: number;
  overdueValue: number;
  conversionRate: number;
  byStage?: Record<string, { value: number; weighted: number }>;
};

type Filters = {
  status: OpportunityStatus;
  stage: string;
  ownerSellerId: string;
  clientId: string;
  crop: string;
  season: string;
  dateFrom: string;
  dateTo: string;
  overdue: boolean;
};

type DiscountType = "value" | "percent";

type OpportunityProduct = {
  id: string;
  name: string;
  erpProductCode: string;
  erpProductClassCode: string;
  unit?: string | null;
  defaultPrice?: number | null;
};

type OpportunityItemForm = {
  id?: string;
  productId: string;
  productNameSnapshot: string;
  erpProductCode: string;
  erpProductClassCode: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  discountType: DiscountType;
  discountValue: string;
  notes: string;
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

type CloseAction = "ganho" | "perdido";

type CloseOpportunityState = {
  opportunityId: string;
  stage: CloseAction;
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


const toClientOption = (client: {
  id: string;
  name: string;
  fantasyName?: string | null;
  code?: string | null;
  city?: string | null;
  state?: string | null;
  cnpj?: string | null;
}): Client => ({
  id: client.id,
  name: client.name,
  fantasyName: client.fantasyName,
  code: client.code,
  city: client.city,
  state: client.state,
  cnpj: client.cnpj
});

const statusLabel: Record<OpportunityStatus, string> = {
  open: "Abertas",
  closed: "Encerradas",
  all: "Todas"
};

const stageWeight: Record<Stage, number> = {
  prospeccao: 20,
  negociacao: 40,
  proposta: 70,
  ganho: 100,
  perdido: 0
};

const riskLabel: Record<OpportunityRisk, string> = {
  alto: "Alto",
  medio: "Médio",
  baixo: "Baixo"
};

const riskBadgeClassName: Record<OpportunityRisk, string> = {
  alto: "bg-red-100 text-red-700 border-red-200",
  medio: "bg-amber-100 text-amber-700 border-amber-200",
  baixo: "bg-emerald-100 text-emerald-700 border-emerald-200"
};

const riskRowClassName: Record<OpportunityRisk, string> = {
  alto: "bg-red-50/40",
  medio: "bg-amber-50/40",
  baixo: "bg-emerald-50/30"
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

const emptyOpportunityItem: OpportunityItemForm = {
  productId: "",
  productNameSnapshot: "",
  erpProductCode: "",
  erpProductClassCode: "",
  unit: "",
  quantity: "1",
  unitPrice: "0",
  discountType: "value",
  discountValue: "0",
  notes: ""
};

const emptySummary: Summary = {
  pipelineTotal: 0,
  weightedTotal: 0,
  totalPipelineValue: 0,
  totalWeightedValue: 0,
  overdueCount: 0,
  overdueValue: 0,
  conversionRate: 0
};

const PIPELINE_VIEW_STORAGE_KEY = "opportunities.view";
const shouldLogOpportunityDiagnostics = import.meta.env.MODE !== "production";

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

function normalizeRisk(value?: string | null): OpportunityRisk {
  if (value === "alto" || value === "medio") return value;
  return "baixo";
}


function toTwoDecimals(value: number) {
  return Math.round(value * 100) / 100;
}

function calculateItemTotals(item: OpportunityItemForm) {
  const quantity = Number(item.quantity || 0);
  const unitPrice = Number(item.unitPrice || 0);
  const grossTotal = toTwoDecimals(quantity * unitPrice);
  const discountValue = Number(item.discountValue || 0);
  const discountTotalRaw = item.discountType === "percent" ? grossTotal * (discountValue / 100) : discountValue;
  const discountTotal = toTwoDecimals(Math.max(0, Math.min(grossTotal, discountTotalRaw)));
  const netTotal = toTwoDecimals(grossTotal - discountTotal);
  return { grossTotal, discountTotal, netTotal };
}

export default function OpportunitiesPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<Opportunity[]>([]);
  const [summary, setSummary] = useState<Summary>(emptySummary);
  const [clients, setClients] = useState<Client[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [isOpportunityModalOpen, setIsOpportunityModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [opportunityModalMode, setOpportunityModalMode] = useState<OpportunityModalMode>("create");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [opportunityItems, setOpportunityItems] = useState<OpportunityItemForm[]>([]);
  const [itemDraft, setItemDraft] = useState<OpportunityItemForm>(emptyOpportunityItem);
  const [productSearch, setProductSearch] = useState("");
  const [productOptions, setProductOptions] = useState<OpportunityProduct[]>([]);
  const [hasAttemptedProductSearch, setHasAttemptedProductSearch] = useState(false);
  const [loadingItems, setLoadingItems] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("pipeline");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<Filters>({
    status: "open",
    stage: "",
    ownerSellerId: "",
    clientId: "",
    crop: "",
    season: "",
    dateFrom: "",
    dateTo: "",
    overdue: false
  });
  const [selectedOpportunity, setSelectedOpportunity] = useState<Opportunity | null>(null);
  const [isPipelineDrawerOpen, setIsPipelineDrawerOpen] = useState(false);
  const [pipelineInteraction, setPipelineInteraction] = useState("");
  const [isSavingPipelineInteraction, setIsSavingPipelineInteraction] = useState(false);
  const [pipelineEvents, setPipelineEvents] = useState<TimelineEventItem[]>([]);
  const [loadingPipelineEvents, setLoadingPipelineEvents] = useState(false);
  const [loadingMorePipelineEvents, setLoadingMorePipelineEvents] = useState(false);
  const [pipelineEventsCursor, setPipelineEventsCursor] = useState<string | null>(null);
  const [isQuickActionLoading, setIsQuickActionLoading] = useState<"ganho" | "perdido" | null>(null);
  const [openCloseMenuId, setOpenCloseMenuId] = useState<string | null>(null);
  const [closeOpportunityState, setCloseOpportunityState] = useState<CloseOpportunityState | null>(null);
  const [closeReason, setCloseReason] = useState("");
  const [isSchedulingFollowUp, setIsSchedulingFollowUp] = useState(false);
  const [pipelineFollowUpDate, setPipelineFollowUpDate] = useState("");
  const opportunitiesRequestRef = useRef(0);
  const actionTodayFilter = searchParams.get("actionToday") === "true";
  const isSeller = user?.role === "vendedor";
  const canFilterByOwner = user?.role === "diretor" || user?.role === "gerente";

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 400);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const savedMode = localStorage.getItem(PIPELINE_VIEW_STORAGE_KEY);
    if (savedMode === "list" || savedMode === "pipeline") setViewMode(savedMode);
  }, []);

  useEffect(() => {
    const urlStatus = searchParams.get("status");
    const urlStage = searchParams.get("stage");
    const urlOverdue = searchParams.get("overdue");
    const urlOwnerSellerId = searchParams.get("ownerSellerId");
    const urlSearch = searchParams.get("search");

    setFilters((prev) => ({
      ...prev,
      status: urlStatus === "open" || urlStatus === "closed" || urlStatus === "all" ? urlStatus : prev.status,
      stage: urlStage || prev.stage,
      overdue: urlOverdue === "true" ? true : prev.overdue,
      ownerSellerId: urlOwnerSellerId || prev.ownerSellerId
    }));

    if (urlSearch) {
      setSearch(urlSearch);
      setDebouncedSearch(urlSearch);
    }
  }, [searchParams]);



  useEffect(() => {
    if (searchParams.get("open") !== "create") return;

    setEditing(null);
    setOpportunityModalMode("create");
    setForm({
      ...emptyForm,
      ownerSellerId: isSeller && user?.id ? user.id : ""
    });
    setOpportunityItems([]);
    setItemDraft(emptyOpportunityItem);
    setProductSearch("");
    setProductOptions([]);
    setSubmitError(null);
    setOpportunityItems([]);
    setItemDraft(emptyOpportunityItem);
    setIsOpportunityModalOpen(true);

    const params = new URLSearchParams(searchParams);
    params.delete("open");
    setSearchParams(params, { replace: true });
  }, [isSeller, searchParams, setSearchParams, user?.id]);

  useEffect(() => {
    if (!isSeller || !user?.id) return;
    setFilters((prev) => ({ ...prev, ownerSellerId: user.id }));
  }, [isSeller, user?.id]);

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem(PIPELINE_VIEW_STORAGE_KEY, mode);
  };

  const opportunitiesQueryKey = useMemo(() => ({
    status: filters.status,
    stage: filters.stage,
    ownerSellerId: filters.ownerSellerId,
    overdueOnly: filters.overdue,
    search: debouncedSearch,
    clientId: filters.clientId,
    crop: filters.crop,
    season: filters.season,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo
  }), [debouncedSearch, filters]);

  const opportunitiesSummaryQueryKey = useMemo(() => ({
    ...opportunitiesQueryKey
  }), [opportunitiesQueryKey]);

  const dashboardMonthlySummaryQueryKey = useMemo(() => ({
    month: new Date().toISOString().slice(0, 7),
    ownerSellerId: filters.ownerSellerId,
    status: filters.status
  }), [filters.ownerSellerId, filters.status]);

  const buildOpportunitiesQuery = useCallback(() => {
    const params = new URLSearchParams();
    Object.entries(opportunitiesQueryKey).forEach(([key, value]) => {
      if (typeof value === "boolean") {
        if (value) params.set(key, "true");
        return;
      }
      if (value) params.set(key, value);
    });

    if (!params.has("status")) params.set("status", "open");

    return params.toString() ? `?${params.toString()}` : "";
  }, [opportunitiesQueryKey]);

  const loadSummary = useCallback(async (query: string) => {
    const summaryRes = await api.get(`/opportunities/summary${query}`);
    setSummary(summaryRes.data || emptySummary);
    return summaryRes;
  }, []);

  const refetchOpportunityQueries = useCallback(async () => {
    const requestId = opportunitiesRequestRef.current + 1;
    opportunitiesRequestRef.current = requestId;
    setLoading(true);
    try {
      const query = buildOpportunitiesQuery();
      if (shouldLogOpportunityDiagnostics) {
        console.info("[diag-opportunities][load] refetching opportunities data", {
          userId: user?.id,
          role: user?.role,
          filtersApplied: opportunitiesQueryKey,
          opportunitiesQueryKey,
          opportunitiesSummaryQueryKey,
          opportunitiesEndpoint: `/opportunities${query}`,
          summaryEndpoint: `/opportunities/summary${query}`,
          clientsEndpoint: "/clients"
        });
      }
      const [oppRes, summaryRes, clientsRes] = await Promise.all([
        api.get(`/opportunities${query}`),
        loadSummary(query),
        api.get("/clients")
      ]);

      if (requestId !== opportunitiesRequestRef.current) return;

      setItems(oppRes.data || []);
      setClients(clientsRes.data || []);

      if (shouldLogOpportunityDiagnostics) {
        console.info("[diag-opportunities][load][response]", {
          userId: user?.id,
          role: user?.role,
          filtersApplied: opportunitiesQueryKey,
          opportunitiesReturned: Array.isArray(oppRes.data) ? oppRes.data.length : 0,
          pipelineTotal: summaryRes.data?.pipelineTotal,
          weightedTotal: summaryRes.data?.weightedTotal,
          overdueCount: summaryRes.data?.overdueCount,
          conversionRate: summaryRes.data?.conversionRate
        });
      }
    } finally {
      if (requestId === opportunitiesRequestRef.current) {
        setLoading(false);
      }
    }
  }, [buildOpportunitiesQuery, loadSummary, opportunitiesQueryKey, opportunitiesSummaryQueryKey, user?.id, user?.role]);

  const invalidateOpportunitiesAndDashboardQueries = useCallback(async () => {
    await refetchOpportunityQueries();
    triggerDashboardRefresh({ month: new Date().toISOString().slice(0, 7) });
  }, [refetchOpportunityQueries]);

  useEffect(() => {
    refetchOpportunityQueries().catch((error) => toast.error(getApiErrorMessage(error, "Erro ao carregar oportunidades")));
  }, [refetchOpportunityQueries]);

  useEffect(() => {
    if (!shouldLogOpportunityDiagnostics) return;
    console.info("[diag-opportunities][query-keys]", {
      opportunitiesListKanban: opportunitiesQueryKey,
      opportunitiesSummary: opportunitiesSummaryQueryKey,
      dashboardMonthlySummary: dashboardMonthlySummaryQueryKey
    });
  }, [dashboardMonthlySummaryQueryKey, opportunitiesQueryKey, opportunitiesSummaryQueryKey]);

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
    const riskOrder: Record<OpportunityRisk, number> = { alto: 0, medio: 1, baixo: 2 };
    const byRisk = riskOrder[normalizeRisk(a.risk)] - riskOrder[normalizeRisk(b.risk)];
    if (byRisk !== 0) return byRisk;
    const byStatus = statusPriority[getReturnStatus(a)] - statusPriority[getReturnStatus(b)];
    if (byStatus !== 0) return byStatus;
    return Number(b.value || 0) - Number(a.value || 0);
  };

  const sortedItems = useMemo(() => {
    const itemsToSort = actionTodayFilter
      ? items.filter((item) => {
        const todayStart = toDayStart(new Date().toISOString());
        const followUpDay = toDayStart(item.followUpDate);
        const expectedCloseDay = toDayStart(item.expectedCloseDate);
        const lastActionDay = toDayStart(item.lastContactAt || item.followUpDate);
        const stage = String(item.stage || "").toLowerCase();

        if (!todayStart) return false;
        if (followUpDay && followUpDay <= todayStart) return true;
        if (expectedCloseDay && expectedCloseDay < todayStart) return true;
        if (stage === "proposta" && lastActionDay) {
          const elapsed = Math.floor((todayStart.getTime() - lastActionDay.getTime()) / (1000 * 60 * 60 * 24));
          return elapsed >= 7;
        }
        return false;
      })
      : items;

    return [...itemsToSort].sort(sortByPipelinePriority);
  }, [actionTodayFilter, items]);

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

  const pipelineStages = useMemo(() => {
    if (filters.status === "open") return stages.filter((stage) => ["prospeccao", "negociacao", "proposta"].includes(stage));
    if (filters.status === "closed") return stages.filter((stage) => ["ganho", "perdido"].includes(stage));
    return stages;
  }, [filters.status]);

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

  const resolveCloseOpportunityResponse = (
    response: { status: number; data?: any },
    opportunityId: string,
    fallbackOpportunity?: Opportunity | null,
    targetStage?: "ganho" | "perdido"
  ): Opportunity | null => {
    const payloadOpportunity = response.data?.opportunity ?? response.data;

    if (payloadOpportunity?.id === opportunityId) {
      return payloadOpportunity as Opportunity;
    }

    if (response.status === 204 || (response.status >= 200 && response.status < 300 && !payloadOpportunity)) {
      if (!fallbackOpportunity) return null;
      const now = new Date().toISOString();
      return {
        ...fallbackOpportunity,
        ...(targetStage ? { stage: targetStage } : {}),
        expectedCloseDate: now,
        followUpDate: now
      };
    }

    throw new Error("Resposta inválida ao encerrar oportunidade");
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

    const isClosingStage = destinationStage === "ganho" || destinationStage === "perdido";

    if (!isClosingStage) {
      setItems((currentItems) => currentItems.map((item) => (
        item.id === payload.opportunityId ? { ...item, stage: destinationStage } : item
      )));
    }

    try {
      if (isClosingStage) {
        const response = await api.patch(`/opportunities/${payload.opportunityId}/close`, { stage: destinationStage });
        const updatedOpportunity = resolveCloseOpportunityResponse(response, payload.opportunityId, targetOpportunity, destinationStage);
        if (updatedOpportunity) updateOpportunityInState(updatedOpportunity);
      } else {
        await api.put(`/opportunities/${payload.opportunityId}`, { stage: destinationStage });
      }

      if (filters.status === "open" && isClosingStage) {
        setItems((currentItems) => currentItems.filter((item) => item.id !== payload.opportunityId));
        if (selectedOpportunity?.id === payload.opportunityId) closePipelineDrawer();
      }

      await invalidateOpportunitiesAndDashboardQueries();
    } catch (error) {
      setItems(previousItems);
      toast.error(getApiErrorMessage(error, isClosingStage ? "Não foi possível encerrar a oportunidade" : "Não foi possível mover a oportunidade de etapa"));
      try {
        await refetchOpportunityQueries();
      } catch (loadError) {
        toast.error(getApiErrorMessage(loadError, "Erro ao atualizar pipeline"));
      }
    }
  };


  const loadOpportunityItems = useCallback(async (opportunityId: string) => {
    setLoadingItems(true);
    try {
      const response = await api.get(`/opportunities/${opportunityId}/items`);
      const loadedItems = (response.data?.items || []).map((item: any) => ({
        id: item.id,
        productId: item.productId || "",
        productNameSnapshot: item.productNameSnapshot || "",
        erpProductCode: item.erpProductCode || "",
        erpProductClassCode: item.erpProductClassCode || "",
        unit: item.unit || "",
        quantity: String(item.quantity ?? 1),
        unitPrice: String(item.unitPrice ?? 0),
        discountType: (item.discountType || "value") as DiscountType,
        discountValue: String(item.discountValue ?? 0),
        notes: item.notes || ""
      }));
      setOpportunityItems(loadedItems);
    } catch {
      toast.error("Não foi possível carregar os itens da oportunidade");
    } finally {
      setLoadingItems(false);
    }
  }, []);

  const searchProducts = useCallback(async (query: string) => {
    const trimmed = query.trim();
    setHasAttemptedProductSearch(trimmed.length >= 2);
    if (trimmed.length < 2) {
      setProductOptions([]);
      return;
    }
    try {
      const response = await api.get(`/products/search?q=${encodeURIComponent(trimmed)}`);
      setProductOptions(response.data || []);
    } catch {
      setProductOptions([]);
    }
  }, []);

  const persistOpportunityItem = async (draft: OpportunityItemForm) => {
    if (!editing) {
      toast.message("Salve a oportunidade para começar a adicionar produtos.");
      return;
    }
    const payload = {
      productId: draft.productId || undefined,
      productNameSnapshot: draft.productNameSnapshot,
      erpProductCode: draft.erpProductCode,
      erpProductClassCode: draft.erpProductClassCode,
      unit: draft.unit || undefined,
      quantity: Number(draft.quantity || 0),
      unitPrice: Number(draft.unitPrice || 0),
      discountType: draft.discountType,
      discountValue: Number(draft.discountValue || 0),
      notes: draft.notes || undefined
    };

    if (payload.quantity <= 0 || payload.unitPrice < 0 || !payload.productNameSnapshot) {
      toast.error("Preencha produto, quantidade e preço válidos.");
      return;
    }
    const draftTotals = calculateItemTotals(draft);
    if (draft.discountType === "percent" && (payload.discountValue < 0 || payload.discountValue > 100)) {
      toast.error("Desconto percentual deve estar entre 0 e 100.");
      return;
    }
    if (draft.discountType === "value" && (payload.discountValue < 0 || payload.discountValue > draftTotals.grossTotal)) {
      toast.error("Desconto em valor não pode ser maior que o valor bruto do item.");
      return;
    }
    if (draftTotals.netTotal < 0) {
      toast.error("Valor líquido do item não pode ser negativo.");
      return;
    }

    if (draft.id) {
      await api.put(`/opportunities/${editing}/items/${draft.id}`, payload);
    } else {
      await api.post(`/opportunities/${editing}/items`, payload);
    }
    await loadOpportunityItems(editing);
    setItemDraft(emptyOpportunityItem);
    toast.success(draft.id ? "Item atualizado" : "Item adicionado");
  };

  const removeOpportunityItem = async (itemId?: string) => {
    if (!editing || !itemId) return;
    await api.delete(`/opportunities/${editing}/items/${itemId}`);
    await loadOpportunityItems(editing);
    toast.success("Item removido");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    const value = Number(form.value);
    const probability = Number(form.probability);
    if (Number.isNaN(value) || value < 0) {
      const errorMessage = "Valor precisa ser maior ou igual a zero";
      setSubmitError(errorMessage);
      toast.error(errorMessage);
      return;
    }
    if (Number.isNaN(probability) || probability < 0 || probability > 100) {
      const errorMessage = "Probabilidade deve estar entre 0 e 100";
      setSubmitError(errorMessage);
      toast.error(errorMessage);
      return;
    }
    if (form.expectedReturnDate < form.proposalEntryDate) {
      const errorMessage = "Retorno previsto não pode ser anterior à entrada da proposta";
      setSubmitError(errorMessage);
      toast.error(errorMessage);
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

    const isEditing = Boolean(editing);
    setIsSaving(true);
    try {
      if (editing) await api.put(`/opportunities/${editing}`, payload);
      else await api.post("/opportunities", payload);
      setForm(emptyForm);
      setEditing(null);
      setOpportunityModalMode("create");
      setIsOpportunityModalOpen(false);
      await invalidateOpportunitiesAndDashboardQueries();
      toast.success(isEditing ? "Oportunidade atualizada" : "Oportunidade criada");
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || "Erro ao salvar oportunidade";
      setSubmitError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsSaving(false);
    }
  };

  const openCreateModal = () => {
    setEditing(null);
    setOpportunityModalMode("create");
    setForm({
      ...emptyForm,
      ownerSellerId: isSeller && user?.id ? user.id : ""
    });
    setOpportunityItems([]);
    setItemDraft(emptyOpportunityItem);
    setProductSearch("");
    setProductOptions([]);
    setSubmitError(null);
    setIsOpportunityModalOpen(true);
  };

  const closeOpportunityModal = () => {
    if (isSaving) return;
    setIsOpportunityModalOpen(false);
    setOpportunityModalMode("create");
    setSubmitError(null);
    setEditing(null);
    setForm({
      ...emptyForm,
      ownerSellerId: isSeller && user?.id ? user.id : ""
    });
    setOpportunityItems([]);
    setItemDraft(emptyOpportunityItem);
    setProductSearch("");
    setProductOptions([]);
  };

  const onEdit = (item: Opportunity) => {
    setEditing(item.id);
    setOpportunityModalMode("edit");
    setForm({
      title: item.title,
      value: item.value ? String(item.value) : "",
      stage: item.stage,
      probability: item.probability !== null && item.probability !== undefined ? String(item.probability) : "",
      proposalEntryDate: toDateInput(item.proposalDate),
      expectedReturnDate: toDateInput(item.followUpDate || item.expectedCloseDate),
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
    setSubmitError(null);
    setIsOpportunityModalOpen(true);
    loadOpportunityItems(item.id).catch(() => null);
  };

  const onDelete = async (id: string) => {
    await api.delete(`/opportunities/${id}`);
    await invalidateOpportunitiesAndDashboardQueries();
    toast.success("Oportunidade excluída");
  };

  const selectExistingClient = (client: {
    id: string;
    name: string;
    fantasyName?: string | null;
    code?: string | null;
    city?: string | null;
    state?: string | null;
    cnpj?: string | null;
  }) => {
    const clientOption = toClientOption(client);

    setClients((current) => {
      const withoutDuplicate = current.filter((item) => item.id !== clientOption.id);
      return [...withoutDuplicate, clientOption].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    });

    setForm((current) => ({ ...current, clientId: clientOption.id }));
    return clientOption;
  };


  const itemDraftTotals = useMemo(() => calculateItemTotals(itemDraft), [itemDraft]);
  const itemsTotals = useMemo(() => opportunityItems.reduce(
    (acc, current) => {
      const currentTotals = calculateItemTotals(current);
      return {
        grossTotal: acc.grossTotal + currentTotals.grossTotal,
        discountTotal: acc.discountTotal + currentTotals.discountTotal,
        netTotal: acc.netTotal + currentTotals.netTotal
      };
    },
    { grossTotal: 0, discountTotal: 0, netTotal: 0 }
  ), [opportunityItems]);
  const hasStructuredItems = opportunityItems.length > 0;

  useEffect(() => {
    if (!hasStructuredItems) return;
    setForm((current) => ({ ...current, value: String(toTwoDecimals(itemsTotals.netTotal)) }));
  }, [hasStructuredItems, itemsTotals.netTotal]);

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
    loadPipelineEvents(selectedOpportunity.id).catch((error) => toast.error(getApiErrorMessage(error, "Erro ao carregar timeline da oportunidade")));
  }, [isPipelineDrawerOpen, selectedOpportunity?.id]);

  const updateOpportunityInState = (nextOpportunity: Opportunity) => {
    setItems((currentItems) => currentItems.map((item) => (item.id === nextOpportunity.id ? { ...item, ...nextOpportunity } : item)));
    setSelectedOpportunity((current) => (current?.id === nextOpportunity.id ? { ...current, ...nextOpportunity } : current));
  };

  const openCloseModal = (opportunityId: string, stage: CloseAction) => {
    setOpenCloseMenuId(null);
    setCloseReason("");
    setCloseOpportunityState({ opportunityId, stage });
  };

  const closeCloseModal = () => {
    setCloseOpportunityState(null);
    setCloseReason("");
  };

  const applyQuickStage = async (stage: "ganho" | "perdido", reason?: string, opportunityId?: string) => {
    const targetId = opportunityId || selectedOpportunity?.id;
    if (!targetId) return;

    const targetOpportunity = items.find((item) => item.id === targetId) || (selectedOpportunity?.id === targetId ? selectedOpportunity : null);
    if (!targetOpportunity) return;
    if (targetOpportunity.stage === stage) {
      toast.message(`A oportunidade já está como ${stageLabel[stage]}`);
      return true;
    }

    setIsQuickActionLoading(stage);
    try {
      if (shouldLogOpportunityDiagnostics) {
        console.info("[diag-opportunities][close][request]", {
          endpoint: `/opportunities/${targetId}/close`,
          payload: { stage, reason: reason || "" },
          filters
        });
      }
      const response = await api.patch(`/opportunities/${targetId}/close`, { stage, reason });
      const updatedOpportunity = resolveCloseOpportunityResponse(response, targetId, targetOpportunity, stage);
      if (shouldLogOpportunityDiagnostics) {
        console.info("[diag-opportunities][close][response]", {
          status: response.status,
          body: response.data,
          resolvedOpportunityId: updatedOpportunity?.id
        });
      }
      if (updatedOpportunity) updateOpportunityInState(updatedOpportunity);

      if (filters.status === "open") {
        setItems((currentItems) => currentItems.filter((item) => item.id !== targetId));
        if (selectedOpportunity?.id === targetId) closePipelineDrawer();
      }

      if (shouldLogOpportunityDiagnostics) {
        console.info("[diag-opportunities][close][post-action] no query invalidation detected; executing manual refetch via opportunities queries invalidation", {
          refetches: ["GET /opportunities", "GET /opportunities/summary", "GET /clients"],
          triggers: ["refetchOpportunityQueries()", "triggerDashboardRefresh()"],
          reloadPipelineEvents: selectedOpportunity?.id === targetId
        });
      }
      toast.success(`Oportunidade encerrada como ${stageLabel[stage]}`);
      try {
        await invalidateOpportunitiesAndDashboardQueries();
        if (selectedOpportunity?.id === targetId) await loadPipelineEvents(targetId);
      } catch (refreshError) {
        if (shouldLogOpportunityDiagnostics) {
          console.error("[diag-opportunities][close][refresh-error]", refreshError);
        }
        toast.warning("Oportunidade encerrada, mas não foi possível atualizar a tela automaticamente");
      }
      return true;
    } catch (error) {
      if (shouldLogOpportunityDiagnostics) {
        console.error("[diag-opportunities][close][error]", error);
      }
      toast.error(getApiErrorMessage(error, "Não foi possível encerrar a oportunidade"));
      return false;
    } finally {
      setIsQuickActionLoading(null);
    }
  };

  const onConfirmCloseOpportunity = async (event: FormEvent) => {
    event.preventDefault();
    if (!closeOpportunityState || isQuickActionLoading) return;
    const didClose = await applyQuickStage(closeOpportunityState.stage, closeReason, closeOpportunityState.opportunityId);
    if (didClose) closeCloseModal();
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
      await invalidateOpportunitiesAndDashboardQueries();
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
      status: "open",
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
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
            onClick={() => setIsImportModalOpen(true)}
          >
            Importar
          </button>
          <button
            type="button"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            onClick={openCreateModal}
          >
            Nova oportunidade
          </button>
          <div className="inline-flex rounded-lg border border-slate-300 bg-slate-100 p-1 text-sm font-medium">
            <button
              type="button"
              className={`rounded-md px-3 py-1.5 transition ${viewMode === "pipeline" ? "bg-white text-slate-900 shadow" : "text-slate-600 hover:text-slate-900"}`}
              onClick={() => handleViewModeChange("pipeline")}
            >
              Pipeline
            </button>
            <button
              type="button"
              className={`rounded-md px-3 py-1.5 transition ${viewMode === "list" ? "bg-white text-slate-900 shadow" : "text-slate-600 hover:text-slate-900"}`}
              onClick={() => handleViewModeChange("list")}
            >
              Lista
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {/* Fonte atual do KPI = payload de GET /opportunities/summary; provável causa de valores iguais entre vendedores = filtros/resumo não refletirem ownerSellerId/follow-up em todas as mutações. */}
        <Card title="Pipeline total" value={formatCurrencyBRL(summary.pipelineTotal)} loading={loading} />
        <Card title="Valor ponderado" value={formatCurrencyBRL(summary.weightedTotal)} loading={loading} />
        <Card title="Atrasadas" value={`${summary.overdueCount} • ${formatCurrencyBRL(summary.overdueValue)}`} loading={loading} />
        <Card title="Taxa de conversão" value={formatPercentBR(summary.conversionRate)} loading={loading} />
      </div>

      {viewMode === "list" ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-base font-semibold text-slate-900">Filtros</h3>
          <div className="grid gap-3 lg:grid-cols-10">
            <div className="relative lg:col-span-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className="h-10 w-full rounded-lg border border-slate-200 pl-9 pr-3 text-sm"
                placeholder="Busca por título ou cliente"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select className="h-10 rounded-lg border border-slate-200 px-3 text-sm lg:col-span-2" value={filters.stage} onChange={(e) => setFilters((prev) => ({ ...prev, stage: e.target.value }))}>
              <option value="">Todos estágios</option>
              {stages.map((stage) => <option key={stage} value={stage}>{stageLabel[stage]}</option>)}
            </select>
            <select className="h-10 rounded-lg border border-slate-200 px-3 text-sm lg:col-span-2" value={filters.status} onChange={(e) => setFilters((prev) => ({ ...prev, status: e.target.value as OpportunityStatus }))}>
              {Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            {canFilterByOwner ? (
              <select className="h-10 rounded-lg border border-slate-200 px-3 text-sm lg:col-span-2" value={filters.ownerSellerId} onChange={(e) => setFilters((prev) => ({ ...prev, ownerSellerId: e.target.value }))}>
                <option value="">Todos vendedores</option>
                {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
              </select>
            ) : (
              <input disabled className="h-10 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-500 lg:col-span-2" value={user?.name || "Meu pipeline"} />
            )}
            <div className="lg:col-span-2">
              <ClientSearchSelect
                clients={clients}
                value={filters.clientId}
                onChange={(clientId) => setFilters((prev) => ({ ...prev, clientId }))}
                placeholder="Todos clientes"
                emptyLabel="Nenhum cliente encontrado."
                className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm"
              />
            </div>
            <select className="h-10 rounded-lg border border-slate-200 px-3 text-sm lg:col-span-2" value={filters.crop} onChange={(e) => setFilters((prev) => ({ ...prev, crop: e.target.value }))}>
              <option value="">Todas culturas</option>
              {cropOptions.map((crop) => <option key={crop} value={crop}>{crop}</option>)}
            </select>
            <input type="date" className="h-10 rounded-lg border border-slate-200 px-3 text-sm lg:col-span-2" value={filters.dateFrom} onChange={(e) => setFilters((prev) => ({ ...prev, dateFrom: e.target.value }))} />
            <input type="date" className="h-10 rounded-lg border border-slate-200 px-3 text-sm lg:col-span-2" value={filters.dateTo} onChange={(e) => setFilters((prev) => ({ ...prev, dateTo: e.target.value }))} />
            <label className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 lg:col-span-2">
              <input type="checkbox" checked={filters.overdue} onChange={(e) => setFilters((prev) => ({ ...prev, overdue: e.target.checked }))} />Somente atrasadas
            </label>
            <div className="flex lg:col-span-4 lg:justify-end">
              <button type="button" className="h-10 rounded-lg bg-slate-100 px-4 text-sm font-medium text-slate-700 hover:bg-slate-200" onClick={clearFilters}>
                Limpar filtros
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <CreateOpportunityModal
        open={isOpportunityModalOpen}
        title={opportunityModalMode === "edit" ? "Editar oportunidade" : "Nova oportunidade"}
        submitLabel={opportunityModalMode === "edit" ? "Salvar alterações" : "Salvar"}
        form={form}
        clients={clients}
        sellers={sellers}
        userRole={user?.role}
        userName={user?.name}
        isSaving={isSaving}
        errorMessage={submitError}
        stages={stages}
        stageLabel={stageLabel}
        cropOptions={cropSelectOptions}
        onClose={closeOpportunityModal}
        onSubmit={submit}
        onFormChange={setForm}
        sanitizeNumericInput={sanitizeNumericInput}
        ownerSellerId={isSeller && user?.id ? user.id : form.ownerSellerId || undefined}
        requireOwnerSeller={user?.role === "diretor" || user?.role === "gerente"}
        onClientCreated={selectExistingClient}
        onSelectExisting={selectExistingClient}
        hasStructuredItems={hasStructuredItems}
        productsSection={
          <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Produtos da oportunidade</h4>
              {!editing ? <span className="text-xs text-slate-500">Salve a oportunidade para persistir os itens. O total dos produtos atualizará o valor da oportunidade.</span> : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="space-y-1 sm:col-span-4">
                <span className="text-sm font-medium text-slate-700">Produto</span>
                <input
                  list="opportunity-product-options"
                  className="w-full rounded-lg border border-slate-200 p-2"
                  placeholder="Busque por código ERP, nome, classificação ou parte do nome"
                  value={productSearch}
                  onChange={(event) => {
                    const value = event.target.value;
                    setProductSearch(value);
                    searchProducts(value).catch(() => null);
                    const selected = productOptions.find((option) => `${option.erpProductCode} · ${option.name} · ${option.erpProductClassCode}` === value);
                    if (!selected) return;
                    setItemDraft((current) => ({
                      ...current,
                      productId: selected.id,
                      productNameSnapshot: selected.name,
                      erpProductCode: selected.erpProductCode,
                      erpProductClassCode: selected.erpProductClassCode,
                      unit: selected.unit || "",
                      unitPrice: selected.defaultPrice != null ? String(selected.defaultPrice) : current.unitPrice
                    }));
                  }}
                  disabled={!editing}
                />
                <datalist id="opportunity-product-options">
                  {productOptions.map((product) => (
                    <option key={product.id} value={`${product.erpProductCode} · ${product.name} · ${product.erpProductClassCode}`} />
                  ))}
                </datalist>
                {hasAttemptedProductSearch && productOptions.length === 0 ? (
                  <p className="text-xs text-amber-700">Nenhum produto encontrado para essa busca.</p>
                ) : null}
              </label>
              <label className="space-y-1">
                <span className="text-sm font-medium text-slate-700">Quantidade</span>
                <input className="w-full rounded-lg border border-slate-200 p-2" value={itemDraft.quantity} onChange={(e) => setItemDraft((current) => ({ ...current, quantity: sanitizeNumericInput(e.target.value) }))} disabled={!editing} />
              </label>
              <label className="space-y-1">
                <span className="text-sm font-medium text-slate-700">Preço unitário</span>
                <input className="w-full rounded-lg border border-slate-200 p-2" value={itemDraft.unitPrice} onChange={(e) => setItemDraft((current) => ({ ...current, unitPrice: sanitizeNumericInput(e.target.value) }))} disabled={!editing} />
              </label>
              <label className="space-y-1">
                <span className="text-sm font-medium text-slate-700">Desconto</span>
                <div className="flex gap-2">
                  <select className="rounded-lg border border-slate-200 p-2" value={itemDraft.discountType} onChange={(e) => setItemDraft((current) => ({ ...current, discountType: e.target.value as DiscountType }))} disabled={!editing}>
                    <option value="value">R$</option>
                    <option value="percent">%</option>
                  </select>
                  <input className="w-full rounded-lg border border-slate-200 p-2" value={itemDraft.discountValue} onChange={(e) => setItemDraft((current) => ({ ...current, discountValue: sanitizeNumericInput(e.target.value) }))} disabled={!editing} />
                </div>
              </label>
              <label className="space-y-1">
                <span className="text-sm font-medium text-slate-700">Total do item</span>
                <div className="rounded-lg border border-slate-200 bg-white p-2 text-sm text-slate-700">{formatCurrencyBRL(itemDraftTotals.netTotal)}</div>
              </label>
            </div>

            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Observação</span>
              <input className="w-full rounded-lg border border-slate-200 p-2" value={itemDraft.notes} onChange={(e) => setItemDraft((current) => ({ ...current, notes: e.target.value }))} disabled={!editing} />
            </label>

            <div className="flex justify-end">
              <button type="button" className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-400" onClick={() => persistOpportunityItem(itemDraft).catch((error) => toast.error(getApiErrorMessage(error, "Não foi possível salvar item")))} disabled={!editing}>
                {itemDraft.id ? "Atualizar item" : "Adicionar item"}
              </button>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="p-2">Produto</th>
                    <th className="p-2">Qtd</th>
                    <th className="p-2">Preço</th>
                    <th className="p-2">Desc.</th>
                    <th className="p-2">Total</th>
                    <th className="p-2">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingItems ? (
                    <tr><td className="p-3 text-slate-500" colSpan={6}>Carregando itens...</td></tr>
                  ) : opportunityItems.length === 0 ? (
                    <tr><td className="p-3 text-slate-500" colSpan={6}>Nenhum produto adicionado.</td></tr>
                  ) : opportunityItems.map((opportunityItem) => {
                    const totals = calculateItemTotals(opportunityItem);
                    return (
                      <tr key={opportunityItem.id} className="border-t border-slate-100">
                        <td className="p-2">{opportunityItem.productNameSnapshot} · {opportunityItem.erpProductClassCode}</td>
                        <td className="p-2">{opportunityItem.quantity}</td>
                        <td className="p-2">{formatCurrencyBRL(Number(opportunityItem.unitPrice || 0))}</td>
                        <td className="p-2">{opportunityItem.discountType === "percent" ? `${opportunityItem.discountValue}%` : formatCurrencyBRL(Number(opportunityItem.discountValue || 0))}</td>
                        <td className="p-2 font-medium">{formatCurrencyBRL(totals.netTotal)}</td>
                        <td className="p-2">
                          <div className="flex gap-2">
                            <button type="button" className="text-slate-700" onClick={() => setItemDraft(opportunityItem)}>Editar</button>
                            <button type="button" className="text-red-600" onClick={() => removeOpportunityItem(opportunityItem.id).catch((error) => toast.error(getApiErrorMessage(error, "Não foi possível remover item")))}>Excluir</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end text-sm text-slate-700">
              <span className="mr-2">Total geral dos itens:</span>
              <strong>{formatCurrencyBRL(itemsTotals.netTotal)}</strong>
            </div>
          </section>
        }
      />

      <OpportunityImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImported={async () => {
          await refetchOpportunityQueries();
        }}
      />

      {viewMode === "list" ? (

        <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-[1500px] w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-slate-600">
                <th className="p-2">Título</th><th className="p-2">Cliente</th><th className="p-2">Vendedor</th><th className="p-2">Risco</th><th className="p-2">Etapa</th><th className="p-2">Valor</th><th className="p-2">Probabilidade</th><th className="p-2">Valor Ponderado</th><th className="p-2">Cultura</th><th className="p-2">Safra</th><th className="p-2">Área (ha)</th><th className="p-2">Produto ofertado</th><th className="p-2">Entrada proposta</th><th className="p-2">Retorno previsto</th><th className="p-2">Status retorno</th><th className="p-2">Ações</th>
              </tr>
            </thead>
            <tbody>
              {loading ? Array.from({ length: 6 }).map((_, index) => (
                <tr key={`skeleton-${index}`} className="border-t border-slate-100">
                  <td className="p-2" colSpan={16}><div className="h-8 animate-pulse rounded bg-slate-100" /></td>
                </tr>
              )) : sortedItems.length ? sortedItems.map((item) => {
                const weighted = getWeightedValue(item);
                const risk = normalizeRisk(item.risk);
                return (
                  <tr key={item.id} className={`border-t border-slate-100 ${riskRowClassName[risk]}`}>
                    <td className="p-2 font-medium text-slate-800">{item.title}</td>
                    <td className="p-2">{getClientName(item)}</td>
                    <td className="p-2">{getSellerName(item)}</td>
                    <td className="p-2">
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${riskBadgeClassName[risk]}`}>
                        {riskLabel[risk]}
                      </span>
                    </td>
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
                      <button type="button" className="text-brand-700" onClick={() => onEdit(item)}>Editar</button>
                      <button type="button" className="text-red-600" onClick={() => onDelete(item.id)}>Excluir</button>
                      <button type="button" className="text-slate-700" onClick={() => navigate(`/oportunidades/${item.id}`)}>Detalhes</button>
                      {!["ganho", "perdido"].includes(item.stage) ? (
                        <span className="relative inline-block">
                          <button
                            type="button"
                            className="text-slate-700"
                            onClick={() => setOpenCloseMenuId((current) => (current === item.id ? null : item.id))}
                          >
                            Encerrar ▾
                          </button>
                          {openCloseMenuId === item.id ? (
                            <span className="absolute right-0 z-10 mt-1 min-w-44 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                              <button type="button" className="block w-full px-3 py-1.5 text-left text-sm text-emerald-700 hover:bg-emerald-50" onClick={() => openCloseModal(item.id, "ganho")}>Marcar como Ganho</button>
                              <button type="button" className="block w-full px-3 py-1.5 text-left text-sm text-rose-700 hover:bg-rose-50" onClick={() => openCloseModal(item.id, "perdido")}>Marcar como Perdido</button>
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              }) : (
                <tr>
                  <td colSpan={16} className="p-8 text-center text-slate-500">Nenhuma oportunidade encontrada com os filtros aplicados. Tente ajustar os critérios para visualizar resultados.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="grid gap-2 border-b border-slate-100 pb-3 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
            <input className="rounded-lg border border-slate-200 p-2" placeholder="Buscar título ou cliente" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select className="rounded-lg border border-slate-200 p-2" value={filters.status} onChange={(e) => setFilters((prev) => ({ ...prev, status: e.target.value as OpportunityStatus }))}>
              {Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
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

          <div>
            <div className={`grid grid-cols-1 gap-3 ${pipelineStages.length === 2 ? "sm:grid-cols-2" : pipelineStages.length === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2 xl:grid-cols-5"}`}>
              {pipelineStages.map((stage) => {
                const stageItems = opportunitiesByStage[stage];
                const stageTotal = stageItems.reduce((sum, item) => sum + Number(item.value || 0), 0);
                const stageWeightedTotal = stageItems.reduce((sum, item) => sum + getWeightedValue(item), 0);
                return (
                  <div
                    key={stage}
                    className="flex min-h-[360px] flex-col rounded-xl border border-slate-200 bg-slate-50 md:min-h-[430px]"
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
                      )) : stageItems.length ? stageItems.map((item) => {
                        const risk = normalizeRisk(item.risk);
                        return (
                        <div
                          key={item.id}
                          className={`space-y-2 rounded-lg border p-3 shadow-sm ${risk === "alto" ? "border-red-300 bg-red-50/40" : risk === "medio" ? "border-amber-300 bg-amber-50/40" : "border-emerald-200 bg-emerald-50/30"}`}
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
                          <div className="min-w-0 space-y-1">
                            <div className="text-sm font-semibold leading-tight text-slate-800 break-words">{item.title}</div>
                            <div className="text-xs text-slate-600 break-words">{getClientName(item)}</div>
                          </div>
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div className="space-y-1">
                              <div className="text-base font-semibold text-slate-900">{formatCurrencyBRL(item.value)}</div>
                              <div className="text-xs text-slate-500">Follow-up: {formatDateBR(item.followUpDate || item.expectedCloseDate)}</div>
                            </div>
                            <div className="flex flex-col items-end gap-1">
                              <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${riskBadgeClassName[risk]}`}>
                                Risco {riskLabel[risk]}
                              </span>
                              <ReturnStatusBadge status={getReturnStatus(item)} />
                            </div>
                          </div>
                          {!["ganho", "perdido"].includes(item.stage) ? (
                            <div className="relative flex justify-end" onClick={(event) => event.stopPropagation()}>
                              <button
                                type="button"
                                className="rounded-md border border-slate-300 p-1 text-slate-600 hover:bg-slate-100"
                                aria-label="Abrir ações de encerramento"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setOpenCloseMenuId((current) => (current === item.id ? null : item.id));
                                }}
                              >
                                <MoreHorizontal size={14} />
                              </button>
                              {openCloseMenuId === item.id ? (
                                <div className="absolute right-0 z-10 mt-1 min-w-44 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                                  <button type="button" className="block w-full px-3 py-1.5 text-left text-sm text-emerald-700 hover:bg-emerald-50" onClick={() => openCloseModal(item.id, "ganho")}>Marcar como Ganho</button>
                                  <button type="button" className="block w-full px-3 py-1.5 text-left text-sm text-rose-700 hover:bg-rose-50" onClick={() => openCloseModal(item.id, "perdido")}>Marcar como Perdido</button>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                        );
                      }) : <div className="rounded-lg border border-dashed border-slate-300 bg-white p-3 text-center text-xs text-slate-500">Sem oportunidades</div>}
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

            {!["ganho", "perdido"].includes(selectedOpportunity.stage) ? (
              <div className="mt-4">
                <p className="mb-2 text-sm font-medium text-slate-800">Encerrar</p>
                <div className="relative inline-block">
                  <button
                    type="button"
                    disabled={isQuickActionLoading !== null}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:bg-slate-100"
                    onClick={() => setOpenCloseMenuId((current) => (current === selectedOpportunity.id ? null : selectedOpportunity.id))}
                  >
                    {isQuickActionLoading ? "Atualizando..." : "Encerrar ▾"}
                  </button>
                  {openCloseMenuId === selectedOpportunity.id ? (
                    <div className="absolute left-0 z-10 mt-1 min-w-52 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                      <button type="button" className="block w-full px-3 py-1.5 text-left text-sm text-emerald-700 hover:bg-emerald-50" onClick={() => openCloseModal(selectedOpportunity.id, "ganho")}>Marcar como Ganho</button>
                      <button type="button" className="block w-full px-3 py-1.5 text-left text-sm text-rose-700 hover:bg-rose-50" onClick={() => openCloseModal(selectedOpportunity.id, "perdido")}>Marcar como Perdido</button>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

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

            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700"
                onClick={() => onEdit(selectedOpportunity)}
              >
                Editar oportunidade
              </button>
              <button
                type="button"
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white"
                onClick={() => navigate(`/oportunidades/${selectedOpportunity.id}`)}
              >
                Abrir detalhes
              </button>
            </div>

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

      {closeOpportunityState ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4" onClick={closeCloseModal}>
          <form className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-5" onSubmit={onConfirmCloseOpportunity} onClick={(event) => event.stopPropagation()}>
            <h4 className="text-lg font-semibold text-slate-900">Confirmar encerramento</h4>
            <p className="text-sm text-slate-600">Tem certeza que deseja marcar esta oportunidade como <strong>{stageLabel[closeOpportunityState.stage]}</strong>?</p>
            <div>
              <label className="block text-sm font-medium text-slate-700" htmlFor="close-reason">Motivo/Observação (opcional)</label>
              <input
                id="close-reason"
                type="text"
                maxLength={180}
                className="mt-1 w-full rounded-lg border border-slate-200 p-2 text-sm"
                placeholder="Ex.: cliente aprovou proposta / sem orçamento"
                value={closeReason}
                onChange={(event) => setCloseReason(event.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={closeCloseModal}>Cancelar</button>
              <button type="submit" disabled={isQuickActionLoading !== null} className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                {isQuickActionLoading ? "Encerrando..." : `Confirmar como ${stageLabel[closeOpportunityState.stage]}`}
              </button>
            </div>
          </form>
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
