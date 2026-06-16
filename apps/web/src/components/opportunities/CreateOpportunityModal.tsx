import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { ExistingClientSummary } from "../../lib/clientDuplicateCheck";
import ClientSearchSelect from "../clients/ClientSearchSelect";
import QuickCreateClientSection from "../clients/QuickCreateClientSection";

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
  priceTableCode: string;
};

type ClientOption = {
  id: string;
  name: string;
  city?: string | null;
  state?: string | null;
  cnpj?: string | null;
  overdueTitlesTotal?: number | null;
};
type SellerOption = { id: string; name: string };
type PriceTableOption = { code: string; label: string };

type CreateOpportunityModalProps = {
  open: boolean;
  title: string;
  submitLabel: string;
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
  ownerSellerId?: string;
  requireOwnerSeller?: boolean;
  onClientCreated: (client: ClientOption) => void;
  onSelectExisting: (client: ExistingClientSummary) => void;
  productsSection?: ReactNode;
  hasStructuredItems?: boolean;
  priceTableOptions?: PriceTableOption[];
  priceTableWarning?: string;
  shouldConfirmClose?: boolean;
  onRefreshClients?: () => Promise<void> | void;
  isRefreshingClients?: boolean;
};

export default function CreateOpportunityModal({
  open,
  title,
  submitLabel,
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
  sanitizeNumericInput,
  ownerSellerId,
  requireOwnerSeller = false,
  onClientCreated,
  onSelectExisting,
  productsSection,
  hasStructuredItems = false,
  priceTableOptions = [],
  priceTableWarning = "",
  shouldConfirmClose = false,
  onRefreshClients,
  isRefreshingClients = false
}: CreateOpportunityModalProps) {
  const fieldClassName = "w-full rounded-lg border border-slate-200 p-2";
  const labelClassName = "text-sm font-medium text-slate-700";
  const helpClassName = "text-xs text-slate-500";

  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [showCancelConfirmation, setShowCancelConfirmation] = useState(false);

  const requestClose = () => {
    if (shouldConfirmClose) {
      setShowCancelConfirmation(true);
      return;
    }
    onClose();
  };

  const discardChanges = () => {
    setShowCancelConfirmation(false);
    onClose();
  };

  useEffect(() => {
    if (!open) {
      setShowCancelConfirmation(false);
      return;
    }
    titleInputRef.current?.focus();
  }, [open]);

  const selectedClient = clients.find((client) => client.id === form.clientId) || null;
  const overdueTitlesTotal = selectedClient?.overdueTitlesTotal || 0;

  if (!open) return null;

  return (
    <div className="mobile-modal-shell" role="dialog" aria-modal="true" onClick={requestClose}>
      <div
        className="mobile-modal-panel relative h-full max-w-full sm:max-w-3xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          <button type="button" className="rounded-md border border-slate-200 px-3 py-1 text-sm text-slate-600" onClick={requestClose}>
            Fechar
          </button>
        </div>

        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="mobile-modal-body space-y-6 overscroll-contain pb-24">
            <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
              <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Identificação</h4>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className={labelClassName}>Título *</span>
                  <input ref={titleInputRef} required className={fieldClassName} placeholder="Ex: Oportunidade Milho Safra 25/26 – Cliente X" value={form.title} onChange={(e) => onFormChange({ ...form, title: e.target.value })} />
                </label>
                <div className="space-y-2">
                  {onRefreshClients ? (
                    <div className="flex items-center justify-between gap-2">
                      <span className={labelClassName}>Cliente *</span>
                      <button
                        type="button"
                        className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={() => onRefreshClients()}
                        disabled={isRefreshingClients}
                      >
                        {isRefreshingClients ? "Atualizando clientes..." : "Atualizar clientes"}
                      </button>
                    </div>
                  ) : null}
                  <label className="space-y-1">
                    {!onRefreshClients ? <span className={labelClassName}>Cliente *</span> : null}
                    <ClientSearchSelect
                      clients={clients}
                      value={form.clientId}
                      onChange={(clientId) => onFormChange({ ...form, clientId })}
                      required
                      emptyLabel="Nenhum cliente encontrado."
                      className={fieldClassName}
                    />
                  </label>
                  {overdueTitlesTotal > 0 ? (
                    <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
                      ⚠️ Cliente com {new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(overdueTitlesTotal)} em títulos vencidos.
                    </p>
                  ) : null}
                  <QuickCreateClientSection
                    open={open}
                    fieldClassName={fieldClassName}
                    ownerSellerId={ownerSellerId}
                    requireOwnerSeller={requireOwnerSeller}
                    onClientCreated={onClientCreated}
                    onSelectExisting={onSelectExisting}
                  />
                </div>
                <label className="space-y-1">
                  <span className={labelClassName}>Vendedor responsável *</span>
                  {userRole !== "vendedor" ? (
                    <select required className={fieldClassName} value={form.ownerSellerId} onChange={(e) => onFormChange({ ...form, ownerSellerId: e.target.value })}>
                      <option value="">Selecione o vendedor</option>
                      {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
                    </select>
                  ) : <input disabled className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-slate-500" value={userName || ""} />}
                </label>
                <label className="space-y-1">
                  <span className={labelClassName}>Etapa *</span>
                  <select required className={fieldClassName} value={form.stage} onChange={(e) => onFormChange({ ...form, stage: e.target.value as Stage })}>{stages.map((stage) => <option key={stage} value={stage}>{stageLabel[stage]}</option>)}</select>
                </label>
                <label className="space-y-1 sm:col-span-2">
                  <span className={labelClassName}>Tabela de preço ERP *</span>
                  <select required className={fieldClassName} value={form.priceTableCode || "1"} onChange={(e) => onFormChange({ ...form, priceTableCode: e.target.value })}>
                    {(priceTableOptions.length ? priceTableOptions : [{ code: "1", label: "1 · REVENDA / COOPERATIVA" }]).map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
                  </select>
                  <p className={helpClassName}>Define o preço sugerido dos produtos e será usado como padrão no pedido ERP.</p>
                  {priceTableWarning ? <p className="text-xs text-amber-700">{priceTableWarning}</p> : null}
                </label>
              </div>
            </section>



{productsSection ? productsSection : null}

            <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
              <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Valor e potencial</h4>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="space-y-1">
                  <span className={labelClassName}>{hasStructuredItems ? "Valor da oportunidade (itens)" : "Valor *"}</span>
                  <input required inputMode="decimal" readOnly={hasStructuredItems} className={fieldClassName} placeholder="Ex: 45000" value={form.value} onChange={(e) => onFormChange({ ...form, value: sanitizeNumericInput(e.target.value) })} />
                  {hasStructuredItems ? <p className={helpClassName}>Calculado automaticamente pela soma líquida dos itens estruturados.</p> : null}
                </label>
                <label className="space-y-1">
                  <span className={labelClassName}>Probabilidade % *</span>
                  <input required inputMode="numeric" min={0} max={100} className={fieldClassName} placeholder="Ex: 60" value={form.probability} onChange={(e) => onFormChange({ ...form, probability: sanitizeNumericInput(e.target.value, false) })} />
                  <p className={helpClassName}>Chance estimada de fechamento da oportunidade.</p>
                </label>
                <label className="space-y-1">
                  <span className={labelClassName}>Área (ha) (opcional)</span>
                  <input inputMode="decimal" className={fieldClassName} placeholder="Ex: 120" value={form.areaHa} onChange={(e) => onFormChange({ ...form, areaHa: sanitizeNumericInput(e.target.value) })} />
                </label>
                <label className="space-y-1">
                  <span className={labelClassName}>Ticket esperado/ha (opcional)</span>
                  <input inputMode="decimal" className={fieldClassName} placeholder="Ex: 380" value={form.expectedTicketPerHa} onChange={(e) => onFormChange({ ...form, expectedTicketPerHa: sanitizeNumericInput(e.target.value) })} />
                  <p className={helpClassName}>Valor estimado por hectare.</p>
                </label>
              </div>
            </section>

            <section className={`space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 ${hasStructuredItems ? "opacity-70" : ""}`}>
              <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Contexto técnico/comercial</h4>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className={labelClassName}>Cultura (opcional)</span>
                  <select className={fieldClassName} value={form.crop} onChange={(e) => onFormChange({ ...form, crop: e.target.value })}>
                    <option value="">Selecione a cultura</option>
                    {cropOptions.map((crop) => <option key={crop} value={crop}>{crop}</option>)}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className={labelClassName}>Safra (opcional)</span>
                  <input list="season-suggestions" className={fieldClassName} placeholder="Ex: 2025/26" value={form.season} onChange={(e) => onFormChange({ ...form, season: e.target.value })} />
                </label>
              </div>
              <datalist id="season-suggestions">
                <option value="2024/25" />
                <option value="2025/26" />
                <option value="2026/27" />
              </datalist>
            </section>

            <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
              <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Datas</h4>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="space-y-1">
                  <span className={labelClassName}>Data de entrada *</span>
                  <input required type="date" className={fieldClassName} value={form.proposalEntryDate} onChange={(e) => onFormChange({ ...form, proposalEntryDate: e.target.value })} />
                  <p className={helpClassName}>Quando a oportunidade entrou no funil.</p>
                </label>
                <label className="space-y-1">
                  <span className={labelClassName}>Data de follow-up / retorno *</span>
                  <input required type="date" className={fieldClassName} value={form.expectedReturnDate} onChange={(e) => onFormChange({ ...form, expectedReturnDate: e.target.value })} />
                  <p className={helpClassName}>Próxima ação comercial planejada.</p>
                </label>
                <label className="space-y-1">
                  <span className={labelClassName}>Fechamento previsto (opcional)</span>
                  <input type="date" className={fieldClassName} value={form.plantingForecastDate} onChange={(e) => onFormChange({ ...form, plantingForecastDate: e.target.value })} />
                  <p className={helpClassName}>Previsão estimada de fechamento.</p>
                </label>
                <label className="space-y-1">
                  <span className={labelClassName}>Último contato (opcional)</span>
                  <input type="date" className={fieldClassName} value={form.lastContactAt} onChange={(e) => onFormChange({ ...form, lastContactAt: e.target.value })} />
                </label>
              </div>
            </section>

            <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
              <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Notas</h4>
              <label className="space-y-1">
                <span className={labelClassName}>Notas (opcional)</span>
                <textarea className="w-full rounded-lg border border-slate-200 p-2" placeholder="Informações relevantes para a negociação" value={form.notes} onChange={(e) => onFormChange({ ...form, notes: e.target.value })} />
              </label>
            </section>

            <p className="text-xs text-slate-500">Campos com * são obrigatórios.</p>
            {errorMessage ? <p className="text-sm text-red-600">{errorMessage}</p> : null}
          </div>

          <div className="mobile-modal-footer sticky bottom-0 z-10 border-t border-slate-200 bg-white shadow-[0_-8px_24px_rgba(15,23,42,0.06)] sm:shadow-none">
            <button type="button" className="mobile-secondary-half rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700" onClick={requestClose}>
              Cancelar
            </button>
            <button type="submit" disabled={isSaving} className="mobile-primary-button rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-500">
              {isSaving ? "Salvando..." : submitLabel}
            </button>
          </div>
        </form>

        {showCancelConfirmation ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-900/40 px-4" onClick={() => setShowCancelConfirmation(false)}>
            <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" role="alertdialog" aria-modal="true" aria-labelledby="cancel-opportunity-title" onClick={(event) => event.stopPropagation()}>
              <h4 id="cancel-opportunity-title" className="text-lg font-semibold text-slate-900">Descartar alterações?</h4>
              <p className="mt-2 text-sm text-slate-600">Existem informações preenchidas. Deseja realmente cancelar? Os dados não salvos serão perdidos.</p>
              <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700" onClick={() => setShowCancelConfirmation(false)}>
                  Continuar editando
                </button>
                <button type="button" className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white" onClick={discardChanges}>
                  Descartar alterações
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
