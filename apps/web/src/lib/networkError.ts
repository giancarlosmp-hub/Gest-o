import { isCancel } from "axios";

type RequestErrorLike = {
  response?: unknown;
  code?: string;
  message?: string;
  config?: { signal?: { aborted?: boolean } };
};

// Mensagem do axios quando o navegador aborta a requisição (navegação, aba fechada). O tempo esgotado usa o
// mesmo código (ECONNABORTED) com outra mensagem ("timeout of ...ms exceeded") e continua avisando.
const BROWSER_ABORT_MESSAGE = "Request aborted";

// "Servidor indisponível" só para falha sem resposta do servidor: queda de rede ou tempo esgotado.
// Cancelamento (AbortController, CancelToken) e abort do navegador não são falha de rede.
export const shouldWarnServerUnavailable = (error: unknown) => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as RequestErrorLike;
  if (candidate.response) return false;
  if (isCancel(error) || candidate.code === "ERR_CANCELED" || candidate.config?.signal?.aborted) return false;
  if (candidate.code === "ECONNABORTED" && candidate.message === BROWSER_ABORT_MESSAGE) return false;
  return true;
};
