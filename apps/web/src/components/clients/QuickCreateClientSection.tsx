import { useEffect, useRef, useState } from "react";
import {
  DuplicateClientCheckError,
  ExistingClientSummary,
  buildDuplicateClientMessage,
  findDuplicateClientByLookupPayload
} from "../../lib/clientDuplicateCheck";
import ClientCnpjLookupField from "../opportunities/ClientCnpjLookupField";

type ClientOption = {
  id: string;
  name: string;
  city?: string | null;
  state?: string | null;
  cnpj?: string | null;
};

type QuickCreateClientSectionProps = {
  open: boolean;
  fieldClassName?: string;
  onClientSelected: (clientId: string) => void;
  onQuickCreateClient: (payload: { cnpj?: string; name: string; city: string; state: string; region: string }) => Promise<ClientOption>;
  onSelectExistingClient: (client: ExistingClientSummary) => ClientOption;
};

export default function QuickCreateClientSection({
  open,
  fieldClassName = "w-full rounded-lg border border-slate-200 p-2",
  onClientSelected,
  onQuickCreateClient,
  onSelectExistingClient
}: QuickCreateClientSectionProps) {
  const [isQuickCreateOpen, setIsQuickCreateOpen] = useState(false);
  const [isCreatingClient, setIsCreatingClient] = useState(false);
  const [quickCreateError, setQuickCreateError] = useState<string | null>(null);
  const [cnpjLookupError, setCnpjLookupError] = useState<string | null>(null);
  const [duplicateClient, setDuplicateClient] = useState<ExistingClientSummary | null>(null);
  const [quickClient, setQuickClient] = useState({
    cnpj: "",
    name: "",
    city: "",
    state: "",
    region: ""
  });
  const quickClientRef = useRef(quickClient);

  const updateQuickClient = (patch: Partial<typeof quickClient>) => {
    setQuickClient((currentQuickClient) => {
      const nextQuickClient = { ...currentQuickClient, ...patch };
      quickClientRef.current = nextQuickClient;
      return nextQuickClient;
    });
  };

  useEffect(() => {
    quickClientRef.current = quickClient;
  }, [quickClient]);

  useEffect(() => {
    if (!open) return;
    setIsQuickCreateOpen(false);
    setIsCreatingClient(false);
    setQuickCreateError(null);
    setCnpjLookupError(null);
    setDuplicateClient(null);
    updateQuickClient({ cnpj: "", name: "", city: "", state: "", region: "" });
  }, [open]);

  const handleQuickClientLookupSuccess = async ({ cnpj, name, city, state }: { cnpj: string; name: string; city: string; state: string }) => {
    setDuplicateClient(null);
    setQuickCreateError(null);

    setQuickClient((currentQuickClient) => {
      const nextQuickClient = {
        ...currentQuickClient,
        cnpj,
        name: currentQuickClient.name || name,
        city: currentQuickClient.city || city,
        state: currentQuickClient.state || state
      };
      quickClientRef.current = nextQuickClient;
      return nextQuickClient;
    });

    const duplicateCheck = await findDuplicateClientByLookupPayload({ cnpj, name, city, state });
    if (!duplicateCheck?.existingClient) return;

    setDuplicateClient(duplicateCheck.existingClient);
    setQuickCreateError(buildDuplicateClientMessage(duplicateCheck));
  };

  const handleSelectExistingClient = () => {
    if (!duplicateClient) return;

    const selectedClient = onSelectExistingClient(duplicateClient);
    onClientSelected(selectedClient.id);
    setIsQuickCreateOpen(false);
    setQuickCreateError(null);
    setCnpjLookupError(null);
    setDuplicateClient(null);
    updateQuickClient({ cnpj: "", name: "", city: "", state: "", region: "" });
  };

  const handleQuickCreateClient = async () => {
    const payload = {
      cnpj: quickClientRef.current.cnpj.trim(),
      name: quickClientRef.current.name.trim(),
      city: quickClientRef.current.city.trim(),
      state: quickClientRef.current.state.trim(),
      region: quickClientRef.current.region.trim()
    };

    if (!payload.name || !payload.city || !payload.state || !payload.region) {
      setQuickCreateError("Preencha nome, cidade, UF e região");
      return;
    }

    setQuickCreateError(null);
    setDuplicateClient(null);
    setIsCreatingClient(true);

    try {
      const createdClient = await onQuickCreateClient(payload);
      onClientSelected(createdClient.id);
      setIsQuickCreateOpen(false);
      setQuickCreateError(null);
      setCnpjLookupError(null);
      updateQuickClient({ cnpj: "", name: "", city: "", state: "", region: "" });
    } catch (error: any) {
      if (error instanceof DuplicateClientCheckError && error.existingClient) {
        setDuplicateClient(error.existingClient);
      }
      setQuickCreateError(error?.message || "Não foi possível criar cliente");
    } finally {
      setIsCreatingClient(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="text-sm font-medium text-brand-700 hover:text-brand-800"
        onClick={() => {
          setIsQuickCreateOpen((current) => !current);
          setQuickCreateError(null);
          setCnpjLookupError(null);
          setDuplicateClient(null);
        }}
      >
        {isQuickCreateOpen ? "Cancelar novo cliente" : "+ Criar cliente"}
      </button>
      {isQuickCreateOpen ? (
        <div className="grid gap-2 rounded-lg border border-slate-200 bg-white p-3">
          <div className="grid gap-2">
            <ClientCnpjLookupField
              value={quickClient.cnpj}
              onChange={(cnpj) => {
                setDuplicateClient(null);
                setQuickCreateError(null);
                updateQuickClient({ cnpj });
              }}
              onLookupSuccess={handleQuickClientLookupSuccess}
              cnpjLookupError={cnpjLookupError}
              setCnpjLookupError={setCnpjLookupError}
              disabled={isCreatingClient}
              className={fieldClassName}
            />
            <input required className={fieldClassName} placeholder="Nome do cliente" value={quickClient.name} onChange={(e) => { setDuplicateClient(null); setQuickCreateError(null); updateQuickClient({ name: e.target.value }); }} />
            <input required className={fieldClassName} placeholder="Cidade" value={quickClient.city} onChange={(e) => { setDuplicateClient(null); setQuickCreateError(null); updateQuickClient({ city: e.target.value }); }} />
            <input required className={fieldClassName} placeholder="UF" value={quickClient.state} onChange={(e) => { setDuplicateClient(null); setQuickCreateError(null); updateQuickClient({ state: e.target.value.toUpperCase() }); }} maxLength={2} />
            <input required className={fieldClassName} placeholder="Região" value={quickClient.region} onChange={(e) => { setDuplicateClient(null); setQuickCreateError(null); updateQuickClient({ region: e.target.value }); }} />
            {quickCreateError ? <p className="text-xs text-red-600">{quickCreateError}</p> : null}
            {duplicateClient ? (
              <button
                type="button"
                onClick={handleSelectExistingClient}
                className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-100"
              >
                Selecionar cliente existente
              </button>
            ) : null}
            <button type="button" onClick={handleQuickCreateClient} disabled={isCreatingClient || Boolean(duplicateClient)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-500">
              {isCreatingClient ? "Criando cliente..." : "Salvar cliente"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
