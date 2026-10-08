type DeleteOpportunityConfirmModalProps = {
  opportunityTitle?: string;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

// Exclusão é exclusiva de diretor/gerente (a API é a proteção real) e sempre passa por esta confirmação.
export default function DeleteOpportunityConfirmModal({ opportunityTitle, deleting, onCancel, onConfirm }: DeleteOpportunityConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4" onClick={deleting ? undefined : onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-opportunity-title"
        className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <h4 id="delete-opportunity-title" className="text-lg font-semibold text-slate-900">Excluir esta oportunidade?</h4>
        {opportunityTitle ? <p className="text-sm font-medium text-slate-800">{opportunityTitle}</p> : null}
        <p className="text-sm text-slate-600">Esta ação não pode ser desfeita.</p>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={deleting} className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50" onClick={onCancel}>Cancelar</button>
          <button type="button" disabled={deleting} className="rounded-lg bg-red-600 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:bg-red-300" onClick={onConfirm}>
            {deleting ? "Excluindo..." : "Excluir"}
          </button>
        </div>
      </div>
    </div>
  );
}
