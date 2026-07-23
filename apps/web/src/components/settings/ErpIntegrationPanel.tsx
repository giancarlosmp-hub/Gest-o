import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import api from "../../lib/apiClient";
import { getApiErrorMessage } from "../../lib/apiError";

type SyncScopeKey =
  | "connection"
  | "products"
  | "partners"
  | "financialProfiles"
  | "partnerTitles"
  | "orderStatus"
  | "salesmen"
  | "paymentMethods"
  | "receivingConditions"
  | "priceTables"
  | "priceVariations"
  | "prices"
  | "branches"
  | "operations";

type SyncScopeStatus = {
  scope?: SyncScopeKey;
  status: "idle" | "running" | "success" | "error" | "skipped" | string;
  lastSyncAt?: string;
  syncedCount?: number;
  errors?: string[];
  sellerId?: string | null;
  sellerName?: string | null;
  authMode?: "global" | "seller" | "seller_reference" | string;
  correlationId?: string;
  durationMs?: number;
  diagnostics?: Record<string, number>;
};

type IntegrationDiagnostics = {
  baseUrl: string | null;
  isConfigured: boolean;
  missingConfig: string[];
  authenticationStatus: "missing_config" | "authenticated" | "not_authenticated" | "auth_failed" | string;
  lastError: string | null;
  lastLoginAt?: string | null;
  tokenExpiresAt?: string | null;
  tokenExpired?: boolean;
  environment?: {
    externalEnvFile: { path: string; exists: boolean };
    receivedEnv: Record<"ULTRAFV3_BASE_URL" | "ERP_CREDENTIAL_ENCRYPTION_KEY" | "JWT_SECRET" | "JWT_ACCESS_SECRET" | "ACCESS_TOKEN_SECRET" | "JWT_REFRESH_SECRET" | "REFRESH_TOKEN_SECRET" | "DATABASE_URL", boolean>;
    jwtSecretConfigured?: boolean;
    missingDiagnosticConfig: string[];
  };
  guidance: string;
};

type OperationalSummary = {
  sentOrders: number;
  pendingOrders: number;
  errorOrders: number;
  syncedOrders: number;
  lastOrderActivityAt?: string | null;
};

type SyncHistoryItem = {
  id: string;
  scope: SyncScopeKey | string;
  trigger: "manual" | "scheduler" | string;
  status: "running" | "success" | "error" | "skipped" | string;
  correlationId?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  syncedCount: number;
  sellerId?: string | null;
  sellerName?: string | null;
  authMode?: "global" | "seller" | "seller_reference" | string;
  errorMessage?: string | null;
  metrics?: Record<string, unknown> | null;
};

type SellerDiagnosticsResponse = Record<string, unknown>;

type AuthModeDiagnostics = {
  hasGlobalCredentials: boolean;
  encryptionKeyConfigured: boolean;
  sellers: { total: number; withErpLink: number; missingErpLink: number; withFv3Login: number; missingFv3Login: number };
  recommendation: "global" | "por_vendedor" | "indefinido" | string;
  rationale: string;
};

type FullSyncResponse = {
  accepted: boolean;
  alreadyRunning: boolean;
  runId: string;
  correlationId: string;
  status: "running" | "already_running";
  message: string;
  warnings?: Array<{ scope: SyncScopeKey | string; label: string; message: string; correlationId: string }>;
};

type FullSyncProgress = {
  isRunning: boolean;
  startedAt: number | null;
  currentStep: string;
  completedSteps: number;
  percent: number;
  correlationId?: string;
};

type SyncStatusResponse = {
  status: Record<SyncScopeKey, SyncScopeStatus>;
  integration?: IntegrationDiagnostics;
  operational?: OperationalSummary;
  productCount: number;
  clientCount: number;
  history?: SyncHistoryItem[];
  automaticSync?: {
    enabled: boolean;
    enabledByEnv: boolean;
    active: boolean;
    initialized: boolean;
    timezone: string;
    windowStartHour: number;
    windowEndHour: number;
    intervalMs: number;
    isRunning: boolean;
    authConfigured?: boolean;
    referenceSellerConfigured?: boolean;
    missingConfig?: string[];
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastRealSchedulerRunAt: string | null;
    lastRealSchedulerSuccessAt: string | null;
    lastRealSchedulerSuccessRecent: boolean;
    lastFinishedAt: string | null;
    nextRunAt: string | null;
    lastError: string | null;
    currentRunId: string | null;
    lastCorrelationId: string | null;
    lastSkippedReason: string | null;
    lastSkippedReasonLabel: string | null;
    panelStatus: "scheduled" | "running" | "success" | "error" | "skipped_lock" | "outside_window" | "disabled" | string;
    lastAttemptStatus: string | null;
    lastAttemptAt: string | null;
    lastAttemptFinishedAt: string | null;
    lastAttemptCorrelationId: string | null;
    lastStepError: string | null;
    statusLabel: string;
    authMode: string;
    configurationOk: boolean;
  };
};

type SyncCardConfig = {
  key: SyncScopeKey;
  title: string;
  endpoint: string;
  countLabel?: string;
  description: string;
};

const FULL_SYNC_STEPS: Array<{ key: SyncScopeKey; label: string; nonCritical?: boolean }> = [
  { key: "connection", label: "Conexão" },
  { key: "salesmen", label: "Vendedores" },
  { key: "partners", label: "Clientes" },
  { key: "financialProfiles", label: "Perfil financeiro" },
  { key: "partnerTitles", label: "Títulos em aberto" },
  { key: "products", label: "Produtos" },
  { key: "priceTables", label: "Tabelas de preço" },
  { key: "prices", label: "Preços calculados" },
  { key: "priceVariations", label: "Variações por tabela" },
  { key: "receivingConditions", label: "Condições de pagamento" },
  { key: "paymentMethods", label: "Formas de pagamento" },
  { key: "branches", label: "Filiais" },
  { key: "operations", label: "Operações" },
  { key: "orderStatus", label: "Status de pedidos", nonCritical: true },
];

const SYNC_CARDS: SyncCardConfig[] = [
  { key: "connection", title: "Conexão UltraFV3", endpoint: "connection", description: "Valida credenciais, autenticação e disponibilidade do UltraFV3." },
  { key: "products", title: "Produtos", endpoint: "products", countLabel: "Produtos sincronizados", description: "Importa produtos com código ERP e unidade; a seleção da oportunidade exibe apenas itens com preço válido, mesmo com estoque zerado." },
  { key: "partners", title: "Clientes/parceiros (vendedor referência/global)", endpoint: "partners", countLabel: "Clientes", description: "Sincroniza /partners com credencial global ou vendedor de referência. Para atualizar carteira completa e trocas de vendedor, use Clientes por vendedor." },
  { key: "financialProfiles", title: "Perfil financeiro", endpoint: "financial-profiles", countLabel: "Perfis", description: "Sincroniza /financialProfiles e enriquece o Cliente 360 com ticket, compras, atrasos e cheques devolvidos." },
  { key: "partnerTitles", title: "Títulos em aberto", endpoint: "partner-titles", countLabel: "Títulos", description: "Sincroniza /partnerTitles, calcula saldo em aberto/vencido e exibe alertas financeiros na oportunidade." },
  { key: "orderStatus", title: "Status de pedidos", endpoint: "order-status", countLabel: "Pedidos consultados", description: "Consulta o /orderStatus em modo somente leitura para atualizar o acompanhamento operacional dos pedidos já enviados." },
  { key: "salesmen", title: "Vendedores", endpoint: "salesmen", description: "Persiste o catálogo de vendedores com código ERP para vínculo com usuários CRM." },
  { key: "paymentMethods", title: "Formas de pagamento", endpoint: "payment-methods", description: "Sincroniza formas de pagamento disponíveis para emissão de pedidos." },
  { key: "receivingConditions", title: "Condições de pagamento", endpoint: "receiving-conditions", description: "Sincroniza condições comerciais de recebimento retornadas pelo UltraFV3." },
  { key: "priceTables", title: "Tabelas de preço", endpoint: "price-tables", description: "Sincroniza tabelas de preço oficiais do UltraFV3." },
  { key: "priceVariations", title: "Variações por tabela", endpoint: "price-variations", description: "Sincroniza /priceVariations para calcular preço por tabela e grupo na oportunidade." },
  { key: "prices", title: "Preços calculados", endpoint: "prices", description: "Sincroniza /prices como fallback de preço por produto e classificação." },
  { key: "branches", title: "Filiais", endpoint: "branches", description: "Sincroniza filiais disponíveis para operação comercial." },
  { key: "operations", title: "Operações", endpoint: "operations", description: "Sincroniza operações fiscais/comerciais exigidas no pedido ERP." },
];

const statusLabel: Record<string, string> = {
  idle: "Nunca sincronizado",
  running: "Sincronizando",
  success: "Sincronizado",
  error: "Com erro",
  skipped: "Ignorado",
};

const statusClasses: Record<string, string> = {
  idle: "bg-slate-100 text-slate-700 ring-slate-200",
  running: "bg-amber-50 text-amber-700 ring-amber-200",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  error: "bg-red-50 text-red-700 ring-red-200",
  skipped: "bg-orange-50 text-orange-700 ring-orange-200",
};

const automaticPanelClasses: Record<string, string> = {
  scheduled: "bg-sky-50 text-sky-700 ring-sky-200",
  running: "bg-amber-50 text-amber-700 ring-amber-200",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  error: "bg-red-50 text-red-700 ring-red-200",
  skipped_lock: "bg-orange-50 text-orange-700 ring-orange-200",
  outside_window: "bg-slate-100 text-slate-700 ring-slate-200",
  disabled: "bg-slate-100 text-slate-700 ring-slate-200",
};

const formatDate = (value?: string) => {
  if (!value) return "Nunca";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
};

const latestError = (status?: SyncScopeStatus) => status?.errors?.[0] || "Nenhum erro registrado.";


const authModeLabel = (mode?: string) => (mode === "seller" ? "Vendedor" : mode === "seller_reference" ? "Vendedor de referência" : "Global");
const contextModeLabel = (mode?: string) => (mode === "seller" ? "seller" : mode === "seller_reference" ? "seller_reference" : "global");
const authenticationStatusLabel: Record<string, string> = {
  missing_config: "Configuração ausente",
  authenticated: "Autenticado",
  not_authenticated: "Não autenticado",
  auth_failed: "Falha de autenticação",
};

const integrationStatusClasses: Record<string, string> = {
  missing_config: "bg-red-50 text-red-700 ring-red-200",
  authenticated: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  not_authenticated: "bg-amber-50 text-amber-700 ring-amber-200",
  auth_failed: "bg-red-50 text-red-700 ring-red-200",
};

export default function ErpIntegrationPanel() {
  const [data, setData] = useState<SyncStatusResponse | null>(null);
  const [authMode, setAuthMode] = useState<AuthModeDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<SyncScopeKey | "allSellers" | "syncAll" | "automaticSync" | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showFullSyncModal, setShowFullSyncModal] = useState(false);
  const [fullSyncWarnings, setFullSyncWarnings] = useState<FullSyncResponse["warnings"]>(undefined);
  const [sellerDiag, setSellerDiag] = useState<SellerDiagnosticsResponse | null>(null);
  const [sellerDiagLoading, setSellerDiagLoading] = useState(false);
  const [fullSyncProgress, setFullSyncProgress] = useState<FullSyncProgress>({
    isRunning: false,
    startedAt: null,
    currentStep: "Aguardando confirmação",
    completedSteps: 0,
    percent: 0,
  });

  const load = async () => {
    const [statusResponse, authModeResponse] = await Promise.all([
      api.get<SyncStatusResponse>("/erp/ultrafv3/sync/status"),
      api.get<AuthModeDiagnostics>("/erp/ultrafv3/auth/mode-diagnostics"),
    ]);
    setData(statusResponse.data);
    setAuthMode(authModeResponse.data);
  };

  useEffect(() => {
    load()
      .catch((error) => toast.error(getApiErrorMessage(error, "Não foi possível carregar status da integração ERP.")))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      load().catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  const runSync = async (card: SyncCardConfig) => {
    setRunning(card.key);
    try {
      await api.post(`/erp/ultrafv3/sync/${card.endpoint}`);
      toast.success(`${card.title} sincronizado com sucesso.`);
      await load();
    } catch (error) {
      toast.error(getApiErrorMessage(error, `Não foi possível sincronizar ${card.title}.`));
      await load().catch(() => undefined);
    } finally {
      setRunning(null);
    }
  };

  const runAllSellerPartnersSync = async () => {
    setRunning("allSellers");
    try {
      const response = await api.post<{ totalUsers: number; successCount: number; errorCount: number; skippedCount: number; syncedCount?: number; created?: number; updated?: number }>("/erp/ultrafv3/sync/partners/all-sellers");
      const { totalUsers, successCount, errorCount, skippedCount, syncedCount, created, updated } = response.data;
      const processed = Number(syncedCount ?? 0) || Number(created ?? 0) + Number(updated ?? 0);
      if (errorCount > 0 || skippedCount > 0 || response.status === 207) {
        toast.warning(`Sincronização parcial: ${processed} clientes processados; ${errorCount + skippedCount} vendedor(es) sem dados ou com falha.`);
      } else {
        toast.success(`Sync por vendedor finalizado: ${successCount}/${totalUsers} sucesso, ${processed} clientes processados.`);
      }
      await load();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível sincronizar clientes de todos vendedores."));
      await load().catch(() => undefined);
    } finally {
      setRunning(null);
    }
  };


  const calculateFullSyncProgress = (statusData: SyncStatusResponse | null, startedAt: number | null) => {
    if (!startedAt || !statusData) return { completedSteps: 0, currentStep: FULL_SYNC_STEPS[0]?.label ?? "Iniciando", percent: 0, correlationId: undefined };
    const completedSteps = FULL_SYNC_STEPS.filter((step) => {
      const status = statusData.status?.[step.key];
      const syncedAt = status?.lastSyncAt ? new Date(status.lastSyncAt).getTime() : 0;
      return status?.status === "success" && syncedAt >= startedAt;
    }).length;
    const runningStep = FULL_SYNC_STEPS.find((step) => statusData.status?.[step.key]?.status === "running");
    const nextStep = FULL_SYNC_STEPS[completedSteps];
    const currentStep = runningStep?.label || nextStep?.label || "Finalizando";
    const activeStatus = runningStep ? statusData.status?.[runningStep.key] : undefined;
    return {
      completedSteps,
      currentStep,
      percent: Math.min(99, Math.round((completedSteps / FULL_SYNC_STEPS.length) * 100)),
      correlationId: activeStatus?.correlationId,
    };
  };

  const refreshFullSyncProgress = async (startedAt: number) => {
    const statusResponse = await api.get<SyncStatusResponse>("/erp/ultrafv3/sync/status");
    setData(statusResponse.data);
    const progress = calculateFullSyncProgress(statusResponse.data, startedAt);
    setFullSyncProgress((current) => ({ ...current, ...progress }));
  };

  const waitForFullSyncCompletion = async (runId: string, startedAt: number) => {
    for (;;) {
      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      const statusResponse = await api.get<SyncStatusResponse>("/erp/ultrafv3/sync/status");
      setData(statusResponse.data);
      const progress = calculateFullSyncProgress(statusResponse.data, startedAt);
      const fullSyncRun = statusResponse.data.history?.find((item) => item.id === runId);
      const metrics = fullSyncRun?.metrics ?? {};
      const warnings = Array.isArray((metrics as { warnings?: unknown }).warnings)
        ? (metrics as { warnings: FullSyncResponse["warnings"] }).warnings
        : undefined;
      setFullSyncProgress((current) => ({
        ...current,
        ...progress,
        completedSteps: typeof metrics.completedSteps === "number" ? metrics.completedSteps : progress.completedSteps,
        percent: fullSyncRun?.status && fullSyncRun.status !== "running" ? 100 : progress.percent,
        currentStep: fullSyncRun?.status && fullSyncRun.status !== "running" ? "Sincronização completa finalizada" : progress.currentStep,
      }));
      if (!fullSyncRun || fullSyncRun.status === "running") continue;
      return { fullSyncRun, warnings };
    }
  };

  const runFullSync = async () => {
    const startedAt = Date.now();
    setShowFullSyncModal(false);
    setRunning("syncAll");
    setFullSyncProgress({ isRunning: true, startedAt, currentStep: FULL_SYNC_STEPS[0]?.label ?? "Iniciando", completedSteps: 0, percent: 0 });
    setFullSyncWarnings(undefined);
    const timer = window.setInterval(() => {
      refreshFullSyncProgress(startedAt).catch(() => undefined);
    }, 2_000);

    try {
      const response = await api.post<FullSyncResponse>("/erp/sync-all");
      toast.success(response.data.alreadyRunning ? "Sincronização já em execução" : "Sincronização iniciada");
      setFullSyncProgress((current) => ({ ...current, correlationId: response.data.correlationId }));
      const { fullSyncRun, warnings } = await waitForFullSyncCompletion(response.data.runId, startedAt);
      window.clearInterval(timer);
      await load();
      setFullSyncProgress({
        isRunning: false,
        startedAt,
        currentStep: "Sincronização completa finalizada",
        completedSteps: FULL_SYNC_STEPS.length,
        percent: 100,
        correlationId: response.data.correlationId,
      });
      if (fullSyncRun.status === "error") {
        toast.error(fullSyncRun.errorMessage || "Falha crítica na Sincronização Completa ERP.");
      } else if (warnings?.length) {
        setFullSyncWarnings(warnings);
        toast.warning("Sincronização concluída com avisos");
      } else {
        toast.success("Sincronização concluída com sucesso");
      }
    } catch (error) {
      window.clearInterval(timer);
      await load().catch(() => undefined);
      setFullSyncProgress((current) => ({ ...current, isRunning: false }));
      setFullSyncWarnings(undefined);
      toast.error(getApiErrorMessage(error, "Não foi possível executar a Sincronização Completa ERP."));
    } finally {
      setRunning(null);
    }
  };

  const runSellerDiagnostics = async () => {
    setSellerDiagLoading(true);
    try {
      const response = await api.get<SellerDiagnosticsResponse>("/erp/ultrafv3/seller-diagnostics", {
        params: { sellerCode: "7057", operatorCode: "45", search: "Jeferson Luiz Carlota" },
      });
      setSellerDiag(response.data);
      toast.success("Diagnóstico ERP do vendedor carregado.");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível carregar o diagnóstico do vendedor."));
    } finally {
      setSellerDiagLoading(false);
    }
  };

  const toggleAutomaticSync = async () => {
    const enabled = !(data?.automaticSync?.enabled ?? false);
    setRunning("automaticSync");
    try {
      const response = await api.patch<{ automaticSync: SyncStatusResponse["automaticSync"] }>("/erp/ultrafv3/sync/automatic", { enabled });
      setData((current) => current ? { ...current, automaticSync: response.data.automaticSync } : current);
      toast.success(enabled ? "Sincronização automática ativada." : "Sincronização automática desativada.");
      await load();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível alterar a sincronização automática."));
    } finally {
      setRunning(null);
    }
  };

  const summary = useMemo(() => {
    const statuses = data ? Object.values(data.status) : [];
    const errors = statuses.filter((item) => item?.status === "error").length;
    const runningCount = statuses.filter((item) => item?.status === "running").length;
    const lastError = statuses.find((item) => item?.status === "error")?.errors?.[0] ?? null;
    return { errors, runningCount, lastError };
  }, [data]);


  const sellerPartnerRuns = useMemo(() => {
    const grouped = new Map<string, { sellerId: string; sellerName: string; status: string; syncedCount: number; durationMs?: number | null; requestDurationMs?: number | null; error?: string }>();
    for (const item of data?.history ?? []) {
      if (item.scope !== "partners" || item.authMode !== "seller" || !item.sellerId) continue;
      if (grouped.has(item.sellerId)) continue;
      grouped.set(item.sellerId, {
        sellerId: item.sellerId,
        sellerName: item.sellerName || "Sem nome",
        status: item.status,
        syncedCount: item.syncedCount,
        durationMs: item.durationMs,
        requestDurationMs: typeof item.metrics?.requestDurationMs === "number" ? item.metrics.requestDurationMs : null,
        error: item.errorMessage || undefined,
      });
    }
    return Array.from(grouped.values());
  }, [data]);

  if (loading) return <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">Carregando integração ERP...</div>;

  const integration = data?.integration;
  const integrationClasses = integrationStatusClasses[integration?.authenticationStatus || "not_authenticated"] || integrationStatusClasses.not_authenticated;
  const missingConfig = integration?.missingConfig ?? [];
  const hasSellerFallback = (authMode?.encryptionKeyConfigured ?? false) && (authMode?.sellers.withFv3Login ?? 0) > 0;
  const hasGlobalCredentials = authMode?.hasGlobalCredentials ?? false;
  const hasAnyCredentialPath = hasGlobalCredentials || hasSellerFallback;
  const hasBaseUrlConfigured = Boolean(integration?.baseUrl);
  const orderBlockingMissingConfig = missingConfig.filter((item) => item === "ULTRAFV3_BASE_URL" || item === "ERP_CREDENTIAL_ENCRYPTION_KEY");
  const envDiagnosticRows = [
    { label: "Arquivo externo de ambiente", present: integration?.environment?.externalEnvFile.exists ?? false, detail: integration?.environment?.externalEnvFile.path ?? "/root/demetra-env/.env" },
    { label: "ULTRAFV3_BASE_URL", present: integration?.environment?.receivedEnv.ULTRAFV3_BASE_URL ?? false },
    { label: "ERP_CREDENTIAL_ENCRYPTION_KEY", present: integration?.environment?.receivedEnv.ERP_CREDENTIAL_ENCRYPTION_KEY ?? false },
    { label: "Segredo JWT", present: integration?.environment?.jwtSecretConfigured ?? integration?.environment?.receivedEnv.JWT_SECRET ?? false, detail: "JWT_SECRET ou ACCESS/REFRESH token secrets" },
    { label: "DATABASE_URL", present: integration?.environment?.receivedEnv.DATABASE_URL ?? false },
  ];
  const hasPreventiveConfig = orderBlockingMissingConfig.length === 0;
  const canSyncReferenceCards = hasBaseUrlConfigured && hasAnyCredentialPath && hasPreventiveConfig;
  const configGuidanceMessage = missingConfig.includes("ERP_CREDENTIAL_ENCRYPTION_KEY")
    ? "Configure ERP_CREDENTIAL_ENCRYPTION_KEY para habilitar credenciais por vendedor e desbloquear envios de pedidos ERP."
    : !hasBaseUrlConfigured
    ? "Configure ULTRAFV3_BASE_URL para habilitar as sincronizações."
    : !hasAnyCredentialPath
      ? "Sem credenciais válidas: configure ULTRAFV3_USERNAME/ULTRAFV3_PASSWORD ou Login FV3/Senha FV3 de pelo menos 1 vendedor ativo."
      : !hasGlobalCredentials && hasSellerFallback
        ? "Modo por vendedor disponível: as sincronizações usarão credencial de vendedor como fallback."
        : null;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Integração ERP UltraFV3</h3>
            <p className="mt-1 text-xs text-slate-600">Diagnóstico consolidado antes do envio de pedidos ao ERP. A sincronização usa somente endpoints UltraFV3.</p>
          </div>
          <div className="text-xs text-slate-600 md:text-right">
            <p>Produtos CRM: {data?.productCount ?? 0}</p>
            <p>Clientes CRM: {data?.clientCount ?? 0}</p>
            <p>{summary.runningCount ? `${summary.runningCount} sincronização(ões) em execução` : summary.errors ? `${summary.errors} card(s) com erro` : "Sem erros ativos"}</p>
            <button type="button" className="mt-2 rounded-lg border border-slate-300 px-3 py-1 font-semibold text-slate-700 hover:bg-white" onClick={() => setAutoRefresh((value) => !value)}>
              Auto-refresh: {autoRefresh ? "ligado" : "desligado"}
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 border-t border-slate-200 pt-4 text-xs md:grid-cols-2 xl:grid-cols-6">
          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <p className="font-semibold text-slate-700">Base URL UltraFV3</p>
            <p className={integration?.baseUrl ? "mt-1 break-all text-slate-900" : "mt-1 text-red-700"}>{integration?.baseUrl || "Ausente"}</p>
          </div>
          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <p className="font-semibold text-slate-700">Autenticação</p>
            <span className={`mt-2 inline-flex rounded-full px-2 py-1 text-[11px] font-semibold ring-1 ${integrationClasses}`}>
              {authenticationStatusLabel[integration?.authenticationStatus || "not_authenticated"] || integration?.authenticationStatus || "Não autenticado"}
            </span>
          </div>
          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <p className="font-semibold text-slate-700">Último login</p>
            <p className="mt-1 text-slate-900">{formatDate(integration?.lastLoginAt || undefined)}</p>
          </div>
          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <p className="font-semibold text-slate-700">Token</p>
            <p className={integration?.tokenExpired ? "mt-1 text-red-700" : "mt-1 text-slate-900"}>{integration?.tokenExpired ? "Expirado" : "Válido/indeterminado"}</p>
          </div>
          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <p className="font-semibold text-slate-700">Último erro</p>
            <p className={integration?.lastError ? "mt-1 text-red-700" : "mt-1 text-slate-500"}>{integration?.lastError || "Nenhum erro registrado."}</p>
          </div>
          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <p className="font-semibold text-slate-700">O que falta configurar</p>
            <p className={missingConfig.length ? "mt-1 text-red-700" : "mt-1 text-slate-600"}>
              {missingConfig.length ? missingConfig.join(", ") : integration?.guidance || "Configuração mínima presente."}
            </p>
          </div>
        </div>


        <div className="mt-4 grid gap-3 border-t border-slate-200 pt-4 text-xs md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <p className="font-semibold text-slate-700">Sincronização automática</p>
            <span className={`mt-2 inline-flex rounded-full px-2 py-1 font-semibold ring-1 ${automaticPanelClasses[data?.automaticSync?.panelStatus || "disabled"] || automaticPanelClasses.disabled}`}>
              {data?.automaticSync?.statusLabel || (data?.automaticSync?.enabled ? "Agendada" : "Inativa")}
            </span>
            <p className="mt-2 text-slate-500">{data?.automaticSync?.active ? "Ativo" : "Inativo"} · Janela 07:00–19:00 · America/Sao_Paulo · Frequência 1 hora</p>
            <p className="mt-1 text-slate-500">Backend: {data?.automaticSync?.initialized ? "inicializado" : "não inicializado"} · Auth: {authModeLabel(data?.automaticSync?.authMode)} · Global: {data?.automaticSync?.authConfigured ? "sim" : "não"} · Vendedor referência: {data?.automaticSync?.referenceSellerConfigured ? "sim" : "não"}</p>
            {!data?.automaticSync?.enabledByEnv ? (
              <p className="mt-1 text-amber-700">ERP_SYNC_SCHEDULER_ENABLED desabilitada no ambiente.</p>
            ) : null}
            {data?.automaticSync?.lastSkippedReasonLabel ? (
              <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-amber-800">Motivo atual: {data.automaticSync.lastSkippedReasonLabel}</p>
            ) : null}
            <button
              type="button"
              className="mt-3 rounded-lg border border-brand-200 px-3 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-60"
              onClick={() => void toggleAutomaticSync()}
              disabled={running === "automaticSync"}
            >
              {data?.automaticSync?.enabled ? "Desativar sincronização automática" : "Ativar sincronização automática"}
            </button>
          </div>
          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <p className="font-semibold text-slate-700">Última sincronização automática</p>
            <p className="mt-1 text-slate-900">{formatDate(data?.automaticSync?.lastRealSchedulerRunAt || undefined)}</p>
            <p className="mt-1 text-slate-500">Última execução real concluída: {formatDate(data?.automaticSync?.lastFinishedAt || undefined)}</p>
            <p className="mt-1 text-slate-500">Último sucesso real scheduler: {formatDate(data?.automaticSync?.lastRealSchedulerSuccessAt || undefined)}</p>
            {data?.automaticSync?.lastRealSchedulerSuccessAt && !data?.automaticSync?.lastRealSchedulerSuccessRecent ? (
              <p className="mt-1 text-amber-700">Último sucesso automático não é recente; o painel não marca como sucesso atual.</p>
            ) : null}
          </div>
          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <p className="font-semibold text-slate-700">Próxima execução prevista</p>
            <p className="mt-1 text-slate-900">{data?.automaticSync?.active ? formatDate(data?.automaticSync?.nextRunAt || undefined) : "—"}</p>
            <p className="mt-1 text-slate-500">Próxima execução real calculada pelo backend; fica vazia quando o scheduler está inativo.</p>
          </div>
          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <p className="font-semibold text-slate-700">Último evento automático</p>
            <p className="mt-1 text-slate-600">Status: {statusLabel[data?.automaticSync?.lastAttemptStatus || "idle"] || data?.automaticSync?.lastAttemptStatus || "Nunca"}</p>
            <p className="mt-1 text-slate-600">Início: {formatDate(data?.automaticSync?.lastAttemptAt || undefined)}</p>
            <p className="mt-1 text-slate-600">Fim: {formatDate(data?.automaticSync?.lastAttemptFinishedAt || undefined)}</p>
            <p className="mt-1 truncate text-slate-500" title={data?.automaticSync?.lastAttemptCorrelationId || undefined}>correlationId: {data?.automaticSync?.lastAttemptCorrelationId || "—"}</p>
            <p className="mt-1 text-slate-600">Último skip: {data?.automaticSync?.lastSkippedReasonLabel || "—"}</p>
            <p className={data?.automaticSync?.lastError ? "mt-1 text-red-700" : "mt-1 text-slate-500"}>Último erro automático: {data?.automaticSync?.lastError || "Nenhum erro registrado."}</p>
          </div>
        </div>

        <div className="mt-4 rounded-lg bg-white p-3 text-xs ring-1 ring-slate-200">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <p className="font-semibold text-slate-800">Diagnóstico preventivo do ambiente sensível</p>
            <p className="text-slate-500">Valores reais nunca são exibidos.</p>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
            {envDiagnosticRows.map((item) => (
              <div key={item.label} className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200" title={item.detail}>
                <p className="font-semibold text-slate-700">{item.label}</p>
                <p className={item.present ? "mt-1 text-emerald-700" : "mt-1 text-red-700"}>{item.present ? "Presente" : "Ausente"}</p>
              </div>
            ))}
          </div>
          {integration?.environment?.missingDiagnosticConfig?.length ? (
            <p className="mt-3 text-red-700">Ausentes no processo da API: <span className="font-mono font-semibold">{integration.environment.missingDiagnosticConfig.join(", ")}</span>.</p>
          ) : null}
        </div>
      </div>

      {orderBlockingMissingConfig.length ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <strong>Configuração preventiva ERP incompleta.</strong> Variáveis ausentes: <span className="font-mono font-semibold">{orderBlockingMissingConfig.join(", ")}</span>. O envio de pedidos ERP fica bloqueado até corrigir o ambiente da API e reiniciar o serviço.
        </div>
      ) : null}

      <div className="rounded-xl border border-brand-200 bg-gradient-to-r from-brand-700 to-emerald-700 p-4 text-white shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h4 className="text-base font-semibold">Sincronização Completa ERP</h4>
            <p className="mt-1 text-sm text-white/85">Sincroniza todos os catálogos UltraFV3 em sequência, sem execução paralela, parando no primeiro erro crítico. Status de pedidos é leitura operacional e vira aviso não crítico.</p>
          </div>
          <button
            type="button"
            className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-brand-800 shadow-sm disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
            disabled={running !== null || !canSyncReferenceCards}
            onClick={() => setShowFullSyncModal(true)}
          >
            Sincronização Completa ERP
          </button>
        </div>
        {(fullSyncProgress.isRunning || fullSyncProgress.percent > 0) ? (
          <div className="mt-4 rounded-lg bg-white/10 p-3 ring-1 ring-white/20">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span>Etapa atual: {fullSyncProgress.currentStep}</span>
              <span>{fullSyncProgress.percent}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/20">
              <div className="h-full rounded-full bg-white transition-all" style={{ width: `${fullSyncProgress.percent}%` }} />
            </div>
            <p className="mt-2 text-xs text-white/80">{fullSyncProgress.completedSteps}/{FULL_SYNC_STEPS.length} etapas concluídas{fullSyncProgress.correlationId ? ` · correlationId: ${fullSyncProgress.correlationId}` : ""}</p>
          </div>
        ) : null}
      </div>


      <div className="rounded-xl border border-brand-100 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h4 className="text-sm font-semibold text-slate-900">Modo de autenticação UltraFV3</h4>
            <p className="mt-1 text-xs text-slate-600">O CRM mantém login próprio por e-mail/senha. Estes dados são somente vínculo técnico com o ERP.</p>
          </div>
          <span className="inline-flex w-fit rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-brand-700 ring-1 ring-brand-100">
            {authMode?.recommendation === "por_vendedor" ? "Usando autenticação do vendedor" : authMode?.recommendation === "global" ? "Usando autenticação global" : "Modo indefinido"}
          </span>
        </div>
        <p className="mt-3 text-sm text-slate-700">{authMode?.rationale || "Carregando diagnóstico de autenticação."}</p>
        <div className="mt-4 grid gap-3 text-xs md:grid-cols-4">
          <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200"><strong>Global .env</strong><span className="mt-1 block text-slate-600">{authMode?.hasGlobalCredentials ? "ULTRAFV3_USERNAME/PASSWORD configurados" : "Credencial global ausente"}</span></div>
          <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200"><strong>Vínculo ERP</strong><span className="mt-1 block text-slate-600">{authMode ? `${authMode.sellers.withErpLink}/${authMode.sellers.total} vendedores` : "—"}</span></div>
          <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200"><strong>Login FV3 vendedor</strong><span className="mt-1 block text-slate-600">{authMode ? `${authMode.sellers.withFv3Login}/${authMode.sellers.total} configurados` : "—"}</span></div>
          <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200"><strong>Criptografia</strong><span className="mt-1 block text-slate-600">{authMode?.encryptionKeyConfigured ? "ERP_CREDENTIAL_ENCRYPTION_KEY ativa" : "Chave não configurada"}</span></div>
        </div>
        {authMode && authMode.recommendation !== "global" && authMode.sellers.missingFv3Login > 0 ? (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Atenção: se o UltraFV3 restringir clientes/produtos/preços por login de vendedor, configure Login FV3 e Senha FV3 para {authMode.sellers.missingFv3Login} vendedor(es) ativo(s).
          </div>
        ) : null}
      </div>

      {(summary.errors > 0 || (data?.operational?.errorOrders ?? 0) > 0) ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <strong>Alerta operacional ERP:</strong> existem falhas de sincronização ou pedidos com erro. Revise o histórico, correlationId e último erro antes de executar novamente.
          {summary.lastError ? <p className="mt-1 text-xs">Último erro: {summary.lastError}</p> : null}
        </div>
      ) : null}

      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h4 className="text-sm font-semibold text-emerald-950">Clientes por vendedor</h4>
            <p className="mt-1 text-xs text-emerald-800">Use esta opção para atualizar a carteira completa: executa /partners sequencialmente com Login FV3 de cada vendedor ativo configurado, sem concorrência por vendedor, e aplica trocas de carteira no CRM.</p>
          </div>
          <button
            type="button"
            className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-400"
            disabled={running !== null}
            onClick={runAllSellerPartnersSync}
          >
            {running === "allSellers" ? "Sincronizando todos..." : "Sincronizar clientes de todos vendedores"}
          </button>
        </div>
      </div>


      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h4 className="text-sm font-semibold text-slate-900">Resumo de clientes por vendedor</h4>
        <p className="mt-1 text-xs text-slate-600">Última execução individual por vendedor (fluxo correto para parceiros/clientes).</p>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="text-slate-500"><tr><th className="py-2 pr-3">Vendedor</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Importados</th><th className="py-2 pr-3">Duração</th><th className="py-2 pr-3">Chamada /partners</th><th className="py-2 pr-3">Erro</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {sellerPartnerRuns.map((item) => (
                <tr key={item.sellerId}><td className="py-2 pr-3 font-medium text-slate-800">{item.sellerName}</td><td className="py-2 pr-3"><span className={`rounded-full px-2 py-1 font-semibold ring-1 ${statusClasses[item.status] || statusClasses.idle}`}>{statusLabel[item.status] || item.status}</span></td><td className="py-2 pr-3 text-slate-900">{item.syncedCount}</td><td className="py-2 pr-3 text-slate-600">{item.durationMs ?? 0}ms</td><td className="py-2 pr-3 text-slate-600">{item.requestDurationMs ?? "—"}{item.requestDurationMs != null ? "ms" : ""}</td><td className="max-w-md truncate py-2 pr-3 text-red-700" title={item.error}>{item.error || "—"}</td></tr>
              ))}
              {!sellerPartnerRuns.length ? <tr><td colSpan={6} className="py-4 text-center text-slate-500">Nenhuma execução por vendedor registrada.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-2 xl:grid-cols-5">
        {[
          { label: "Pedidos enviados", value: data?.operational?.sentOrders ?? 0 },
          { label: "Pendentes", value: data?.operational?.pendingOrders ?? 0 },
          { label: "Erro", value: data?.operational?.errorOrders ?? 0 },
          { label: "Sincronizados", value: data?.operational?.syncedOrders ?? 0 },
        ].map((item) => (
          <div key={item.label} className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
            <p className="text-xs font-semibold text-slate-500">{item.label}</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{item.value}</p>
          </div>
        ))}
        <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
          <p className="text-xs font-semibold text-slate-500">Último sync</p>
          <p className="mt-1 text-sm font-bold text-slate-900">{formatDate(data?.operational?.lastOrderActivityAt || data?.status?.products?.lastSyncAt || data?.status?.partners?.lastSyncAt)}</p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-slate-900">Histórico de execução</h4>
            <p className="mt-1 text-xs text-slate-500">Últimas execuções manuais e automáticas, com métricas, duração e correlationId.</p>
          </div>
          <button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => load().catch(() => undefined)}>Atualizar painel</button>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="py-2 pr-3">Escopo</th>
                <th className="py-2 pr-3">Vendedor</th>
                <th className="py-2 pr-3">Auth</th>
                <th className="py-2 pr-3">Origem</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Último sync</th>
                <th className="py-2 pr-3">Qtd.</th>
                <th className="py-2 pr-3">Duração</th>
                <th className="py-2 pr-3">correlationId</th>
                <th className="py-2 pr-3">Último erro</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(data?.history ?? []).map((item) => (
                <tr key={item.id}>
                  <td className="py-2 pr-3 font-semibold text-slate-800">{item.scope}</td>
                  <td className="py-2 pr-3 text-slate-700">{item.sellerName || "Global"}</td>
                  <td className="py-2 pr-3"><span className="rounded-full bg-slate-50 px-2 py-1 font-semibold text-slate-700 ring-1 ring-slate-200">{authModeLabel(item.authMode)}</span></td>
                  <td className="py-2 pr-3 text-slate-600">{item.trigger === "scheduler" ? "Automática" : "Manual"}</td>
                  <td className="py-2 pr-3"><span className={`rounded-full px-2 py-1 font-semibold ring-1 ${statusClasses[item.status] || statusClasses.idle}`}>{statusLabel[item.status] || item.status}</span></td>
                  <td className="py-2 pr-3 text-slate-600">{formatDate(item.finishedAt || item.startedAt)}</td>
                  <td className="py-2 pr-3 text-slate-900">{item.syncedCount}</td>
                  <td className="py-2 pr-3 text-slate-600">{item.durationMs ?? 0}ms</td>
                  <td className="max-w-[160px] truncate py-2 pr-3 font-mono text-slate-500" title={item.correlationId || undefined}>{item.correlationId || "—"}</td>
                  <td className="max-w-xs truncate py-2 pr-3 text-red-700" title={item.errorMessage || undefined}>{item.errorMessage || "—"}</td>
                </tr>
              ))}
              {!(data?.history ?? []).length ? (
                <tr><td colSpan={10} className="py-4 text-center text-slate-500">Nenhuma execução registrada.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {configGuidanceMessage ? (
        <div className={`rounded-xl border p-3 text-sm ${canSyncReferenceCards ? "border-amber-200 bg-amber-50 text-amber-800" : "border-red-200 bg-red-50 text-red-800"}`}>
          {configGuidanceMessage}
        </div>
      ) : null}

      <section className="rounded-xl border border-violet-200 bg-violet-50/60 p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h4 className="text-sm font-semibold text-violet-950">Diagnóstico ERP do vendedor — Jeferson Luiz Carlota</h4>
            <p className="mt-1 text-xs leading-relaxed text-violet-800">Tela temporária para investigar definitivamente CODVENDEDOR 7057 / OPERADOR 45: CRM, cache UltraFV3, sincronização individual/global, pedido ERP e divergências, sem exibir senha ou token.</p>
          </div>
          <button
            type="button"
            className="rounded-lg bg-violet-700 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-400"
            onClick={runSellerDiagnostics}
            disabled={sellerDiagLoading}
          >
            {sellerDiagLoading ? "Investigando..." : "Investigar 7057"}
          </button>
        </div>
        {sellerDiag ? (
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            {[
              ["CRM", (sellerDiag as { crm?: unknown }).crm],
              ["UltraFV3", (sellerDiag as { ultraFv3?: unknown }).ultraFv3],
              ["Divergências", (sellerDiag as { divergences?: unknown }).divergences],
              ["Cache", (sellerDiag as { cache?: unknown }).cache],
              ["Fluxos", (sellerDiag as { flow?: unknown }).flow],
            ].map(([title, value]) => (
              <div key={String(title)} className="rounded-lg border border-violet-100 bg-white p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-violet-800">{String(title)}</p>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-100">{JSON.stringify(value ?? null, null, 2)}</pre>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-violet-800">Clique em “Investigar 7057” para consultar CRM, caches locais e UltraFV3 ao vivo com as credenciais do vendedor.</p>
        )}
      </section>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {SYNC_CARDS.map((card) => {
          const status = data?.status?.[card.key] ?? { status: "idle", syncedCount: 0 };
          const isRunning = running === card.key || status.status === "running";
          const classes = statusClasses[status.status] || statusClasses.idle;

          return (
            <section key={card.key} className="flex min-h-[250px] flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold text-slate-900">{card.title}</h4>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">{card.description}</p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold ring-1 ${classes}`}>{statusLabel[status.status] || status.status}</span>
              </div>

              <dl className="mt-4 space-y-2 text-xs text-slate-600">
                <div className="flex justify-between gap-3">
                  <dt>Status</dt>
                  <dd className="font-medium text-slate-900">{statusLabel[status.status] || status.status}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>Última sincronização</dt>
                  <dd className="text-right font-medium text-slate-900">{formatDate(status.lastSyncAt)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>{card.countLabel || "Quantidade sincronizada"}</dt>
                  <dd className="font-medium text-slate-900">{status.syncedCount ?? 0}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>Auth</dt>
                  <dd className="text-right font-medium text-slate-900">{authModeLabel(status.authMode)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>Contexto</dt>
                  <dd className="text-right font-medium text-slate-900">{status.sellerName || "Global"} ({contextModeLabel(status.authMode)})</dd>
                </div>
              </dl>

              {status.diagnostics && Object.keys(status.diagnostics).length > 0 && (
                <div className="mt-3 rounded-lg bg-slate-50 p-2 text-[11px] text-slate-600">
                  {Object.entries(status.diagnostics).slice(0, 6).map(([key, value]) => (
                    <p key={key} className="flex justify-between gap-2"><span>{key}</span><strong>{value}</strong></p>
                  ))}
                </div>
              )}

              <div className={`mt-3 rounded-lg p-2 text-xs ${status.status === "error" ? "bg-red-50 text-red-700" : "bg-slate-50 text-slate-500"}`}>
                <span className="font-semibold">Erro mais recente: </span>{latestError(status)}
                {status.correlationId ? <p className="mt-1 break-all"><span className="font-semibold">correlationId: </span>{status.correlationId}</p> : null}
                {status.durationMs ? <p className="mt-1"><span className="font-semibold">Duração: </span>{status.durationMs}ms</p> : null}
              </div>

              <button
                type="button"
                className="mt-auto rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-400"
                disabled={running !== null || isRunning || !canSyncReferenceCards}
                onClick={() => runSync(card)}
              >
                {isRunning ? "Sincronizando..." : "Sincronizar"}
              </button>
            </section>
          );
        })}
      </div>

      {fullSyncWarnings?.length ? (
        <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">
          <p className="font-semibold">Sincronização concluída com avisos</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {fullSyncWarnings.map((warning) => (
              <li key={`${warning.scope}-${warning.correlationId}`}>
                <span className="font-semibold">{warning.label}:</span> {warning.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {showFullSyncModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Sincronização Completa ERP</h3>
            <p className="mt-3 text-sm text-slate-700">Toda a estrutura ERP será sincronizada novamente.<br />Deseja continuar?</p>
            <ul className="mt-4 grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
              {FULL_SYNC_STEPS.map((step) => (
                <li key={step.key} className="flex items-center gap-2"><span className={step.nonCritical ? "text-amber-500" : "text-emerald-600"}>{step.nonCritical ? "!" : "✓"}</span>{step.label}{step.nonCritical ? <span className="text-xs text-amber-700">(aviso)</span> : null}</li>
              ))}
            </ul>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50" onClick={() => setShowFullSyncModal(false)}>Cancelar</button>
              <button type="button" className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800" onClick={runFullSync}>Iniciar sincronização</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
