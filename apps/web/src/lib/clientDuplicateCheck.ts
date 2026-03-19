import api from "./apiClient";
import { formatCnpj, normalizeCnpjDigits } from "./cnpj";

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

type ClientDuplicateCheckResponse = {
  exists: boolean;
  matchType: DuplicateClientMatchType | null;
  message?: string;
  existingClient: ExistingClientSummary | null;
};

const formatExistingClientLabel = (client: ExistingClientSummary) => {
  const location = client.city && client.state ? ` (${client.city}/${client.state})` : "";
  const document = client.cnpj ? ` · CNPJ ${formatCnpj(client.cnpj)}` : "";
  return `${client.name}${location}${document}`;
};

export const buildDuplicateClientMessage = (response: Pick<ClientDuplicateCheckResponse, "existingClient" | "matchType" | "message">) => {
  if (response.message) return response.message;
  if (!response.existingClient) return "Cliente já cadastrado no sistema.";

  const clientLabel = formatExistingClientLabel(response.existingClient);
  if (response.matchType === "cnpj") {
    return `Já existe um cliente com este CNPJ: ${clientLabel}. Use o cadastro existente.`;
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
