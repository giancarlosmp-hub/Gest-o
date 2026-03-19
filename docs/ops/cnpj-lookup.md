# Operação da integração de consulta por CNPJ

A integração de CNPJ é resolvida **somente no backend**. O frontend continua chamando apenas o endpoint interno `GET /clients/cnpj-lookup/:cnpj` e não deve receber segredo algum.

## Como a configuração chega ao serviço `api`

No `docker-compose.yml`, o serviço `api` recebe estas variáveis por `environment`, com interpolation do `.env` da stack e fallback seguro para BrasilAPI:

- `CNPJ_LOOKUP_PROVIDER=${CNPJ_LOOKUP_PROVIDER:-brasilapi}`
- `CNPJ_LOOKUP_BASE_URL=${CNPJ_LOOKUP_BASE_URL:-https://brasilapi.com.br/api/cnpj/v1}`
- `CNPJ_LOOKUP_API_KEY=${CNPJ_LOOKUP_API_KEY:-}`

Isso garante que, após um redeploy, a API sempre suba com um provider explícito e com `base_url` resolvida para o caso padrão.

## Configuração recomendada para BrasilAPI

No `.env` usado pela stack em produção/VPS:

```bash
CNPJ_LOOKUP_PROVIDER=brasilapi
CNPJ_LOOKUP_BASE_URL=https://brasilapi.com.br/api/cnpj/v1
CNPJ_LOOKUP_API_KEY=
```

- `CNPJ_LOOKUP_PROVIDER`: obrigatório para habilitar o lookup.
- `CNPJ_LOOKUP_BASE_URL`: obrigatório na prática para previsibilidade operacional da stack; o compose já fornece o valor padrão da BrasilAPI.
- `CNPJ_LOOKUP_API_KEY`: opcional e normalmente vazio para BrasilAPI.

## Exemplo com provider genérico

```bash
CNPJ_LOOKUP_PROVIDER=generic
CNPJ_LOOKUP_BASE_URL=https://api.seu-provedor.com/cnpj/{cnpj}
CNPJ_LOOKUP_API_KEY=seu-token-aqui
```

## Redeploy seguro

1. Atualize apenas o `.env` da stack.
2. Opcionalmente, valide a resolução com `docker compose config | grep CNPJ_LOOKUP`.
3. Execute `bash deploy.sh`.
4. Não use `docker compose down -v`, não apague volumes e não rode reset de banco.

## Validação automática no deploy

O `deploy.sh` agora executa uma checagem antes do rebuild para confirmar que o `docker compose config` resolveu as variáveis `CNPJ_LOOKUP_*` dentro do serviço `api`.

Comportamento esperado:
- `brasilapi`: exige `provider` e `base_url`; `api_key` pode ficar vazia.
- `generic`: exige `provider` e `base_url`; `api_key` continua opcional, dependendo do provedor.
- provider fora dos suportados: o deploy falha antes de subir containers com configuração inválida.
