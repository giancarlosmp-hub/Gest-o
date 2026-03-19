import { FormEvent, useEffect, useRef, useState } from "react";
import ClientSearchSelect from "../clients/ClientSearchSelect";
import ClientCnpjLookupField from "./ClientCnpjLookupField";

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

type ClientOption = {
  id: string;
  name: string;
  city?: string | null;
  state?: string | null;
  cnpj?: string | null;
};
type SellerOption = { id: string; name: string };

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
  onQuickCreateClient: (payload: { name: string; city: string; state: string; region: string }) => Promise<ClientOption>;
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
  onQuickCreateClient
}: CreateOpportunityModalProps) {
  const fieldClassName = "w-full rounded-lg border border-slate-200 p-2";
  const labelClassName = "text-sm font-medium text-slate-700";
  const helpClassName = "text-xs text-slate-500";

  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [isQuickCreateOpen, setIsQuickCreateOpen] = useState(false);
  const [isCreatingClient, setIsCreatingClient] = useState(false);
  const [quickCreateError, setQuickCreateError] = useState<string | null>(null);
  const [cnpjLookupError, setCnpjLookupError] = useState<string | null>(null);
  const [quickClient, setQuickClient] = useState({
    cnpj: "",
    name: "",
    city: "",
    state: "",
    region: ""
  });

  useEffect(() => {
    if (!open) return;
    titleInputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setIsQuickCreateOpen(false);
    setIsCreatingClient(false);
    setQuickCreateError(null);
    setCnpjLookupError(null);
    setQuickClient({ cnpj: "", name: "", city: "", state: "", region: "" });
  }, [open]);

  const handleQuickCreateClient = async () => {
    const payload = {
      name: quickClient.name.trim(),
      city: quickClient.city.trim(),
      state: quickClient.state.trim(),
      region: quickClient.region.trim()
    };

    if (!payload.name || !payload.city || !payload.state || !payload.region) {
      setQuickCreateError("Preencha nome, cidade, UF e região");
      return;
    }

    setQuickCreateError(null);
    setIsCreatingClient(true);

    try {
      const createdClient = await onQuickCreateClient(payload);
      onFormChange({ ...form, clientId: createdClient.id });
      setIsQuickCreateOpen(false);
      setCnpjLookupError(null);
      setQuickClient({ cnpj: "", name: "", city: "", state: "", region: "" });
    } catch (error: any) {
      setQuickCreateError(error?.message || "Não foi possível criar cliente");
    } finally {
      setIsCreatingClient(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/60 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-full flex-col bg-white sm:h-auto sm:max-h-[calc(100vh-2rem)] sm:max-w-3xl sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          <button type="button" className="rounded-md border border-slate-200 px-3 py-1 text-sm text-slate-600" onClick={onClose}>
            Fechar
          </button>
        </div>

        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-6 overflow-y-auto overscroll-contain p-4 sm:p-6">
            <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
              <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Identificação</h4>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className={labelClassName}>Título *</span>
                  <input ref={titleInputRef} required className={fieldClassName} placeholder="Ex: Oportunidade Milho Safra 25/26 – Cliente X" value={form.title} onChange={(e) => onFormChange({ ...form, title: e.target.value })} />
                </label>
                <div className="space-y-2">
                  <label className="space-y-1">
                    <span className={labelClassName}>Cliente *</span>
                    <ClientSearchSelect
                      clients={clients}
                      value={form.clientId}
                      onChange={(clientId) => onFormChange({ ...form, clientId })}
                      required
                      emptyLabel="Nenhum cliente encontrado."
                      className={fieldClassName}
                    />
                  </label>
                  <button
                    type="button"
                    className="text-sm font-medium text-brand-700 hover:text-brand-800"
                    onClick={() => {
                      setIsQuickCreateOpen((current) => !current);
                      setQuickCreateError(null);
                      setCnpjLookupError(null);
                    }}
                  >
                    {isQuickCreateOpen ? "Cancelar novo cliente" : "+ Criar cliente"}
                  </button>
                  {isQuickCreateOpen ? (
                    <div className="grid gap-2 rounded-lg border border-slate-200 bg-white p-3">
                      <div className="grid gap-2">
                        <ClientCnpjLookupField
                          value={quickClient.cnpj}
                          onChange={(cnpj) => setQuickClient((prev) => ({ ...prev, cnpj }))}
                          onLookupSuccess={({ cnpj, name, city, state }) => {
                            setQuickClient((prev) => ({
                              ...prev,
                              cnpj,
                              name: prev.name || name,
                              city: prev.city || city,
                              state: prev.state || state
                            }));
                          }}
                          cnpjLookupError={cnpjLookupError}
                          setCnpjLookupError={setCnpjLookupError}
                          disabled={isCreatingClient}
                          className={fieldClassName}
                        />
                        <input required className={fieldClassName} placeholder="Nome do cliente" value={quickClient.name} onChange={(e) => setQuickClient((prev) => ({ ...prev, name: e.target.value }))} />
                        <input required className={fieldClassName} placeholder="Cidade" value={quickClient.city} onChange={(e) => setQuickClient((prev) => ({ ...prev, city: e.target.value }))} />
                        <input required className={fieldClassName} placeholder="UF" value={quickClient.state} onChange={(e) => setQuickClient((prev) => ({ ...prev, state: e.target.value.toUpperCase() }))} maxLength={2} />
                        <input required className={fieldClassName} placeholder="Região" value={quickClient.region} onChange={(e) => setQuickClient((prev) => ({ ...prev, region: e.target.value }))} />
                        {quickCreateError ? <p className="text-xs text-red-600">{quickCreateError}</p> : null}
                        <button type="button" onClick={handleQuickCreateClient} disabled={isCreatingClient} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-500">
                          {isCreatingClient ? "Criando cliente..." : "Salvar cliente"}
                        </button>
                      </div>
                    </div>
                  ) : null}
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
              </div>
            </section>

            <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
              <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Valor e potencial</h4>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="space-y-1">
                  <span className={labelClassName}>Valor *</span>
                  <input required inputMode="decimal" className={fieldClassName} placeholder="Ex: 45000" value={form.value} onChange={(e) => onFormChange({ ...form, value: sanitizeNumericInput(e.target.value) })} />
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

            <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
              <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Contexto técnico/comercial</h4>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
                <label className="space-y-1">
                  <span className={labelClassName}>Produto ofertado (opcional)</span>
                  <input className={fieldClassName} placeholder="Ex: Mix cobertura inverno" value={form.productOffered} onChange={(e) => onFormChange({ ...form, productOffered: e.target.value })} />
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

          <div className="sticky bottom-0 z-10 flex shrink-0 justify-end gap-2 border-t border-slate-200 bg-white px-4 py-3 sm:px-6">
            <button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" disabled={isSaving} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-500">
              {isSaving ? "Salvando..." : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
