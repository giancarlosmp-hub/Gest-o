# Setup de variáveis de produção — ERP UltraFV3

Este guia descreve **onde** e **como** configurar, com segurança, as variáveis exigidas para integração ERP em produção, sem expor segredos no repositório.

## Variáveis obrigatórias

Configure no ambiente da API:

- `ERP_CREDENTIAL_ENCRYPTION_KEY`
- `ULTRAFV3_BASE_URL`
- `ULTRAFV3_USERNAME`
- `ULTRAFV3_PASSWORD`

## Onde configurar no projeto

### 1) Docker Compose (produção)

O `docker-compose.yml` injeta variáveis no serviço `api` usando `${NOME_DA_VARIAVEL}`. Isso significa que os valores devem existir no ambiente do host ou no arquivo `.env` do diretório de deploy (ex.: `/apps/gest-o/.env`).

### 2) Arquivo `.env`

No servidor, use o arquivo `.env` **local da VPS** (não versionado) para armazenar segredos de produção.

- Caminho típico: `/apps/gest-o/.env`
- **Nunca** commitar esse arquivo com valores reais.

### 3) Scripts de deploy

- `deploy.sh` usa `docker compose` para rebuild/restart e, portanto, consome as variáveis já presentes no `.env` do servidor.
- `deploy-reset.sh` também usa `docker compose`, mas reseta volumes (não usar em produção normal).

### 4) GitHub Actions

O workflow de produção (`.github/workflows/deploy-prod.yml`) executa deploy remoto via SSH e roda `docker compose up -d --build api web` no servidor.

Ele **não** escreve segredos ERP no servidor. Portanto, as variáveis precisam já estar no `.env` da VPS antes do deploy.

### 5) Servidor/VPS

Fonte real de produção: arquivo `.env` no diretório do projeto em produção (ex.: `/apps/gest-o/.env`).

## Requisitos de segurança

### `ERP_CREDENTIAL_ENCRYPTION_KEY`

- Deve ser uma chave longa e secreta (recomendado: 32+ bytes aleatórios em Base64/hex).
- Use chave forte gerada no servidor.
- Não commitar em Git, não enviar em PR e não publicar em docs públicos.

Exemplo para gerar na VPS:

```bash
openssl rand -base64 48
```

## `ULTRAFV3_BASE_URL`

- Deve apontar para a API UltraFV3 disponível no servidor local/Windows.
- A porta esperada é **8585**.

Exemplo com Tailscale:

```env
ULTRAFV3_BASE_URL=http://100.74.230.16:8585
```

## Exemplo seguro de `.env` na VPS (sem segredo real)

```env
ERP_CREDENTIAL_ENCRYPTION_KEY=<gerar_valor_forte_unico>
ULTRAFV3_BASE_URL=http://100.74.230.16:8585
ULTRAFV3_USERNAME=<usuario_ultrafv3>
ULTRAFV3_PASSWORD=<senha_ultrafv3>
```

## Comandos de deploy no servidor

No servidor, dentro de `/apps/gest-o`:

1) Editar `.env` com as variáveis:

```bash
cd /apps/gest-o
nano .env
```

2) Validar resolução das variáveis no compose:

```bash
docker compose config | grep -E 'ERP_CREDENTIAL_ENCRYPTION_KEY|ULTRAFV3_BASE_URL|ULTRAFV3_USERNAME|ULTRAFV3_PASSWORD'
```

3) Rebuild/restart de API e WEB após alteração de variáveis:

```bash
docker compose up -d --build api web
```

4) Conferir status:

```bash
docker compose ps
```

5) Conferir logs da API se necessário:

```bash
docker compose logs --tail=200 api
```

> Evite `docker compose down -v` em produção para não apagar volumes/dados.

## Validação funcional no CRM

Após subir os containers:

1. Acesse o CRM com usuário administrador.
2. Vá em **Configurações > Integração ERP**.
3. Valide que:
   - `ERP_CREDENTIAL_ENCRYPTION_KEY` aparece como configurada (criptografia ativa).
   - `ULTRAFV3_BASE_URL`, `ULTRAFV3_USERNAME` e `ULTRAFV3_PASSWORD` não estão ausentes.
4. Execute o teste de conexão/sincronização da integração ERP e confirme ausência de erro de variáveis obrigatórias.

## Checklist rápido

- [ ] Variáveis ERP configuradas no `/apps/gest-o/.env` da VPS.
- [ ] Nenhum segredo real commitado no repositório.
- [ ] `docker compose up -d --build api web` executado após ajuste.
- [ ] Painel **Configurações > Integração ERP** validado sem erro de variáveis ausentes.
