import { useEffect, useState } from "react";
import api from "../lib/apiClient";

type Client = {
  id: string;
  name: string;
  city?: string;
  state?: string;
};

type Props = {
  value?: string;
  onChange: (client: Client | null) => void;
};

export default function ClientSelect({ value, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Client[]>([]);

  useEffect(() => {
    if (!query) return;

    const timeout = setTimeout(async () => {
      try {
        const res = await api.get(`/clients?search=${query}`);
        setOptions(res.data || []);
      } catch (e) {
        console.error(e);
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    if (!value) return;

    const timeout = setTimeout(async () => {
      try {
        const res = await api.get(`/clients/${value}`);
        if (res.data?.name) setQuery(String(res.data.name));
      } catch (e) {
        console.error(e);
      }
    }, 0);

    return () => clearTimeout(timeout);
  }, [value]);

  function handleSelect(client: Client) {
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
