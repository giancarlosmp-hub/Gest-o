import { useEffect, useState } from "react";
import api from "../../lib/apiClient";

type SyncScopeStatus = { status: string; lastSyncAt?: string; syncedCount?: number };
type SyncStatusResponse = { status: Record<string, SyncScopeStatus>; productCount: number; clientCount: number };

export default function ErpIntegrationPanel() {
  const [data, setData] = useState<SyncStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<"products" | "partners" | null>(null);

  const load = async () => {
    const response = await api.get<SyncStatusResponse>("/erp/ultrafv3/sync/status");
    setData(response.data);
  };

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const runSync = async (scope: "products" | "partners") => {
    setRunning(scope);
    try {
      await api.post(`/erp/ultrafv3/sync/${scope}`);
      await load();
    } finally {
      setRunning(null);
    }
  };

  if (loading || !data) return <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">Carregando integração ERP...</div>;

  const products = data.status.products;
  const partners = data.status.partners;

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-slate-900">Integração ERP</h3>
      <p className="text-xs text-slate-600">Status conexão: {products?.status === "error" || partners?.status === "error" ? "Com erro" : "Conectado"}</p>
      <p className="text-xs text-slate-600">Última sincronização: {products?.lastSyncAt || partners?.lastSyncAt || "Nunca"}</p>
      <p className="text-xs text-slate-600">Quantidade produtos: {data.productCount}</p>
      <p className="text-xs text-slate-600">Quantidade clientes: {data.clientCount}</p>
      <div className="flex gap-2">
        <button className="rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white" disabled={running !== null} onClick={() => runSync("products")}>
          {running === "products" ? "Sincronizando..." : "Sincronizar produtos"}
        </button>
        <button className="rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white" disabled={running !== null} onClick={() => runSync("partners")}>
          {running === "partners" ? "Sincronizando..." : "Sincronizar clientes"}
        </button>
      </div>
    </div>
  );
}
