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
    if (!term) return clients;

    const termDigits = term.replace(/\D/g, "");

    return clients.filter((client) => {
      const cnpjDigits = (client.cnpj || "").replace(/\D/g, "");
      const hasTextMatch = [client.name, client.city, client.state, client.cnpj].some((field) => normalizeText(field).includes(term));
      const hasCnpjMatch = Boolean(termDigits) && cnpjDigits.includes(termDigits);
      return hasTextMatch || hasCnpjMatch;
    });
  }, [clients, searchValue]);

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
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {filteredClients.length ? (
            filteredClients.map((client) => (
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
        </div>
      ) : null}
    </div>
  );
}
