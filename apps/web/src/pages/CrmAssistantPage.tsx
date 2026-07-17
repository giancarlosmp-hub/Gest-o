import { useMemo, useState } from "react";
import { Bot, Filter, Loader2, MessageSquarePlus, Send, Sparkles } from "lucide-react";
import api from "../lib/apiClient";
import { useAuth } from "../context/AuthContext";

type AssistantResult = { entityType: string; entityId: string; title: string; subtitle?: string; score?: number; reason?: string; action?: { label: string; path: string } };
type AssistantResponse = { answer: string; intent: string; filtersApplied?: Array<{ field: string; operator: string; value: string | number | null }>; summary?: { totalResults?: number; totalValue?: number; ordering?: string }; results?: AssistantResult[]; warnings?: string[]; source: "ai" | "deterministic"; generatedAt: string };
type Message = { id: string; question: string; response: AssistantResponse };

const sellerSuggestions = ["Quem devo atender hoje?", "Quais clientes estão sem comprar?", "Quais follow-ups estão vencidos?", "Como está meu planejamento da semana?", "Quais oportunidades estão mais próximas de fechar?"];
const managerSuggestions = ["Quais vendedores têm mais follow-ups vencidos?", "Qual o valor de pipeline por vendedor?", "Quais clientes acima de R$ 100 mil estão esfriando?", "Quais cidades estão sem atividade recente?"];

export default function CrmAssistantPage() {
  const { user } = useAuth();
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const suggestions = useMemo(() => user?.role === "vendedor" ? sellerSuggestions : [...sellerSuggestions.slice(0, 3), ...managerSuggestions.slice(0, 2)], [user?.role]);

  async function ask(text = question) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    setLoading(true); setError("");
    try {
      const { data } = await api.post<AssistantResponse>("/ai/crm-assistant/query", { question: trimmed });
      setMessages((items) => [{ id: crypto.randomUUID(), question: trimmed, response: data }, ...items].slice(0, 5));
      setQuestion("");
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || "Não consegui consultar o assistente comercial.");
    } finally { setLoading(false); }
  }

  return <div className="mx-auto flex min-h-[calc(100vh-80px)] max-w-6xl flex-col gap-4 p-4 pb-28 md:grid md:grid-cols-[minmax(0,1fr)_320px] md:p-6 md:pb-6">
    <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 p-5">
        <div className="flex items-center gap-3"><div className="rounded-2xl bg-brand-50 p-3 text-brand-700"><Bot /></div><div><p className="text-xs font-semibold uppercase tracking-wide text-brand-700">CRM Assistant</p><h1 className="text-2xl font-bold text-slate-900">Assistente Comercial</h1><p className="text-sm text-slate-600">Consulta e análise com dados reais, escopo do usuário e catálogo seguro de perguntas.</p></div></div>
      </div>
      <div className="space-y-4 p-5">
        <div className="rounded-2xl bg-slate-50 p-4"><p className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><Sparkles size={16} /> Sugestões iniciais</p><div className="flex flex-wrap gap-2">{suggestions.map(s => <button key={s} onClick={() => ask(s)} className="rounded-full border border-brand-100 bg-white px-3 py-2 text-sm text-brand-800 hover:bg-brand-50">{s}</button>)}</div></div>
        {messages.length === 0 && <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-slate-500"><MessageSquarePlus className="mx-auto mb-2" /> Faça uma pergunta comercial para ver respostas, filtros e cards de resultado.</div>}
        {messages.map(({ id, question, response }) => <article key={id} className="rounded-2xl border border-slate-200 p-4">
          <p className="mb-3 text-sm font-semibold text-slate-900">Você: {question}</p><p className="whitespace-pre-wrap text-slate-800">{response.answer}</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">{(response.results || []).map(r => <div key={`${r.entityType}-${r.entityId}`} className="rounded-2xl border border-slate-100 bg-slate-50 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-slate-900">{r.title}</p><p className="text-sm text-slate-600">{r.subtitle}</p></div>{typeof r.score === "number" && <span className="rounded-full bg-brand-100 px-2 py-1 text-xs font-bold text-brand-800">{r.score}</span>}</div>{r.reason && <p className="mt-2 text-sm text-slate-600">{r.reason}</p>}{r.action && <a className="mt-3 inline-flex rounded-lg bg-brand-700 px-3 py-2 text-sm font-semibold text-white" href={r.action.path}>{r.action.label}</a>}</div>)}</div>
          {(response.warnings || []).length > 0 && <ul className="mt-3 list-disc pl-5 text-xs text-amber-700">{(response.warnings || []).map(w => <li key={w}>{w}</li>)}</ul>}
        </article>)}
        {error && <div className="rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      </div>
    </section>
    <aside className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:sticky md:top-6 md:self-start"><p className="mb-3 flex items-center gap-2 font-semibold text-slate-900"><Filter size={18} /> Evidências</p>{messages[0] ? <div className="space-y-4 text-sm"><div><p className="text-slate-500">Intent</p><p className="font-semibold text-slate-900">{messages[0].response.intent}</p></div><div><p className="text-slate-500">Resultados</p><p className="font-semibold text-slate-900">{messages[0].response.summary?.totalResults ?? 0}</p></div><div><p className="text-slate-500">Filtros aplicados</p><div className="mt-2 flex flex-wrap gap-2">{(messages[0].response.filtersApplied || []).map(f => <span key={`${f.field}-${f.value}`} className="rounded-full bg-slate-100 px-2 py-1 text-xs">{f.field} {f.operator} {String(f.value)}</span>)}</div></div><p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">Fonte: {messages[0].response.source}. Não há escrita no banco nem execução de SQL livre.</p></div> : <p className="text-sm text-slate-500">Os critérios aparecerão aqui depois da primeira consulta.</p>}</aside>
    <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white p-3 md:static md:col-span-2 md:rounded-3xl md:border md:p-4"><div className="mx-auto flex max-w-6xl gap-2"><input value={question} onChange={e => setQuestion(e.target.value)} maxLength={700} placeholder="Pergunte sobre clientes, oportunidades, agenda ou campanha..." className="min-h-12 flex-1 rounded-2xl border border-slate-200 px-4 outline-none focus:border-brand-500" /><button disabled={loading} className="inline-flex min-h-12 items-center gap-2 rounded-2xl bg-brand-700 px-4 font-semibold text-white disabled:opacity-60">{loading ? <Loader2 className="animate-spin" /> : <Send size={18} />} Enviar</button><button type="button" onClick={() => { setMessages([]); setError(""); }} className="hidden rounded-2xl border border-slate-200 px-4 font-semibold text-slate-700 sm:block">Nova conversa</button></div></form>
  </div>;
}
