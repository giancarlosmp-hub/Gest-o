import { useEffect, useState } from "react";
import { findMunicipality, loadBrazilStates, loadMunicipalities, type CatalogMunicipality } from "../../lib/clientAddressCatalog";

type Props = {
  idPrefix: string;
  state: string;
  city: string;
  onChange: (address: { state: string; city: string }) => void;
  selectClassName: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  // Explicação embaixo da cidade (ex.: endereço que vem do ERP, somente leitura).
  note?: string;
};

// UF e cidade do cliente escolhidas da lista oficial do IBGE (sem texto livre). Cadastro antigo com cidade fora da
// lista aparece como está, marcado, até ser trocado.
export default function ClientAddressFields({ idPrefix, state, city, onChange, selectClassName, required, disabled, error, note }: Props) {
  const [states, setStates] = useState<string[]>([]);
  const [municipalities, setMunicipalities] = useState<CatalogMunicipality[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const uf = state.trim().toUpperCase();

  useEffect(() => {
    let active = true;
    loadBrazilStates().then((list) => active && setStates(list)).catch(() => active && setLoadError(true));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setMunicipalities([]);
    if (!uf) return undefined;
    setLoading(true);
    loadMunicipalities(uf)
      .then((list) => active && setMunicipalities(list))
      .catch(() => active && setLoadError(true))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [uf]);

  const official = findMunicipality(municipalities, city);
  const outsideList = Boolean(city.trim()) && !loading && municipalities.length > 0 && !official;
  const selectedCity = official?.city ?? (outsideList ? city : "");

  return (
    <>
      <div className="space-y-1">
        <label className="block text-sm font-medium text-slate-700" htmlFor={`${idPrefix}-state`}>UF</label>
        <select
          id={`${idPrefix}-state`}
          required={required}
          disabled={disabled}
          className={selectClassName}
          value={uf}
          onChange={(event) => onChange({ state: event.target.value, city: "" })}
        >
          <option value="">Selecione a UF</option>
          {uf && !states.includes(uf) && states.length ? <option value={uf}>{uf} (fora da lista oficial)</option> : null}
          {states.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <label className="block text-sm font-medium text-slate-700" htmlFor={`${idPrefix}-city`}>Cidade</label>
        <select
          id={`${idPrefix}-city`}
          required={required}
          disabled={disabled || !uf || loading}
          className={selectClassName}
          value={selectedCity}
          onChange={(event) => onChange({ state: uf, city: event.target.value })}
        >
          <option value="">{!uf ? "Escolha a UF primeiro" : loading ? "Carregando cidades…" : "Selecione a cidade"}</option>
          {outsideList ? <option value={city}>{city} (fora da lista oficial)</option> : null}
          {municipalities.map((item) => <option key={item.ibgeCode} value={item.city}>{item.city}</option>)}
        </select>
        {outsideList && !disabled ? <p className="text-xs text-amber-700">Cidade fora da lista oficial do IBGE para {uf}: escolha a cidade certa.</p> : null}
        {note ? <p className="text-xs text-slate-500">{note}</p> : null}
        {loadError ? <p className="text-xs text-rose-600">Não foi possível carregar a lista de cidades.</p> : null}
        {error ? <p className="text-xs text-rose-600">{error}</p> : null}
      </div>
    </>
  );
}
