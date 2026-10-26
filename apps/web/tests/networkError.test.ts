import assert from "node:assert/strict";
import fs from "node:fs";
import { AxiosError, CanceledError } from "axios";
import { shouldWarnServerUnavailable } from "../src/lib/networkError.js";

// Dados fictícios: erros do axios de cada caso, como o adaptador do navegador os cria.
const config = { url: "/rota-ficticia", headers: {} } as any;
const abortedController = new AbortController();
abortedController.abort();

// Cancelamento: AbortController/CancelToken (isCancel e ERR_CANCELED) e sinal já abortado.
assert.equal(shouldWarnServerUnavailable(new CanceledError(undefined, config)), false, "cancelamento (isCancel)");
assert.equal(shouldWarnServerUnavailable({ code: "ERR_CANCELED", message: "canceled" }), false, "ERR_CANCELED");
assert.equal(
  shouldWarnServerUnavailable(new AxiosError("Network Error", "ERR_NETWORK", { ...config, signal: abortedController.signal })),
  false,
  "sinal da requisição abortado"
);

// Abort do navegador (navegação, aba fechada).
assert.equal(shouldWarnServerUnavailable(new AxiosError("Request aborted", "ECONNABORTED", config)), false, "abort do navegador");

// Queda real de rede e tempo esgotado continuam avisando.
assert.equal(shouldWarnServerUnavailable(new AxiosError("Network Error", "ERR_NETWORK", config)), true, "queda de rede");
assert.equal(shouldWarnServerUnavailable(new AxiosError("timeout of 15000ms exceeded", "ECONNABORTED", config)), true, "tempo esgotado");
assert.equal(shouldWarnServerUnavailable(new AxiosError("timeout of 15000ms exceeded", "ETIMEDOUT", config)), true, "tempo esgotado (ETIMEDOUT)");
assert.equal(
  shouldWarnServerUnavailable(new AxiosError("Network Error", "ERR_NETWORK", { ...config, signal: new AbortController().signal })),
  true,
  "sinal não abortado não esconde a queda de rede"
);

// Com resposta do servidor não é falha de rede (o 429 e o 401 têm tratamento próprio).
const withResponse = new AxiosError("Erro ficticio", "ERR_BAD_RESPONSE", config, undefined, { status: 500, data: {}, statusText: "", headers: {}, config } as any);
assert.equal(shouldWarnServerUnavailable(withResponse), false, "erro com resposta");
assert.equal(shouldWarnServerUnavailable(undefined), false);

const apiClient = fs.readFileSync(new URL("../src/lib/apiClient.ts", import.meta.url), "utf8");
assert.match(apiClient, /const isNetworkError = shouldWarnServerUnavailable\(error\);/, "o interceptor usa a regra");
assert.match(apiClient, /if \(isNetworkError\) \{\n\s+toast\.error\("Servidor indisponível\. Verifique conexão\."/, "o aviso continua o mesmo");

console.log("NETWORK_ERROR_WARNING=PASS");
