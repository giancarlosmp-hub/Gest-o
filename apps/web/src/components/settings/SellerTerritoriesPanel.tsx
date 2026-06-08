import { useEffect, useMemo, useState } from "react";
import { AlertCircle, MapPinned, Plus, Save, Search, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import api from "../../lib/apiClient";
import { getApiErrorMessage } from "../../lib/apiError";
import { useAuth } from "../../context/AuthContext";

type SellerOption = {
  id: string;
  name: string;
  role: "vendedor";
  region?: string | null;
  canEdit: boolean;
};

type TerritoryCity = {
  id: string;
  sellerId: string;
  city: string;
  state: string;
  ibgeCode?: string | null;
};

type TerritoryCityLink = TerritoryCity & { sellerName: string };

type OfficialCity = {
  city: string;
  state: string;
  ibgeCode?: string | null;
};

type DraftCity = TerritoryCity & { draftId: string; isNew?: boolean };

const ufOptions = ["PR", "MS", "SC"];

const normalizeText = (value: string) => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/['’]/g, "")
  .replace(/[^a-zA-Z0-9]+/g, " ")
  .trim()
  .replace(/\s+/g, " ")
  .toLowerCase();

const normalizeCity = (city: string) => city.replace(/\s+/g, " ").trim();
const normalizeState = (state: string) => state.trim().toUpperCase();

function parseBulkCities(text: string): Array<{ city: string; state: string; raw: string }> {
  return text
    .split(/\r?\n|;/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [city = "", state = ""] = line.split("/").map((part) => part.trim());
      return { city: normalizeCity(city), state: normalizeState(state), raw: line };
    });
}

function buildDraftKey(city: Pick<DraftCity | OfficialCity | TerritoryCityLink, "city" | "state">) {
  return `${normalizeState(city.state)}::${normalizeText(city.city)}`;
}

export default function SellerTerritoriesPanel() {
  const { user } = useAuth();
  const [sellers, setSellers] = useState<SellerOption[]>([]);
  const [selectedSellerId, setSelectedSellerId] = useState("");
  const [cities, setCities] = useState<DraftCity[]>([]);
  const [search, setSearch] = useState("");
  const [ufFilter, setUfFilter] = useState("");
  const [newCity, setNewCity] = useState("");
  const [newState, setNewState] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);
  const [officialCities, setOfficialCities] = useState<OfficialCity[]>([]);
  const [allOfficialCities, setAllOfficialCities] = useState<OfficialCity[]>([]);
  const [linkedCities, setLinkedCities] = useState<TerritoryCityLink[]>([]);
  const [loadingOfficialCities, setLoadingOfficialCities] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedSeller = sellers.find((seller) => seller.id === selectedSellerId);
  const canEditSelectedSeller = Boolean(selectedSeller?.canEdit);
  const isSellerViewer = user?.role === "vendedor";
  const selectedOfficialCity = useMemo(() => officialCities.find((city) => buildDraftKey(city) === `${normalizeState(newState)}::${normalizeText(newCity)}`) ?? null, [newCity, newState, officialCities]);
  const newCityPlaceholder = newState ? "Busque uma cidade oficial" : "Selecione uma UF primeiro";

  const filteredCities = useMemo(() => {
    const normalizedSearch = normalizeText(search);
    return cities.filter((city) => {
      const matchesSearch = !normalizedSearch || normalizeText(city.city).includes(normalizedSearch);
      const matchesUf = !ufFilter || city.state === ufFilter;
      return matchesSearch && matchesUf;
    });
  }, [cities, search, ufFilter]);

  const totalByUf = useMemo(() => {
    return cities.reduce<Record<string, number>>((acc, city) => {
      acc[city.state] = (acc[city.state] ?? 0) + 1;
      return acc;
    }, {});
  }, [cities]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);

    api.get<SellerOption[]>("/territories/config/sellers")
      .then(({ data }) => {
        if (!mounted) return;
        const loadedSellers = Array.isArray(data) ? data : [];
        setSellers(loadedSellers);
        setSelectedSellerId((current) => current || loadedSellers[0]?.id || "");
      })
      .catch((err) => {
        if (!mounted) return;
        setError(getApiErrorMessage(err, "Não foi possível carregar vendedores para territórios."));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let mounted = true;

    api.get<OfficialCity[]>("/territories/config/official-cities")
      .then(({ data }) => {
        if (mounted) setAllOfficialCities(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (mounted) setAllOfficialCities([]);
      });

    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!canEditSelectedSeller) return;
    let mounted = true;

    api.get<TerritoryCityLink[]>("/territories/config/city-links")
      .then(({ data }) => {
        if (mounted) setLinkedCities(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (mounted) setLinkedCities([]);
      });

    return () => { mounted = false; };
  }, [canEditSelectedSeller]);

  useEffect(() => {
    setNewCity("");
    setLoadingOfficialCities(Boolean(newState));
    if (!newState) {
      setOfficialCities([]);
      setLoadingOfficialCities(false);
      return;
    }

    let mounted = true;
    api.get<OfficialCity[]>("/territories/config/official-cities", { params: { uf: newState } })
      .then(({ data }) => {
        if (mounted) setOfficialCities(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (mounted) setOfficialCities([]);
      })
      .finally(() => {
        if (mounted) setLoadingOfficialCities(false);
      });

    return () => { mounted = false; };
  }, [newState]);

  useEffect(() => {
    if (!selectedSellerId) return;
    let mounted = true;
    setLoading(true);
    setError(null);

    api.get<TerritoryCity[]>("/territories/config/cities", { params: { sellerId: selectedSellerId } })
      .then(({ data }) => {
        if (!mounted) return;
        setCities((Array.isArray(data) ? data : []).map((city) => ({ ...city, draftId: city.id })));
      })
      .catch((err) => {
        if (!mounted) return;
        setCities([]);
        setError(getApiErrorMessage(err, "Não foi possível carregar cidades vinculadas."));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => { mounted = false; };
  }, [selectedSellerId]);

  const findLinkedCityConflict = (city: Pick<OfficialCity, "city" | "state">) => {
    const key = buildDraftKey(city);
    return linkedCities.find((linkedCity) => linkedCity.sellerId !== selectedSellerId && buildDraftKey(linkedCity) === key) ?? null;
  };

  const addCityToDraft = () => {
    if (!canEditSelectedSeller || !selectedOfficialCity) return;

    const conflict = findLinkedCityConflict(selectedOfficialCity);
    if (conflict) {
      toast.error(`Esta cidade já está vinculada ao vendedor ${conflict.sellerName}. Remova do território atual antes de transferir.`);
      return;
    }

    const draft: DraftCity = {
      id: `new-${Date.now()}`,
      draftId: `new-${Date.now()}`,
      sellerId: selectedSellerId,
      city: selectedOfficialCity.city,
      state: selectedOfficialCity.state,
      ibgeCode: selectedOfficialCity.ibgeCode ?? null,
      isNew: true
    };

    setCities((current) => {
      if (current.some((item) => buildDraftKey(item) === buildDraftKey(draft))) {
        toast.warning("Esta cidade já está vinculada a este vendedor.");
        return current;
      }
      return [...current, draft].sort((a, b) => a.state.localeCompare(b.state) || a.city.localeCompare(b.city, "pt-BR"));
    });
    setNewCity("");
  };

  const addBulkCitiesToDraft = () => {
    if (!canEditSelectedSeller) return;
    const parsedCities = parseBulkCities(bulkText);
    if (parsedCities.length === 0) {
      toast.error("Cole cidades no formato Cidade/UF, uma por linha.");
      return;
    }

    setBulkErrors([]);
    setCities((current) => {
      const knownKeys = new Set(current.map(buildDraftKey));
      const batchKeys = new Set<string>();
      const drafts: DraftCity[] = [];
      const errors: string[] = [];

      parsedCities.forEach((item, index) => {
        if (!ufOptions.includes(item.state)) {
          errors.push(`UF inválida: ${item.raw}`);
          return;
        }

        const officialCity = allOfficialCities.find((city) => city.state === item.state && normalizeText(city.city) === normalizeText(item.city));
        if (!officialCity) {
          errors.push(`Cidade não encontrada: ${item.city}/${item.state}`);
          return;
        }

        const key = buildDraftKey(officialCity);
        if (batchKeys.has(key)) {
          errors.push(`Cidade duplicada no lote: ${officialCity.city}/${officialCity.state}`);
          return;
        }
        batchKeys.add(key);

        if (knownKeys.has(key)) {
          errors.push("Esta cidade já está vinculada a este vendedor.");
          return;
        }

        const conflict = findLinkedCityConflict(officialCity);
        if (conflict) {
          errors.push(`Esta cidade já está vinculada ao vendedor ${conflict.sellerName}. Remova do território atual antes de transferir.`);
          return;
        }

        knownKeys.add(key);
        drafts.push({
          id: `bulk-${Date.now()}-${index}`,
          draftId: `bulk-${Date.now()}-${index}`,
          sellerId: selectedSellerId,
          city: officialCity.city,
          state: officialCity.state,
          ibgeCode: officialCity.ibgeCode ?? null,
          isNew: true
        });
      });

      setBulkErrors(errors);
      if (drafts.length > 0) toast.success(`${drafts.length} cidade(s) adicionada(s) ao rascunho.`);
      if (errors.length > 0) toast.warning(`${errors.length} item(ns) do lote precisam de ajuste.`);
      return [...current, ...drafts].sort((a, b) => a.state.localeCompare(b.state) || a.city.localeCompare(b.city, "pt-BR"));
    });
    setBulkText("");
  };

  const removeCityFromDraft = (draftId: string) => {
    if (!canEditSelectedSeller) return;
    setCities((current) => current.filter((city) => city.draftId !== draftId));
  };

  const saveChanges = async () => {
    if (!selectedSellerId || !canEditSelectedSeller) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        cities: cities.map((city) => ({ city: city.city, state: city.state, ibgeCode: city.ibgeCode || undefined }))
      };
      const { data } = await api.put<TerritoryCity[]>(`/territories/config/sellers/${selectedSellerId}/cities`, payload);
      setCities(data.map((city) => ({ ...city, draftId: city.id })));
      toast.success("Território comercial salvo com sucesso.");
    } catch (err) {
      setError(getApiErrorMessage(err, "Não foi possível salvar o território comercial."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div id="territorios-comerciais" className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1 text-xs font-bold uppercase tracking-wide text-brand-700">
            <MapPinned size={14} /> Territórios Comerciais
          </div>
          <h2 className="mt-3 text-xl font-bold text-slate-900">Cidades de atuação por vendedor</h2>
          <p className="mt-1 text-sm text-slate-500">Defina cidades de atuação por vendedor usando o vínculo SellerTerritoryCity.</p>
        </div>
        <div className="rounded-2xl bg-amber-50 p-3 text-xs text-amber-800 ring-1 ring-amber-100">
          <strong>TODO técnico:</strong> futuramente importar .kml/.kmz, reconhecer cores/regiões e vincular cada região ao vendedor.
        </div>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle size={18} /> {error}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
        <aside className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <label className="block text-sm font-semibold text-slate-700">
            Vendedor
            <select
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm disabled:bg-slate-100"
              value={selectedSellerId}
              onChange={(event) => setSelectedSellerId(event.target.value)}
              disabled={isSellerViewer || loading}
            >
              {sellers.map((seller) => (
                <option key={seller.id} value={seller.id}>{seller.name}{seller.region ? ` • ${seller.region}` : ""}</option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-3 gap-2 rounded-xl bg-white p-3 text-center ring-1 ring-slate-200">
            {ufOptions.map((uf) => (
              <div key={uf}>
                <p className="text-xs font-semibold text-slate-500">{uf}</p>
                <p className="text-lg font-bold text-slate-900">{totalByUf[uf] ?? 0}</p>
              </div>
            ))}
          </div>

          {!canEditSelectedSeller ? (
            <div className="rounded-xl bg-slate-100 p-3 text-xs text-slate-600">
              Seu perfil permite apenas visualizar este território. Alterações são restritas a Diretor/Gerente conforme escopo da equipe.
            </div>
          ) : null}

          <div className="space-y-3 opacity-100">
            <div className="grid gap-2 sm:grid-cols-[1fr_84px]">
              <label className="text-sm font-semibold text-slate-700">
                Cidade
                <input
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm disabled:bg-slate-100"
                  value={newCity}
                  onChange={(event) => setNewCity(event.target.value)}
                  placeholder={newCityPlaceholder}
                  list="official-territory-cities"
                  disabled={!canEditSelectedSeller || !newState || loadingOfficialCities}
                />
                <datalist id="official-territory-cities">
                  {officialCities.map((city) => (
                    <option key={`${city.state}-${city.ibgeCode ?? city.city}`} value={city.city}>{city.city}/{city.state}</option>
                  ))}
                </datalist>
                {newCity && !selectedOfficialCity ? (
                  <span className="mt-1 block text-xs font-semibold text-amber-700">Selecione uma cidade oficial da lista.</span>
                ) : null}
              </label>
              <label className="text-sm font-semibold text-slate-700">
                UF
                <select
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm disabled:bg-slate-100"
                  value={newState}
                  onChange={(event) => setNewState(event.target.value)}
                  disabled={!canEditSelectedSeller}
                >
                  <option value="">UF</option>
                  {ufOptions.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
                </select>
              </label>
            </div>
            <label className="block text-sm font-semibold text-slate-700">
              Código IBGE
              <input
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 disabled:bg-slate-100"
                value={selectedOfficialCity?.ibgeCode ?? ""}
                placeholder="Preenchido automaticamente quando disponível"
                disabled
                readOnly
              />
            </label>
            <button
              type="button"
              onClick={addCityToDraft}
              disabled={!canEditSelectedSeller || !selectedOfficialCity}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              <Plus size={16} /> Adicionar cidade
            </button>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-semibold text-slate-700">
              Cadastro rápido em lote
              <textarea
                className="mt-1 min-h-[128px] w-full rounded-xl border border-slate-200 px-3 py-2 text-sm disabled:bg-slate-100"
                value={bulkText}
                onChange={(event) => setBulkText(event.target.value)}
                placeholder={"Toledo/PR\nCascavel/PR\nPonta Porã/MS"}
                disabled={!canEditSelectedSeller}
              />
            </label>
            <button
              type="button"
              onClick={addBulkCitiesToDraft}
              disabled={!canEditSelectedSeller || allOfficialCities.length === 0}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
            >
              <Upload size={16} /> Processar lote
            </button>
            {bulkErrors.length > 0 ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                <p className="font-bold">Itens não adicionados:</p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {bulkErrors.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}
                </ul>
              </div>
            ) : null}
          </div>
        </aside>

        <section className="space-y-4">
          <div className="grid gap-3 rounded-2xl border border-slate-200 p-3 sm:grid-cols-[1fr_140px_auto]">
            <label className="relative block text-sm font-semibold text-slate-700">
              Buscar cidade por nome
              <Search className="pointer-events-none absolute bottom-2.5 left-3 text-slate-400" size={16} />
              <input
                className="mt-1 w-full rounded-xl border border-slate-200 py-2 pl-9 pr-3 text-sm"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Toledo, Cascavel..."
              />
            </label>
            <label className="block text-sm font-semibold text-slate-700">
              Filtrar por UF
              <select
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                value={ufFilter}
                onChange={(event) => setUfFilter(event.target.value)}
              >
                <option value="">Todas</option>
                {ufOptions.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
              </select>
            </label>
            <button
              type="button"
              onClick={saveChanges}
              disabled={!canEditSelectedSeller || saving}
              className="inline-flex items-end justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300 sm:self-end"
            >
              <Save size={16} /> {saving ? "Salvando..." : "Salvar alterações"}
            </button>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-4 py-3">
              <h3 className="text-sm font-bold text-slate-900">Cidades já vinculadas</h3>
              <span className="text-xs font-semibold text-slate-500">{filteredCities.length} de {cities.length}</span>
            </div>
            <div className="max-h-[560px] overflow-auto">
              <table className="min-w-full divide-y divide-slate-100 text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-left text-xs font-bold uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Cidade</th>
                    <th className="px-4 py-3">UF</th>
                    <th className="px-4 py-3">Código IBGE</th>
                    <th className="px-4 py-3 text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loading ? (
                    <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-500">Carregando cidades...</td></tr>
                  ) : filteredCities.length === 0 ? (
                    <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-500">Nenhuma cidade encontrada para os filtros.</td></tr>
                  ) : filteredCities.map((city) => (
                    <tr key={city.draftId} className={city.isNew ? "bg-emerald-50/40" : "bg-white"}>
                      <td className="px-4 py-3 font-semibold text-slate-900">{city.city}</td>
                      <td className="px-4 py-3 text-slate-700">{city.state}</td>
                      <td className="px-4 py-3 text-slate-500">{city.ibgeCode || "—"}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => removeCityFromDraft(city.draftId)}
                          disabled={!canEditSelectedSeller}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-slate-300"
                        >
                          <Trash2 size={14} /> Remover
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
