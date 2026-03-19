import { useEffect, useState } from "react";
import type { AxiosError } from "axios";
import api from "../../lib/apiClient";
import { formatCnpj, isValidCnpj, normalizeCnpjDigits } from "../../lib/cnpj";

type CnpjLookupResponse = {
  data?: {
    cnpj?: string | null;
    razaoSocial?: string | null;
    nome?: string | null;
    nomeFantasia?: string | null;
    cidade?: string | null;
    uf?: string | null;
  };
};

type ClientCnpjLookupFieldProps = {
  value: string;
  onChange: (value: string) => void;
  onLookupSuccess: (payload: { cnpj: string; name: string; city: string; state: string }) => void;
  cnpjLookupError: string | null;
  setCnpjLookupError: (value: string | null) => void;
  disabled?: boolean;
  className?: string;
  lookupButtonLabel?: string;
};

const resolveCnpjLookupErrorMessage = (error: AxiosError<{ message?: string; code?: string }>) => {
  const backendMessage = String(error.response?.data?.message || "").trim();
  const errorCode = error.response?.data?.code;
  const normalizedMessage = backendMessage.toLowerCase();

  if (errorCode === "INVALID_CNPJ") return "Informe um CNPJ válido para realizar a busca automática.";
  if (errorCode === "CNPJ_LOOKUP_NOT_FOUND") return "Empresa não encontrada para o CNPJ informado.";
  if (normalizedMessage.includes("não encontrada") || normalizedMessage.includes("nao encontrada") || normalizedMessage.includes("not found")) {
    return "Empresa não encontrada para o CNPJ informado.";
  }
  if (errorCode === "CNPJ_LOOKUP_DISABLED") {
    return "A integração de CNPJ não está habilitada no backend.";
  }
  if (errorCode === "CNPJ_LOOKUP_MISCONFIGURED" || errorCode === "CNPJ_LOOKUP_UNSUPPORTED_PROVIDER") {
    return backendMessage || "A integração de CNPJ está configurada incorretamente no backend.";
  }
  if (errorCode === "CNPJ_LOOKUP_PROVIDER_UNAVAILABLE") {
    return "O provedor de CNPJ está indisponível no momento. Tente novamente em instantes.";
  }
  if (errorCode === "CNPJ_LOOKUP_PROVIDER_ERROR") {
    return backendMessage || "Não foi possível consultar o CNPJ no momento. Tente novamente em instantes.";
  }

  return backendMessage || "Não foi possível consultar o CNPJ no momento. Tente novamente em instantes.";
};

export default function ClientCnpjLookupField({
  value,
  onChange,
  onLookupSuccess,
  cnpjLookupError,
  setCnpjLookupError,
  disabled = false,
  className = "w-full rounded-lg border border-slate-200 p-2",
  lookupButtonLabel = "Buscar CNPJ"
}: ClientCnpjLookupFieldProps) {
  const cnpjDigits = normalizeCnpjDigits(value);
  const canLookupCnpj = isValidCnpj(cnpjDigits);
  const showInvalidCnpjHint = cnpjDigits.length === 14 && !canLookupCnpj;
  const [isLookingUpCnpj, setIsLookingUpCnpj] = useState(false);
  const [lookupSuccessMessage, setLookupSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!value) {
      setLookupSuccessMessage(null);
    }
  }, [value]);

  async function handleCnpjLookup() {
    if (!canLookupCnpj || isLookingUpCnpj || disabled) return;

    setCnpjLookupError(null);
    setLookupSuccessMessage(null);
    setIsLookingUpCnpj(true);

    try {
      const response = await api.get<CnpjLookupResponse>(`/clients/cnpj-lookup/${cnpjDigits}`);
      const lookupData = response.data?.data;
      const nextCnpj = lookupData?.cnpj ? formatCnpj(lookupData.cnpj) : formatCnpj(cnpjDigits);
      const nextName = String(lookupData?.razaoSocial || lookupData?.nomeFantasia || lookupData?.nome || "").trim();
      const nextCity = String(lookupData?.cidade || "").trim();
      const nextState = String(lookupData?.uf || "").trim().toUpperCase();

      onLookupSuccess({
        cnpj: nextCnpj,
        name: nextName,
        city: nextCity,
        state: nextState
      });

      setLookupSuccessMessage("CNPJ localizado com sucesso. Revise os dados preenchidos automaticamente.");
    } catch (error) {
      setLookupSuccessMessage(null);
      setCnpjLookupError(resolveCnpjLookupErrorMessage(error as AxiosError<{ message?: string; code?: string }>));
    } finally {
      setIsLookingUpCnpj(false);
    }
  }

  return (
    <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className={className}
          placeholder="Informe o CNPJ para preencher automaticamente"
          value={value}
          onChange={(event) => {
            const digits = normalizeCnpjDigits(event.target.value);
            setCnpjLookupError(null);
            setLookupSuccessMessage(null);
            onChange(digits.length <= 14 ? formatCnpj(digits) : event.target.value);
          }}
        />
        <button
          type="button"
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-70"
          onClick={handleCnpjLookup}
          disabled={disabled || isLookingUpCnpj || !canLookupCnpj}
        >
          {isLookingUpCnpj ? "Buscando..." : lookupButtonLabel}
        </button>
      </div>
      <div className="mt-2 space-y-1">
        <p className="text-xs text-slate-600">A busca automática funciona apenas para CNPJ válido.</p>
        {isLookingUpCnpj ? <p className="text-xs text-brand-700">Consultando os dados do CNPJ...</p> : null}
        {showInvalidCnpjHint ? <p className="text-xs text-amber-700">Informe um CNPJ válido para habilitar a busca automática.</p> : null}
        {lookupSuccessMessage ? <p className="text-xs text-emerald-700">{lookupSuccessMessage}</p> : null}
        {cnpjLookupError ? <p className="text-xs text-rose-600">{cnpjLookupError}</p> : null}
      </div>
    </div>
  );
}
