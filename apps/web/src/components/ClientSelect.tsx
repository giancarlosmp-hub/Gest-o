import { useEffect, useState } from "react";
import api from "../lib/apiClient";
import { clientSearchParams, readClientSearchItems, withSelectedClient, type ClientSelectOption } from "../lib/clientSelectSearch";

type Client = ClientSelectOption;

type Props = {
  value?: string;
  onChange: (client: Client | null) => void;
};

export default function ClientSelect({ value, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Client[]>([]);
  const [selected, setSelected] = useState<Client | null>(null);

  useEffect(() => {
    const params = clientSearchParams(query);
    // Sem texto, ou com o nome do cliente já escolhido no campo, não abre a lista.
    if (!params || (selected && query === selected.name)) {
      setOptions([]);
      return;
    }

    let active = true;
    const timeout = setTimeout(async () => {
      try {
        const res = await api.get("/clients", { params });
        if (active) setOptions(withSelectedClient(readClientSearchItems(res.data), selected, query));
      } catch (e) {
        console.error(e);
      }
    }, 300);

    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [query, selected]);

  useEffect(() => {
    if (!value) {
      // Filtro limpo por fora (ex.: "Limpar filtros"): tira o nome que ficou no campo.
      if (selected && query === selected.name) {
        setSelected(null);
        setQuery("");
      }
      return;
    }
    if (selected?.id === value) return;

    const timeout = setTimeout(async () => {
      try {
        const res = await api.get(`/clients/${value}`);
        if (res.data?.name) {
          setSelected(res.data);
          setQuery(String(res.data.name));
        }
      } catch (e) {
        console.error(e);
      }
    }, 0);

    return () => clearTimeout(timeout);
  }, [value]);

  function handleSelect(client: Client) {
    setSelected(client);
    setQuery(client.name);
    setOptions([]);
    onChange(client);
  }

  return (
    <div className="relative w-full">
      <input
        type="text"
        placeholder="Buscar cliente..."
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(null);
        }}
        className="w-full min-w-0 border rounded px-3 py-2"
      />

      {options.length > 0 && (
        <div className="absolute z-50 bg-white border rounded w-full max-h-60 overflow-auto shadow">
          {options.map((c) => (
            <div
              key={c.id}
              onClick={() => handleSelect(c)}
              className="px-3 py-2 hover:bg-gray-100 cursor-pointer"
            >
              <div className="font-medium">{c.name}</div>
              <div className="text-xs text-gray-500">
                {c.city} - {c.state}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
