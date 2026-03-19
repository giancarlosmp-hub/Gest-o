import api from "./apiClient";
import { normalizeCnpjDigits } from "./cnpj";

export type DuplicateClientMatchType = "cnpj" | "identity";

export type ExistingClientSummary = {
  id: string;
  name: string;
  city?: string | null;
  state?: string | null;
  cnpj?: string | null;
};

export type ClientDuplicateCheckPayload = {
  name?: string;
  city?: string;
  state?: string;
  cnpj?: string;
  ignoreClientId?: string;
};

export type ClientDuplicateCheckResponse = {
  exists: boolean;
  matchType: DuplicateClientMatchType | null;
  message?: string;
  existingClient: ExistingClientSummary | null;
};

const formatExistingClientLabel = (client: ExistingClientSummary) => {
  const location = client.city && client.state ? ` (${client.city}/${client.state})` : "";
  return `${client.name}${location}`;
};

export const buildDuplicateClientMessage = (response: Pick<ClientDuplicateCheckResponse, "existingClient" | "matchType" | "message">) => {
  if (response.message) return response.message;
  if (!response.existingClient) return "Cliente já cadastrado no sistema.";

  const clientLabel = formatExistingClientLabel(response.existingClient);
  if (response.matchType === "cnpj") {
    return `Já existe um cliente com este CNPJ: ${clientLabel}.`;
  }

  return `Já existe um cliente compatível: ${clientLabel}. Revise o cadastro antes de salvar.`;
};

export const checkClientDuplicate = async (payload: ClientDuplicateCheckPayload) => {
  const response = await api.post<ClientDuplicateCheckResponse>("/clients/check-duplicate", {
    ...payload,
    cnpj: normalizeCnpjDigits(payload.cnpj),
    state: payload.state?.trim().toUpperCase()
  });

  return response.data;
};


export class DuplicateClientCheckError extends Error {
  existingClient: ExistingClientSummary | null;
  matchType: DuplicateClientMatchType | null;

  constructor(response: Pick<ClientDuplicateCheckResponse, "existingClient" | "matchType" | "message">) {
    super(buildDuplicateClientMessage(response));
    this.name = "DuplicateClientCheckError";
    this.existingClient = response.existingClient ?? null;
    this.matchType = response.matchType ?? null;
  }
}

export const findDuplicateClientByLookupPayload = async (payload: { cnpj: string; name?: string; city?: string; state?: string }) => {
  const duplicateCheck = await checkClientDuplicate({
    cnpj: payload.cnpj,
    name: payload.name,
    city: payload.city,
    state: payload.state
  });

  return duplicateCheck.exists ? duplicateCheck : null;
};
