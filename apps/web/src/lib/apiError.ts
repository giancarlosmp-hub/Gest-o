const FRIENDLY_BY_STATUS: Record<number, string> = {
  400: "Não foi possível concluir a solicitação.",
  401: "Sua sessão expirou. Faça login novamente.",
  403: "Você não tem permissão para executar esta ação.",
  404: "Recurso não encontrado.",
  408: "A solicitação demorou mais que o esperado. Tente novamente.",
  409: "Conflito de dados. Atualize a página e tente novamente.",
  429: "Muitas requisições no momento. Aguarde alguns segundos.",
  500: "Ocorreu um erro interno. Tente novamente em instantes.",
  502: "Serviço temporariamente indisponível. Tente novamente.",
  503: "Serviço temporariamente indisponível. Tente novamente.",
  504: "Tempo de resposta esgotado. Tente novamente.",
};

export function getApiErrorMessage(error: unknown, fallbackMessage: string) {
  const maybeAxiosError = error as {
    response?: { status?: number };
  };

  const status = maybeAxiosError.response?.status;

  if (!status) {
    return fallbackMessage;
  }

  return FRIENDLY_BY_STATUS[status] || fallbackMessage;
}
