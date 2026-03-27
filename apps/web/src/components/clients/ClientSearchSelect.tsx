import { useEffect, useMemo, useRef, useState } from "react";

export type SearchableClientOption = {
  id: string;
  name: string;
  fantasyName?: string | null;
  code?: string | null;
  city?: string | null;
  state?: string | null;
  cnpj?: string | null;
};

type ClientSearchSelectProps = {
  clients: SearchableClientOption[];
  value: string;
  onChange: (clientId: string) => void;
  required?: boolean;
  placeholder?: string;
  emptyLabel?: string;
  maxListHeightClassName?: string;
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
  required = false,
  placeholder = "Pesquisar por razão social, fantasia, código, cidade, UF ou CNPJ",
  emptyLabel = "Nenhum cliente encontrado.",
  maxListHeightClassName = "max-h-56",
  className = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
}: ClientSearchSelectProps) {
  const [searchValue, setSearchValue] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isPointerDraggingRef = useRef(false);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);

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
      const hasTextMatch = [client.name, client.fantasyName, client.code, client.city, client.state, client.cnpj].some((field) =>
        normalizeText(field).includes(term)
      );
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
      {required ? <input required tabIndex={-1} className="sr-only" value={value} onChange={() => undefined} aria-hidden /> : null}
      {isOpen ? (
        <div
          className={`absolute z-20 mt-1 w-full overflow-y-auto overscroll-contain rounded-lg border border-slate-200 bg-white shadow-lg [touch-action:pan-y] [-webkit-overflow-scrolling:touch] ${maxListHeightClassName}`}
        >
          {filteredClients.length ? (
            filteredClients.map((client) => (
              <button
                key={client.id}
                type="button"
                className="block w-full border-b border-slate-100 px-3 py-2 text-left last:border-b-0 hover:bg-slate-50"
                onPointerDown={(event) => {
                  pointerStartRef.current = { x: event.clientX, y: event.clientY };
                  isPointerDraggingRef.current = false;
                }}
                onPointerMove={(event) => {
                  if (!pointerStartRef.current) return;
                  const deltaX = Math.abs(event.clientX - pointerStartRef.current.x);
                  const deltaY = Math.abs(event.clientY - pointerStartRef.current.y);
                  if (deltaX > 6 || deltaY > 6) isPointerDraggingRef.current = true;
                }}
                onPointerCancel={() => {
                  pointerStartRef.current = null;
                  isPointerDraggingRef.current = false;
                }}
                onPointerUp={() => {
                  pointerStartRef.current = null;
                }}
                onClick={() => {
                  if (isPointerDraggingRef.current) {
                    isPointerDraggingRef.current = false;
                    return;
                  }
                  onChange(client.id);
                  setSearchValue(formatClientLabel(client));
                  setIsOpen(false);
                }}
              >
                <p className="text-sm text-slate-900">{formatClientLabel(client)}</p>
                {client.fantasyName ? <p className="text-xs text-slate-600">({client.fantasyName})</p> : null}
                {client.cnpj ? <p className="text-xs text-slate-500">CNPJ: {client.cnpj}</p> : null}
                {client.code ? <p className="text-xs text-slate-500">Código: {client.code}</p> : null}
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
