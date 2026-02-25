import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import api from "../lib/apiClient";
import { formatCurrencyBRL, formatDateBR, formatPercentBR } from "../lib/formatters";
import { useAuth } from "../context/AuthContext";

type Stage = "prospeccao" | "negociacao" | "proposta" | "ganho" | "perdido";
type ReturnStatus = "overdue" | "dueSoon" | "ok";

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

const stages: Stage[] = ["prospeccao", "negociacao", "proposta", "ganho", "perdido"];
const cropSelectOptions = ["soja", "milho", "trigo", "pasto", "cobertura", "outros"];

const stageLabel: Record<Stage, string> = {
  prospeccao: "Prospecção",
  negociacao: "Negociação",
  proposta: "Proposta",
  ganho: "Ganho",
  perdido: "Perdido"
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

export default function OpportunitiesPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<Opportunity[]>([]);
  const [summary, setSummary] = useState<Summary>(emptySummary);
  const [clients, setClients] = useState<Client[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
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

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 400);
    return () => clearTimeout(timer);
  }, [search]);

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
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const returnDate = new Date(item.expectedCloseDate);
    const returnDateStart = new Date(returnDate.getFullYear(), returnDate.getMonth(), returnDate.getDate());

    if (returnDateStart < todayStart) return "overdue";

    const limit = new Date(todayStart);
    limit.setDate(limit.getDate() + 2);
    if (returnDateStart <= limit) return "dueSoon";

    return "ok";
  };

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      const aOverdue = getReturnStatus(a) === "overdue" ? 0 : 1;
      const bOverdue = getReturnStatus(b) === "overdue" ? 0 : 1;
      if (aOverdue !== bOverdue) return aOverdue - bOverdue;
      return new Date(a.expectedCloseDate).getTime() - new Date(b.expectedCloseDate).getTime();
    });
  }, [items]);

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

  const onDelete = async (id: string) => {
    await api.delete(`/opportunities/${id}`);
    await load();
    toast.success("Oportunidade excluída");
  };

  return (
    <div className="space-y-5 pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold text-slate-900">Oportunidades</h2>
        <span className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">Modo Lista profissional</span>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card title="Pipeline total" value={formatCurrencyBRL(summary.totalPipelineValue)} loading={loading} />
        <Card title="Valor ponderado" value={formatCurrencyBRL(summary.totalWeightedValue)} loading={loading} />
        <Card title="Atrasadas" value={`${summary.overdueCount} • ${formatCurrencyBRL(summary.overdueValue)}`} loading={loading} />
        <Card title="Taxa de conversão" value={`${formatPercentBR(conversionRate)} (${items.filter((item) => item.stage === "ganho").length}/${items.length || 0})`} loading={loading} />
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-lg font-semibold text-slate-900">Filtros</h3>
        <div className="grid gap-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          <input className="rounded-lg border border-slate-200 p-2" placeholder="Busca por título ou cliente" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="rounded-lg border border-slate-200 p-2" value={filters.stage} onChange={(e) => setFilters((prev) => ({ ...prev, stage: e.target.value }))}>
            <option value="">Todos estágios</option>
            {stages.map((stage) => <option key={stage} value={stage}>{stageLabel[stage]}</option>)}
          </select>
          <select className="rounded-lg border border-slate-200 p-2" value={filters.ownerSellerId} onChange={(e) => setFilters((prev) => ({ ...prev, ownerSellerId: e.target.value }))}>
            <option value="">Todos vendedores</option>
            {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
          </select>
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
          <button type="button" className="rounded-lg bg-slate-100 px-3 font-medium text-slate-700 hover:bg-slate-200" onClick={() => { setFilters({ stage: "", ownerSellerId: "", clientId: "", crop: "", season: "", dateFrom: "", dateTo: "", overdue: false }); setSearch(""); }}>
            Limpar filtros
          </button>
        </div>
      </div>

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
              const status = getReturnStatus(item);
              const weighted = item.weightedValue ?? (Number(item.value || 0) * Number(item.probability || 0)) / 100;
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
                  <td className="p-2">
                    {status === "overdue" ? <Badge className="bg-red-100 text-red-700">Atrasado</Badge> : null}
                    {status === "dueSoon" ? <Badge className="bg-yellow-100 text-yellow-800">Vence em até 2 dias</Badge> : null}
                    {status === "ok" ? <Badge className="bg-emerald-100 text-emerald-700">OK</Badge> : null}
                  </td>
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
    </div>
  );
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
