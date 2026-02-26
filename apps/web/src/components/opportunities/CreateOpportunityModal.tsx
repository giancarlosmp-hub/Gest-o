import { FormEvent, useEffect, useRef } from "react";

type Stage = "prospeccao" | "negociacao" | "proposta" | "ganho" | "perdido";

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

type ClientOption = { id: string; name: string };
type SellerOption = { id: string; name: string };

type CreateOpportunityModalProps = {
  open: boolean;
  title: string;
  form: FormState;
  clients: ClientOption[];
  sellers: SellerOption[];
  userRole?: string;
  userName?: string;
  isSaving: boolean;
  errorMessage: string | null;
  stages: Stage[];
  stageLabel: Record<Stage, string>;
  cropOptions: string[];
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onFormChange: (next: FormState) => void;
  sanitizeNumericInput: (value: string, allowDecimal?: boolean) => string;
};

export default function CreateOpportunityModal({
  open,
  title,
  form,
  clients,
  sellers,
  userRole,
  userName,
  isSaving,
  errorMessage,
  stages,
  stageLabel,
  cropOptions,
  onClose,
  onSubmit,
  onFormChange,
  sanitizeNumericInput
}: CreateOpportunityModalProps) {
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    titleInputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-0 sm:p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-full flex-col bg-white sm:h-auto sm:max-w-3xl sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 sm:px-6">
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          <button type="button" className="rounded-md border border-slate-200 px-3 py-1 text-sm text-slate-600" onClick={onClose}>
            Fechar
          </button>
        </div>

        <form onSubmit={onSubmit} className="flex h-full flex-col">
          <div className="grid flex-1 gap-2 overflow-y-auto p-4 sm:grid-cols-2 sm:p-6 lg:grid-cols-4">
            <input ref={titleInputRef} required className="rounded-lg border border-slate-200 p-2" placeholder="Título" value={form.title} onChange={(e) => onFormChange({ ...form, title: e.target.value })} />
            <select required className="rounded-lg border border-slate-200 p-2" value={form.clientId} onChange={(e) => onFormChange({ ...form, clientId: e.target.value })}>
              <option value="">Selecione cliente</option>
              {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
            </select>
            {userRole !== "vendedor" ? (
              <select required className="rounded-lg border border-slate-200 p-2" value={form.ownerSellerId} onChange={(e) => onFormChange({ ...form, ownerSellerId: e.target.value })}>
                <option value="">Selecione vendedor</option>
                {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
              </select>
            ) : <input disabled className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-slate-500" value={userName || ""} />}
            <select required className="rounded-lg border border-slate-200 p-2" value={form.stage} onChange={(e) => onFormChange({ ...form, stage: e.target.value as Stage })}>{stages.map((stage) => <option key={stage} value={stage}>{stageLabel[stage]}</option>)}</select>

            <input required inputMode="decimal" className="rounded-lg border border-slate-200 p-2" placeholder="Valor" value={form.value} onChange={(e) => onFormChange({ ...form, value: sanitizeNumericInput(e.target.value) })} />
            <input required inputMode="numeric" min={0} max={100} className="rounded-lg border border-slate-200 p-2" placeholder="Probabilidade %" value={form.probability} onChange={(e) => onFormChange({ ...form, probability: sanitizeNumericInput(e.target.value, false) })} />
            <input required type="date" className="rounded-lg border border-slate-200 p-2" value={form.proposalEntryDate} onChange={(e) => onFormChange({ ...form, proposalEntryDate: e.target.value })} />
            <input required type="date" className="rounded-lg border border-slate-200 p-2" value={form.expectedReturnDate} onChange={(e) => onFormChange({ ...form, expectedReturnDate: e.target.value })} />

            <select className="rounded-lg border border-slate-200 p-2" value={form.crop} onChange={(e) => onFormChange({ ...form, crop: e.target.value })}>
              <option value="">Cultura (opcional)</option>
              {cropOptions.map((crop) => <option key={crop} value={crop}>{crop}</option>)}
            </select>
            <input list="season-suggestions" className="rounded-lg border border-slate-200 p-2" placeholder="Safra (ex: 2025/26)" value={form.season} onChange={(e) => onFormChange({ ...form, season: e.target.value })} />
            <datalist id="season-suggestions">
              <option value="2024/25" />
              <option value="2025/26" />
              <option value="2026/27" />
            </datalist>
            <input inputMode="decimal" className="rounded-lg border border-slate-200 p-2" placeholder="Área (ha)" value={form.areaHa} onChange={(e) => onFormChange({ ...form, areaHa: sanitizeNumericInput(e.target.value) })} />
            <input className="rounded-lg border border-slate-200 p-2" placeholder="Produto ofertado" value={form.productOffered} onChange={(e) => onFormChange({ ...form, productOffered: e.target.value })} />
            <input type="date" className="rounded-lg border border-slate-200 p-2" value={form.plantingForecastDate} onChange={(e) => onFormChange({ ...form, plantingForecastDate: e.target.value })} />
            <input inputMode="decimal" className="rounded-lg border border-slate-200 p-2" placeholder="Ticket esperado/ha" value={form.expectedTicketPerHa} onChange={(e) => onFormChange({ ...form, expectedTicketPerHa: sanitizeNumericInput(e.target.value) })} />
            <input type="date" className="rounded-lg border border-slate-200 p-2" value={form.lastContactAt} onChange={(e) => onFormChange({ ...form, lastContactAt: e.target.value })} />
            <textarea className="rounded-lg border border-slate-200 p-2 sm:col-span-2 lg:col-span-4" placeholder="Notas" value={form.notes} onChange={(e) => onFormChange({ ...form, notes: e.target.value })} />
            {errorMessage ? <p className="text-sm text-red-600 sm:col-span-2 lg:col-span-4">{errorMessage}</p> : null}
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3 sm:px-6">
            <button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" disabled={isSaving} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-500">
              {isSaving ? "Salvando..." : "Salvar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
