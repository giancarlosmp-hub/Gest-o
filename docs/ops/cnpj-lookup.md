# Operação da integração de consulta por CNPJ

## Objetivo
Garantir que o container `api` receba as variáveis de ambiente da integração de consulta por CNPJ sem alterar banco, schema, migrations ou dados existentes.

## Como o projeto carrega essas variáveis em produção
- O `docker compose` lê automaticamente o arquivo `.env` na raiz do projeto ao executar comandos como `docker compose up -d --build`.
- No `docker-compose.yml`, o serviço `api` repassa explicitamente para o container:
  - `CNPJ_LOOKUP_PROVIDER`
  - `CNPJ_LOOKUP_BASE_URL`
  - `CNPJ_LOOKUP_API_KEY`
- Dentro da API, a leitura acontece em `apps/api/src/config/env.ts`.

## Configuração recomendada para BrasilAPI
Use no `.env` da VPS:

```bash
CNPJ_LOOKUP_PROVIDER=brasilapi
CNPJ_LOOKUP_BASE_URL=https://brasilapi.com.br/api/cnpj/v1
CNPJ_LOOKUP_API_KEY=
```

Observações:
- `CNPJ_LOOKUP_API_KEY` é opcional e deve permanecer vazio para BrasilAPI.
- A API suporta URL com ou sem `{cnpj}`; com o valor acima, o backend monta a URL final anexando `/<cnpj>`.
- Essa configuração fica somente no backend. Não use `VITE_` para essas variáveis.

## Configuração para provider genérico

```bash
CNPJ_LOOKUP_PROVIDER=generic
CNPJ_LOOKUP_BASE_URL=https://api.seu-provedor.com/cnpj/{cnpj}
CNPJ_LOOKUP_API_KEY=seu-token-opcional
```

## Aplicação segura na VPS
1. Edite o arquivo `.env` da aplicação.
2. Confirme os valores acima.
3. Refaça o deploy sem destruir volumes:

```bash
bash deploy.sh
```

ou:

```bash
docker compose down
docker compose up -d --build
```

## O que não fazer
- Não executar `docker compose down -v`.
- Não apagar o volume `gest-o_pgdata`.
- Não usar `migrate reset`.
- Não alterar `schema.prisma` ou migrations para ativar a integração.
