import { useState } from "react";
import { AlertTriangle, Loader2, Plus, RotateCcw, Search, Sparkles, Trash2 } from "lucide-react";
import api from "../../lib/apiClient";
import ClientSelect from "../ClientSelect";
import { formatCurrencyBRL } from "../../lib/formatters";
import {
  addDraftItem,
  canCreateDraft,
  draftActiveWarnings,
  draftPendingFields,
  draftValue,
  DRAFT_STAGE_LABELS,
  DRAFT_STAGES,
  isDraftCreated,
  isDraftExpired,
  isItemLocked,
  itemActiveWarnings,
  itemPriceDiffPercent,
  itemTotal,
  productSearchUrl,
  readProductSearchResults,
  removeDraftItem,
  selectClientCandidate,
  selectProductCandidate,
  selectSearchedClient,
  selectSearchedProduct,
  setDraftField,
  setDraftOwner,
  setDraftProbability,
  setDraftStage,
  setItemField,
  type DraftCardItem,
  type DraftStage,
  type OpportunityDraftCard as DraftCard,
  type ProductSearchResult
} from "../../lib/opportunityDraft";

type SellerOption = { id: string; name: string };

type Props = {
  card: DraftCard;
  sellers: SellerOption[];
  confirming: boolean;
  onChange: (card: DraftCard) => void;
  onConfirm: () => void;
  onReinterpret: () => void;
  onDiscard: () => void;
};

const inputClass = "min-h-11 w-full min-w-0 rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-brand-500 disabled:bg-slate-50 disabled:text-slate-500";
const labelClass = "text-xs font-semibold text-slate-600";
const chipClass = (selected: boolean) =>
  `w-full rounded-xl border px-3 py-2 text-left text-sm ${selected ? "border-brand-600 bg-brand-50 text-brand-900" : "border-slate-200 bg-white text-slate-800 hover:bg-slate-50"}`;
const formatDiff = (diff: number) => `${diff > 0 ? "+" : ""}${diff.toLocaleString("pt-BR")}%`;

function ItemEditor({ card, item, index, onChange }: { card: DraftCard; item: DraftCardItem; index: number; onChange: (card: DraftCard) => void }) {
  const [query, setQuery] = useState(item.spokenName);
  const [results, setResults] = useState<ProductSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const locked = isItemLocked(item);
  const diff = itemPriceDiffPercent(item);
  const total = itemTotal(item);
  const warnings = itemActiveWarnings(item);

  async function search() {
    const url = productSearchUrl(card, query);
    if (!url || searching) return;
    setSearching(true); setSearchError("");
    try {
      const { data } = await api.get(url);
      setResults(readProductSearchResults(data));
    } catch {
      setResults(null);
      setSearchError("Não foi possível buscar produtos agora.");
    } finally { setSearching(false); }
  }

  return <div className={`space-y-3 rounded-2xl border p-3 ${item.error ? "border-red-200 bg-red-50/40" : "border-slate-200"}`}>
    <div className="flex items-start justify-between gap-2">
      <div>
        <p className="text-sm font-semibold text-slate-900">Item {index + 1}{item.spokenName ? `: "${item.spokenName}"` : ""}</p>
        {locked && <p className="text-xs font-semibold text-emerald-700">Item salvo na oportunidade.</p>}
      </div>
      {!isDraftCreated(card) && <button type="button" onClick={() => onChange(removeDraftItem(card, item.key))} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-red-700 hover:bg-red-50"><Trash2 size={14} /> Remover</button>}
    </div>
    {item.error && <p className="rounded-xl bg-red-50 p-2 text-sm text-red-700">{item.error}</p>}
    {warnings.map((warning) => <p key={warning.code + warning.field} className="flex gap-2 text-xs text-amber-800"><AlertTriangle size={14} className="shrink-0" /> {warning.message}</p>)}

    {!locked && <div className="space-y-2">
      <p className={labelClass}>Produto</p>
      {item.candidates.length > 0 && <div className="grid gap-2">{item.candidates.map((candidate) => <button key={candidate.productId} type="button" onClick={() => onChange(selectProductCandidate(card, item.key, candidate.productId))} className={chipClass(item.product?.productId === candidate.productId)}>
        <span className="block font-medium">{candidate.name}</span>
        <span className="block text-xs text-slate-500">{[candidate.brand, candidate.unit].filter(Boolean).join(" · ")} · {formatCurrencyBRL(candidate.tablePrice)} na {card.priceTable.label}</span>
      </button>)}</div>}
      <div className="flex gap-2">
        <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); search(); } }} maxLength={120} placeholder={item.candidates.length ? "Nenhum serve? Buscar outro produto" : "Buscar produto"} className={inputClass} />
        <button type="button" onClick={search} disabled={searching || !query.trim()} className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-xl border border-slate-200 px-3 text-sm font-semibold text-slate-700 disabled:opacity-60">{searching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />} Buscar</button>
      </div>
      {searchError && <p className="text-xs text-red-700">{searchError}</p>}
      {results && (results.length ? <div className="grid max-h-60 gap-2 overflow-auto">{results.map((result) => <button key={result.id} type="button" onClick={() => { onChange(selectSearchedProduct(card, item.key, result)); setResults(null); }} className={chipClass(item.product?.productId === result.id)}>
        <span className="block font-medium">{result.name}</span>
        <span className="block text-xs text-slate-500">{[result.brand, result.unit].filter(Boolean).join(" · ")} · {formatCurrencyBRL(Number(result.price))} na {card.priceTable.label}</span>
      </button>)}</div> : <p className="text-xs text-slate-500">Nenhum produto com preço válido na {card.priceTable.label}.</p>)}
    </div>}
    {item.product && <p className="text-sm text-slate-800">Escolhido: <span className="font-semibold">{item.product.name}</span> · tabela {formatCurrencyBRL(item.product.tablePrice)}</p>}

    <div className="grid grid-cols-2 gap-2">
      <label className="space-y-1"><span className={labelClass}>Quantidade (sacas)</span><input inputMode="decimal" value={item.quantity} disabled={locked} onChange={(event) => onChange(setItemField(card, item.key, "quantity", event.target.value))} className={inputClass} /></label>
      <label className="space-y-1"><span className={labelClass}>Preço</span><select value={item.priceMode} disabled={locked} onChange={(event) => onChange(setItemField(card, item.key, "priceMode", event.target.value as DraftCardItem["priceMode"]))} className={inputClass}><option value="registered">Cadastrado</option><option value="informed">Informado</option></select></label>
    </div>
    {item.priceMode === "informed" && <label className="block space-y-1"><span className={labelClass}>Preço informado por saca (R$)</span><input inputMode="decimal" value={item.informedPrice} disabled={locked} onChange={(event) => onChange(setItemField(card, item.key, "informedPrice", event.target.value))} className={inputClass} /></label>}
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {diff !== null && <span className={diff < 0 ? "font-semibold text-amber-700" : "font-semibold text-slate-700"}>Diferença da tabela: {formatDiff(diff)}</span>}
      {total !== null && <span className="text-slate-700">Total: {formatCurrencyBRL(total)}</span>}
    </div>
  </div>;
}

export default function OpportunityDraftCard({ card, sellers, confirming, onChange, onConfirm, onReinterpret, onDiscard }: Props) {
  const created = isDraftCreated(card);
  const expired = !created && isDraftExpired(card);
  const pending = draftPendingFields(card);
  const warnings = draftActiveWarnings(card);
  const value = draftValue(card);
  const canCreate = canCreateDraft(card) && !confirming;
  const selectedClientId = card.client.selected?.id ?? "";

  return <article className="space-y-4 rounded-2xl border border-brand-100 bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="font-semibold text-slate-900">Rascunho da oportunidade</p>
      <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">{card.priceTable.label}</span>
    </div>
    <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700">"{card.text}"</p>
    {expired && <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Rascunho vencido (mais de 7 dias). Descarte ou use "Interpretar de novo".</p>}
    {created && <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Oportunidade já criada. Só os itens pendentes podem ser alterados e enviados de novo.</p>}
    {card.lastError && <p className="rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-red-700">{card.lastError}</p>}
    {warnings.length > 0 && <ul className="space-y-1">{warnings.map((warning) => <li key={warning.code + warning.field} className="flex gap-2 text-sm text-amber-800"><AlertTriangle size={16} className="shrink-0" /> {warning.message}</li>)}</ul>}

    <section className="space-y-2">
      <p className={labelClass}>Cliente</p>
      {card.client.candidates.length > 0 && <div className="grid gap-2">{card.client.candidates.map((candidate) => <button key={candidate.id} type="button" disabled={created} onClick={() => onChange(selectClientCandidate(card, candidate.id))} className={chipClass(selectedClientId === candidate.id)}>
        <span className="block font-medium">{candidate.name}</span>
        <span className="block text-xs text-slate-500">{[candidate.fantasyName, [candidate.city, candidate.state].filter(Boolean).join("/")].filter(Boolean).join(" · ") || "Cidade não informada"}{candidate.suggestedOwner ? ` · ${candidate.suggestedOwner.name}` : ""}</span>
      </button>)}</div>}
      {!created && <div className="space-y-1">
        <p className="text-xs text-slate-500">{card.client.candidates.length ? "Não é nenhum desses? Busque na carteira:" : "Busque o cliente na carteira:"}</p>
        <ClientSelect value={card.client.selected?.source === "search" ? selectedClientId : undefined} onChange={(client) => { if (client || card.client.selected?.source === "search") onChange(selectSearchedClient(card, client)); }} />
      </div>}
      {card.client.selected && <p className="text-sm text-slate-800">Escolhido: <span className="font-semibold">{card.client.selected.name}</span></p>}
    </section>

    <label className="block space-y-1"><span className={labelClass}>Responsável</span>
      {card.owner.mode === "self"
        ? <input value="Você" disabled className={inputClass} />
        : <select value={card.owner.sellerId} disabled={created} onChange={(event) => onChange(setDraftOwner(card, sellers.find((seller) => seller.id === event.target.value) ?? null))} className={inputClass}>
          <option value="">Escolha o vendedor</option>
          {card.owner.sellerId && !sellers.some((seller) => card.owner.mode === "pick" && seller.id === card.owner.sellerId) && <option value={card.owner.sellerId}>{card.owner.sellerName}</option>}
          {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
        </select>}
    </label>

    <section className="space-y-3">
      <p className={labelClass}>Itens</p>
      {card.items.map((item, index) => <ItemEditor key={item.key} card={card} item={item} index={index} onChange={onChange} />)}
      {!created && <button type="button" onClick={() => onChange(addDraftItem(card))} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-dashed border-slate-300 px-3 text-sm font-semibold text-slate-700"><Plus size={16} /> Adicionar item</button>}
    </section>

    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 sm:col-span-2"><span className={labelClass}>Título</span><input value={card.title} disabled={created} maxLength={200} onChange={(event) => onChange(setDraftField(card, "title", event.target.value))} className={inputClass} /></label>
      <label className="space-y-1"><span className={labelClass}>Etapa</span><select value={card.stage} disabled={created} onChange={(event) => onChange(setDraftStage(card, event.target.value as DraftStage))} className={inputClass}>{DRAFT_STAGES.map((stage) => <option key={stage} value={stage}>{DRAFT_STAGE_LABELS[stage]}</option>)}</select></label>
      <label className="space-y-1"><span className={labelClass}>Probabilidade (%)</span><input inputMode="numeric" value={card.probability} disabled={created} onChange={(event) => onChange(setDraftProbability(card, event.target.value))} className={inputClass} /></label>
      {card.items.length === 0
        ? <label className="space-y-1 sm:col-span-2"><span className={labelClass}>Valor (R$)</span><input inputMode="decimal" value={card.value} disabled={created} onChange={(event) => onChange(setDraftField(card, "value", event.target.value))} className={inputClass} /></label>
        : <p className="text-sm text-slate-700 sm:col-span-2">Valor pela soma dos itens: <span className="font-semibold">{value !== null ? formatCurrencyBRL(value) : "a definir"}</span></p>}
      <label className="space-y-1"><span className={labelClass}>Entrada</span><input type="date" value={card.proposalDate} disabled={created} onChange={(event) => onChange(setDraftField(card, "proposalDate", event.target.value))} className={inputClass} /></label>
      <label className="space-y-1"><span className={`${labelClass} flex flex-wrap items-center gap-2`}>Retorno {card.followUpSuggestedByAi && <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-800"><Sparkles size={12} /> sugerida pela IA</span>}</span><input type="date" value={card.followUpDate} disabled={created} onChange={(event) => onChange(setDraftField(card, "followUpDate", event.target.value))} className={inputClass} /></label>
      <label className="space-y-1"><span className={labelClass}>Fechamento previsto</span><input type="date" value={card.expectedCloseDate} disabled={created} onChange={(event) => onChange(setDraftField(card, "expectedCloseDate", event.target.value))} className={inputClass} /></label>
      <label className="space-y-1 sm:col-span-2"><span className={labelClass}>Notas</span><textarea value={card.notes} disabled={created} maxLength={2000} rows={3} onChange={(event) => onChange(setDraftField(card, "notes", event.target.value))} className={`${inputClass} py-2`} /></label>
    </div>

    {pending.length > 0 && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
      <p className="text-sm font-semibold text-amber-900">Falta para criar</p>
      <ul className="mt-1 list-disc pl-5 text-sm text-amber-800">{pending.map((item) => <li key={item.field}>{item.message}</li>)}</ul>
    </div>}

    <div className="flex flex-col gap-2 sm:flex-row">
      <button type="button" onClick={onConfirm} disabled={!canCreate} className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-2xl bg-brand-700 px-4 font-semibold text-white disabled:opacity-60">{confirming && <Loader2 size={18} className="animate-spin" />}{created ? "Tentar de novo" : "Criar oportunidade"}</button>
      {!created && <button type="button" onClick={onReinterpret} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-slate-200 px-4 font-semibold text-slate-700"><RotateCcw size={16} /> Interpretar de novo</button>}
      <button type="button" onClick={onDiscard} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-red-100 px-4 font-semibold text-red-700"><Trash2 size={16} /> Descartar</button>
    </div>
  </article>;
}
