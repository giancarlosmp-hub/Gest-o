import { useEffect, useState } from "react";
import api from "../lib/apiClient";
import { Line, Doughnut } from "react-chartjs-2";
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, ArcElement, Tooltip, Legend } from "chart.js";
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ArcElement, Tooltip, Legend);

export default function DashboardPage() {
  const [summary, setSummary] = useState<any>(null);
  const [series, setSeries] = useState<any>(null);

  useEffect(() => {
    const month = new Date().toISOString().slice(0, 7);
    Promise.all([api.get(`/dashboard/summary?month=${month}`), api.get(`/dashboard/sales-series?month=${month}`)]).then(([s, ss]) => { setSummary(s.data); setSeries(ss.data); });
  }, []);

  if (!summary || !series) return <div>Carregando dashboard...</div>;

  return <div className="space-y-4">
    <div className="grid md:grid-cols-4 gap-3">
      {[
        ["Faturamento total", `R$ ${summary.totalRevenue.toFixed(2)}`],
        ["Vendas realizadas", summary.totalSales],
        ["Novos leads", summary.newLeads],
        ["Taxa conversão", `${summary.conversionRate.toFixed(1)}%`]
      ].map(([k, v]) => <div key={String(k)} className="bg-white rounded-xl p-4 shadow"><div className="text-sm text-slate-500">{k}</div><div className="text-2xl font-bold">{v}</div></div>)}
    </div>

    <div className="grid lg:grid-cols-2 gap-4">
      <div className="bg-white p-4 rounded-xl shadow"><h3 className="font-semibold mb-2">Evolução diária</h3><Line data={{ labels: series.labels, datasets: [{ label: "Meta acumulada", data: series.target, borderColor: "#1d4ed8" }, { label: "Realizado acumulado", data: series.real, borderColor: "#16a34a" }] }}/></div>
      <div className="bg-white p-4 rounded-xl shadow"><h3 className="font-semibold mb-2">Metas vs Realizado</h3><Doughnut data={{ labels: ["Realizado", "Restante"], datasets: [{ data: [series.realizedTotal, Math.max(0, series.goalTotal - series.realizedTotal)], backgroundColor: ["#2563eb", "#cbd5e1"] }] }}/></div>
    </div>

    <div className="bg-white rounded-xl p-4 shadow">
      <h3 className="font-semibold mb-2">Performance da Equipe</h3>
      <table className="w-full text-sm"><thead><tr className="text-left border-b"><th>Vendedor</th><th>Vendas</th><th>Faturamento</th><th>Meta%</th></tr></thead><tbody>{summary.performance.map((p: any, idx: number) => <tr key={p.sellerId} className="border-b"><td>{idx===0?"🥇":idx===1?"🥈":idx===2?"🥉":""} {p.seller}</td><td>{p.sales}</td><td>R$ {p.revenue.toFixed(2)}</td><td><div className="bg-slate-200 h-2 rounded"><div className="bg-blue-600 h-2 rounded" style={{ width: `${Math.min(100,p.percent)}%` }} /></div> {p.percent.toFixed(1)}%</td></tr>)}</tbody></table>
    </div>

    <div className="bg-white rounded-xl p-4 shadow"><h3 className="font-semibold mb-2">Atividades recentes</h3><ul className="space-y-1">{summary.recentActivities.map((a: any) => <li key={a.id}>• {a.type} - {a.notes} ({a.done ? "Concluída" : "Pendente"})</li>)}</ul></div>
  </div>;
}
