import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import {
  clearVisitDraft,
  formatVisitDraftStart,
  loadVisitDraft,
  VISIT_DRAFT_CHANGE_EVENT,
  VISIT_DRAFT_RESUME_PARAM,
  type VisitDraft
} from "../../lib/visitDraft";

// Aviso de visita em andamento em qualquer tela do CRM: Continuar reabre a Nova atividade com o rascunho.
export default function VisitDraftBanner() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<VisitDraft | null>(() => loadVisitDraft(user?.id));

  useEffect(() => {
    const refresh = () => setDraft(loadVisitDraft(user?.id));
    refresh();
    window.addEventListener(VISIT_DRAFT_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(VISIT_DRAFT_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [user?.id]);

  if (!draft) return null;

  return (
    <div role="status" className="mb-4 flex flex-col gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 sm:flex-row sm:items-center sm:justify-between">
      <p className="min-w-0 font-medium">Visita em andamento desde {formatVisitDraftStart(draft)}</p>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          className="flex-1 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800 sm:flex-none"
          onClick={() => navigate(`/atividades?${VISIT_DRAFT_RESUME_PARAM}=1`)}
        >
          Continuar
        </button>
        <button
          type="button"
          className="flex-1 rounded-lg border border-emerald-300 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 sm:flex-none"
          onClick={() => clearVisitDraft(user?.id)}
        >
          Descartar
        </button>
      </div>
    </div>
  );
}
