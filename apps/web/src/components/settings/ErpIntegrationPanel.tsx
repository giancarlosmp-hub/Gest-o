import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import api from "../../lib/apiClient";
import { getApiErrorMessage } from "../../lib/apiError";

type SyncScopeKey =
  | "connection"
  | "products"
  | "partners"
  | "salesmen"
  | "paymentMethods"
  | "receivingConditions"
  | "priceTables"
  | "branches"
  | "operations";

type SyncScopeStatus = {
  scope?: SyncScopeKey;
  status: "idle" | "running" | "success" | "error" | string;
  lastSyncAt?: string;
  syncedCount?: number;
  errors?: string[];
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
  guidance: string;
};

type OperationalSummary = {
  sentOrders: number;
  pendingOrders: number;
  errorOrders: number;
  syncedOrders: number;
  lastOrderActivityAt?: string | null;
};

type SyncStatusResponse = {
  status: Record<SyncScopeKey, SyncScopeStatus>;
  integration?: IntegrationDiagnostics;
  operational?: OperationalSummary;
  productCount: number;
  clientCount: number;
};

type SyncCardConfig = {
  key: SyncScopeKey;
  title: string;
  endpoint: string;
  countLabel?: string;
  description: string;
};

const SYNC_CARDS: SyncCardConfig[] = [
  { key: "connection", title: "Conexão UltraFV3", endpoint: "connection", description: "Valida credenciais, autenticação e disponibilidade do UltraFV3." },
  { key: "products", title: "Produtos", endpoint: "products", countLabel: "Produtos válidos", description: "Importa somente produtos ativos, não suspensos, com código ERP, unidade e preço maior que zero." },
  { key: "partners", title: "Clientes/parceiros", endpoint: "partners", countLabel: "Clientes", description: "Atualiza código ERP, nome, cidade, UF e CNPJ/CPF quando disponíveis." },
  { key: "salesmen", title: "Vendedores", endpoint: "salesmen", description: "Persiste o catálogo de vendedores com código ERP para vínculo com usuários CRM." },
  { key: "paymentMethods", title: "Formas de pagamento", endpoint: "payment-methods", description: "Sincroniza formas de pagamento disponíveis para emissão de pedidos." },
  { key: "receivingConditions", title: "Condições de pagamento", endpoint: "receiving-conditions", description: "Sincroniza condições comerciais de recebimento retornadas pelo UltraFV3." },
  { key: "priceTables", title: "Tabelas de preço", endpoint: "price-tables", description: "Sincroniza tabelas de preço oficiais do UltraFV3." },
  { key: "branches", title: "Filiais", endpoint: "branches", description: "Sincroniza filiais disponíveis para operação comercial." },
  { key: "operations", title: "Operações", endpoint: "operations", description: "Sincroniza operações fiscais/comerciais exigidas no pedido ERP." },
];

const statusLabel: Record<string, string> = {
  idle: "Nunca sincronizado",
  running: "Sincronizando",
  success: "Sincronizado",
  error: "Com erro",
};

const statusClasses: Record<string, string> = {
  idle: "bg-slate-100 text-slate-700 ring-slate-200",
  running: "bg-amber-50 text-amber-700 ring-amber-200",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  error: "bg-red-50 text-red-700 ring-red-200",
};

const formatDate = (value?: string) => {
  if (!value) return "Nunca";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
};

const latestError = (status?: SyncScopeStatus) => status?.errors?.[0] || "Nenhum erro registrado.";

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
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<SyncScopeKey | null>(null);

  const load = async () => {
    const response = await api.get<SyncStatusResponse>("/erp/ultrafv3/sync/status");
    setData(response.data);
  };

  useEffect(() => {
    load()
      .catch((error) => toast.error(getApiErrorMessage(error, "Não foi possível carregar status da integração ERP.")))
      .finally(() => setLoading(false));
  }, []);

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

  const summary = useMemo(() => {
    const statuses = data ? Object.values(data.status) : [];
    const errors = statuses.filter((item) => item?.status === "error").length;
    const runningCount = statuses.filter((item) => item?.status === "running").length;
    return { errors, runningCount };
  }, [data]);

  if (loading) return <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">Carregando integração ERP...</div>;

  const integration = data?.integration;
  const integrationClasses = integrationStatusClasses[integration?.authenticationStatus || "not_authenticated"] || integrationStatusClasses.not_authenticated;
  const missingConfig = integration?.missingConfig ?? [];

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
                disabled={running !== null || isRunning || integration?.isConfigured === false}
                onClick={() => runSync(card)}
              >
                {isRunning ? "Sincronizando..." : "Sincronizar"}
              </button>
            </section>
          );
        })}
      </div>
    </div>
  );
}
