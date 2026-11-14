// Aviso geral do 429 ("Muitas requisições"). Uma tela que já mostra o 429 no próprio lugar (ex.: campo de resposta
// do WhatsApp) passa `skipRateLimitToast: true` na requisição para não repetir o aviso. A pausa geral continua.

declare module "axios" {
  interface AxiosRequestConfig {
    /** Não mostrar o aviso geral do 429: a tela mostra o erro no próprio lugar. */
    skipRateLimitToast?: boolean;
  }
}

/** Mostra o aviso geral do 429, salvo quando a requisição pediu para não mostrar. */
export const shouldShowRateLimitToast = (config: { skipRateLimitToast?: boolean } | null | undefined) => config?.skipRateLimitToast !== true;
