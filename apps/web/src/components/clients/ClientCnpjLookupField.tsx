import { useEffect, useMemo, useRef, useState } from "react";
import api from "../../lib/apiClient";

export type CnpjLookupPayload = {
  cnpj: string;
  razaoSocial?: string | null;
  nome?: string | null;
  nomeFantasia?: string | null;
  cidade?: string | null;
  uf?: string | null;
  [key: string]: unknown;
};

type ClientCnpjLookupFieldProps = {
  id?: string;
  label?: string;
  value?: string | null;
  className?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  helperText?: string;
  onChange: (value: string) => void;
  onLookupApply: (fields: Record<string, unknown>, payload: CnpjLookupPayload) => void;
  mapLookupToFields?: (payload: CnpjLookupPayload) => Record<string, unknown>;
};

const LOOKUP_DEBOUNCE_MS = 500;

const normalizeCnpjDigits = (value: string | null | undefined) => String(value ?? "").replace(/\D/g, "").slice(0, 14);

const formatCnpj = (value: string | null | undefined) => {
  const digits = normalizeCnpjDigits(value);

  if (digits.length <= 2) return digits;
  if (digits.length <= 5) return digits.replace(/^(\d{2})(\d+)/, "$1.$2");
  if (digits.length <= 8) return digits.replace(/^(\d{2})(\d{3})(\d+)/, "$1.$2.$3");
  if (digits.length <= 12) return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d+)/, "$1.$2.$3/$4");
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
};

const getClientNameFromLookup = (payload: CnpjLookupPayload) => payload.nomeFantasia || payload.razaoSocial || payload.nome || "";

export default function ClientCnpjLookupField({
  id,
  label = "CNPJ",
  value,
  className = "w-full rounded-lg border border-slate-300 p-2 text-slate-800",
  required = false,
  disabled = false,
  error,
  helperText,
  onChange,
  onLookupApply,
  mapLookupToFields
}: ClientCnpjLookupFieldProps) {
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupMessage, setLookupMessage] = useState<string | null>(null);
  const lastAutoLookupDigitsRef = useRef<string | null>(null);
  const latestDigitsRef = useRef<string>(normalizeCnpjDigits(value));

  const digits = useMemo(() => normalizeCnpjDigits(value), [value]);
  const formattedValue = useMemo(() => formatCnpj(value), [value]);
  const canLookup = digits.length === 14;
  const shouldShowFieldError = Boolean(error && error !== lookupError);

  useEffect(() => {
    latestDigitsRef.current = digits;

    if (digits.length === 0) {
      setLookupError(null);
      setLookupMessage(null);
      lastAutoLookupDigitsRef.current = null;
      return;
    }

    if (digits.length < 14) {
      setLookupError(null);
      setLookupMessage(null);
      return;
    }

    if (lastAutoLookupDigitsRef.current === digits) return;

    const timeoutId = window.setTimeout(() => {
      void performLookup(digits, true);
    }, LOOKUP_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [digits]);

  const performLookup = async (targetDigits: string, isAutomatic = false) => {
    if (targetDigits.length !== 14) {
      setLookupError("Informe um CNPJ com 14 dígitos para consultar.");
      setLookupMessage(null);
      return;
    }

    setIsLookingUp(true);
    setLookupError(null);
    if (!isAutomatic) setLookupMessage(null);

    try {
      const response = await api.get(`/clients/cnpj-lookup/${targetDigits}`);
      const payload = (response.data?.data ?? {}) as CnpjLookupPayload;
      const nextCnpj = payload.cnpj || formatCnpj(targetDigits);
      const autoFilledFields = {
        cnpj: nextCnpj,
        name: getClientNameFromLookup(payload) || undefined,
        city: payload.cidade || undefined,
        state: payload.uf ? String(payload.uf).toUpperCase() : undefined,
        ...(mapLookupToFields ? mapLookupToFields(payload) : {})
      };

      onChange(nextCnpj);
      onLookupApply(autoFilledFields, payload);
      setLookupMessage("Dados do CNPJ preenchidos automaticamente. Você ainda pode editar os campos manualmente.");
      setLookupError(null);
      lastAutoLookupDigitsRef.current = targetDigits;
    } catch (lookupError: any) {
      const errorMessage = lookupError?.response?.data?.message || lookupError?.message || "Não foi possível consultar o CNPJ.";
      setLookupError(errorMessage);
      setLookupMessage(null);
      if (!isAutomatic) lastAutoLookupDigitsRef.current = null;
    } finally {
      if (latestDigitsRef.current === targetDigits) {
        setIsLookingUp(false);
      }
    }
  };

  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-slate-700" htmlFor={id}>
        {label}{required ? " *" : ""}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <input
          id={id}
          required={required}
          disabled={disabled}
          className={`${className} sm:flex-1`}
          type="text"
          inputMode="numeric"
          placeholder="00.000.000/0000-00"
          value={formattedValue}
          onChange={(event) => {
            const nextValue = formatCnpj(event.target.value);
            onChange(nextValue);
            setLookupError(null);
            setLookupMessage(null);
            if (normalizeCnpjDigits(nextValue) !== lastAutoLookupDigitsRef.current) {
              lastAutoLookupDigitsRef.current = null;
            }
          }}
        />
        <button
          type="button"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => void performLookup(digits, false)}
          disabled={disabled || isLookingUp || !canLookup}
        >
          {isLookingUp ? "Buscando..." : lookupMessage ? "Buscar novamente" : "Buscar CNPJ"}
        </button>
      </div>
      {lookupError ? <p className="text-xs text-rose-600">{lookupError}</p> : null}
      {!lookupError && lookupMessage ? <p className="text-xs text-emerald-700">{lookupMessage}</p> : null}
      {!lookupError && !lookupMessage && helperText ? <p className="text-xs text-slate-500">{helperText}</p> : null}
      {!lookupError && !lookupMessage && isLookingUp ? <p className="text-xs text-slate-500">Consultando dados do CNPJ...</p> : null}
      {shouldShowFieldError ? <p className="text-xs text-rose-600">{error}</p> : null}
    </div>
  );
}
