import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import api from "../../lib/apiClient";
import {
  buildMergePayload,
  mergeConfirmMessage,
  mergeMatchLabel,
  type MergeClientSummary
} from "../../lib/clientMerge";
import ClientMergeComparison from "./ClientMergeComparison";

// "Mesclar duplicado" (diretor/gerente): sugere candidatos (mesmo documento ou nome + cidade/UF), permite buscar
// outro cadastro, mostra os dois lado a lado e pede qual fica.
type Props = {
  clientId: string;
  onClose: () => void;
  onMerged: (keptClientId: string) => void;
};

type CandidatesResponse = { current: MergeClientSummary; candidates: MergeClientSummary[] };

export default function ClientMergeDuplicateDialog({ clientId, onClose, onMerged }: Props) {
  const [current, setCurrent] = useState<MergeClientSummary | null>(null);
  const [candidates, setCandidates] = useState<MergeClientSummary[]>([]);
  const [searched, setSearched] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MergeClientSummary | null>(null);
  const [keepId, setKeepId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [merging, setMerging] = useState(false);

  const loadCandidates = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const response = await api.get<CandidatesResponse>(`/clients/${clientId}/merge-candidates`, { params: q ? { q } : {} });
      setCurrent(response.data.current);
      setCandidates(response.data.candidates || []);
      setSearched(q);
    } catch (error: any) {
      toast.error(error?.response?.data?.message || "Não foi possível carregar os cadastros para mesclar.");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void loadCandidates("");
  }, [loadCandidates]);

  const selectCandidate = (candidate: MergeClientSummary) => {
    setSelected(candidate);
    setKeepId(null);
  };

  const submitSearch = () => {
    const q = search.trim();
    if (q && q.length < 2) {
      toast.info("Digite ao menos 2 caracteres para buscar.");
      return;
    }
    setSelected(null);
    setKeepId(null);
    void loadCandidates(q);
  };

  const merge = async () => {
    if (!current || !selected || !keepId) return;
    const keep = keepId === current.id ? current : selected;
    const duplicate = keepId === current.id ? selected : current;
    if (!window.confirm(mergeConfirmMessage(keep, duplicate))) return;

    setMerging(true);
    try {
      await api.post("/clients/diagnostics/merge-duplicates", buildMergePayload(current.id, selected.id, keepId, reason));
      toast.success("Cadastros mesclados. O duplicado foi arquivado.");
      onMerged(keepId);
    } catch (error: any) {
      toast.error(error?.response?.data?.message || "Não foi possível mesclar os cadastros.");
    } finally {
      setMerging(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true" aria-labelledby="merge-duplicate-title">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white p-5 shadow-xl">
        <h3 id="merge-duplicate-title" className="text-lg font-semibold text-slate-900">Mesclar duplicado</h3>
        <p className="mt-1 text-sm text-slate-500">
          Escolha o outro cadastro da mesma pessoa ou empresa. O histórico vai para o cadastro que fica e o outro é arquivado.
        </p>

        <form
          className="mt-4 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submitSearch();
          }}
        >
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por nome, código ou documento"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-600"
            disabled={merging}
          />
          <button type="submit" disabled={loading || merging} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60">
            Buscar
          </button>
        </form>

        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {searched ? `Resultado da busca "${searched}"` : "Sugestões (mesmo documento ou mesmo nome e cidade/UF)"}
          </p>
          {loading ? (
            <p className="mt-2 text-sm text-slate-500">Carregando...</p>
          ) : candidates.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              {searched ? "Nenhum cadastro ativo encontrado." : "Nenhum possível duplicado sugerido. Use a busca."}
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {candidates.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    onClick={() => selectCandidate(candidate)}
                    disabled={merging}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${selected?.id === candidate.id ? "border-brand-600 bg-brand-50" : "border-slate-200 hover:bg-slate-50"}`}
                  >
                    <span className="block break-words font-medium text-slate-900">{candidate.name}</span>
                    <span className="block text-xs text-slate-500">
                      Código {candidate.code?.trim() || "sem código"} · {[candidate.city, candidate.state].filter(Boolean).join("/")}
                      {mergeMatchLabel(candidate.matchReasons) ? ` · ${mergeMatchLabel(candidate.matchReasons)}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {current && selected ? (
          <div className="mt-4 space-y-3">
            <ClientMergeComparison current={current} candidate={selected} keepId={keepId} onKeepChange={setKeepId} disabled={merging} />
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Motivo (opcional)</span>
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={300}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-600"
                disabled={merging}
              />
            </label>
          </div>
        ) : null}

        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={merging}
            className="inline-flex flex-1 items-center justify-center rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void merge()}
            disabled={!selected || !keepId || merging}
            className="inline-flex flex-1 items-center justify-center rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {merging ? "Mesclando..." : "Mesclar"}
          </button>
        </div>
      </div>
    </div>
  );
}
