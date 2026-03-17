import { useEffect, useMemo, useRef, useState } from "react";

export type SearchableClientOption = {
  id: string;
  name: string;
  city?: string | null;
  state?: string | null;
  cnpj?: string | null;
};

type ClientSearchSelectProps = {
  clients: SearchableClientOption[];
  value: string;
  onChange: (clientId: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  className?: string;
};

const LARGE_LIST_THRESHOLD = 30;
const MIN_SEARCH_LENGTH_FOR_LARGE_LIST = 2;
const MAX_VISIBLE_OPTIONS = 80;

const normalizeText = (value?: string | null) =>
  (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

function formatClientLocation(client: SearchableClientOption) {
  const city = client.city?.trim();
  const state = client.state?.trim()?.toUpperCase();

  if (city && state) return `${city}/${state}`;
  if (city) return city;
  if (state) return state;
  return "Cidade não informada";
}

function formatClientLabel(client: SearchableClientOption) {
  return `${client.name} — ${formatClientLocation(client)}`;
}

export default function ClientSearchSelect({
  clients,
  value,
  onChange,
  placeholder = "Pesquisar por nome, cidade, UF ou CNPJ",
  emptyLabel = "Nenhum cliente encontrado.",
  className = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
}: ClientSearchSelectProps) {
  const [searchValue, setSearchValue] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const selectedClient = useMemo(() => clients.find((client) => client.id === value) || null, [clients, value]);

  useEffect(() => {
    if (!selectedClient) {
      setSearchValue("");
      return;
    }
    setSearchValue(formatClientLabel(selectedClient));
  }, [selectedClient]);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) setIsOpen(false);
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  const filteredClients = useMemo(() => {
    const term = normalizeText(searchValue.trim());
    if (!term) {
      if (clients.length > LARGE_LIST_THRESHOLD) return [];
      return clients;
    }

    const termDigits = term.replace(/\D/g, "");

    return clients.filter((client) => {
      const cnpjDigits = (client.cnpj || "").replace(/\D/g, "");
      const hasTextMatch = [client.name, client.city, client.state, client.cnpj].some((field) => normalizeText(field).includes(term));
      const hasCnpjMatch = Boolean(termDigits) && cnpjDigits.includes(termDigits);
      return hasTextMatch || hasCnpjMatch;
    });
  }, [clients, searchValue]);

  const shouldRequireSearch = clients.length > LARGE_LIST_THRESHOLD && searchValue.trim().length < MIN_SEARCH_LENGTH_FOR_LARGE_LIST;
  const visibleClients = filteredClients.slice(0, MAX_VISIBLE_OPTIONS);

  return (
    <div ref={containerRef} className="relative">
      <input
        className={className}
        value={searchValue}
        onFocus={() => setIsOpen(true)}
        onChange={(event) => {
          setSearchValue(event.target.value);
          setIsOpen(true);
          if (value) onChange("");
        }}
        placeholder={placeholder}
      />
      {isOpen ? (
        <div
          className="absolute left-0 right-0 z-20 mt-1 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg"
          style={{ maxHeight: "min(18rem, calc(100vh - 14rem))" }}
        >
          {shouldRequireSearch ? (
            <p className="px-3 py-2 text-sm text-slate-500">
              Digite ao menos {MIN_SEARCH_LENGTH_FOR_LARGE_LIST} caracteres para buscar clientes.
            </p>
          ) : visibleClients.length ? (
            visibleClients.map((client) => (
              <button
                key={client.id}
                type="button"
                className="block w-full border-b border-slate-100 px-3 py-2 text-left last:border-b-0 hover:bg-slate-50"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(client.id);
                  setSearchValue(formatClientLabel(client));
                  setIsOpen(false);
                }}
              >
                <p className="text-sm text-slate-900">{formatClientLabel(client)}</p>
                {client.cnpj ? <p className="text-xs text-slate-500">CNPJ: {client.cnpj}</p> : null}
              </button>
            ))
          ) : (
            <p className="px-3 py-2 text-sm text-slate-500">{emptyLabel}</p>
          )}
          {!shouldRequireSearch && filteredClients.length > MAX_VISIBLE_OPTIONS ? (
            <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
              Mostrando {MAX_VISIBLE_OPTIONS} de {filteredClients.length} resultados. Continue digitando para refinar.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
