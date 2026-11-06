# WhatsApp via Evolution API — Fase A (conexão dos números)

Cada usuário (vendedor, gerente, diretor) conecta o número comercial de WhatsApp da empresa ao CRM lendo
um QR code. A conexão usa a [Evolution API](https://github.com/EvolutionAPI/evolution-api) (não oficial,
sem navegador) num container próprio. Fica ao lado da integração oficial da Meta
([secure-omnichannel-foundation.md](secure-omnichannel-foundation.md)), sem tocar nela.

**Fase A = só infraestrutura, conexão por QR e status.** Nenhuma mensagem é lida, gravada ou enviada.
Fases seguintes: B) receber e gravar mensagens e vincular ao cliente na linha do tempo; C) responder pelo
CRM; D) resumo diário aos vendedores.

## Regras

- Só conecta se o número lido no QR for o celular cadastrado no usuário (`User.phone`, em Configurações →
  Usuários). Os dois lados passam pela regra compartilhada de telefone (`normalizeBrazilPhone`), que põe o
  nono dígito em contas antigas do WhatsApp.
- Número diferente, número ilegível (LID) ou número já conectado por outro usuário: a instância é apagada na
  hora (logout), o status vira `REJECTED_WRONG_NUMBER` e **o número lido não é gravado**.
- O QR vem do Evolution a cada consulta e **nunca é gravado**.
- O nome da instância no Evolution é opaco (`crm-` + 24 hex aleatórios): nunca telefone, nome ou id.
- Não existe rota de envio. O cliente do Evolution não tem método de envio. Nada de envio em massa.
- Desligado por padrão: só funciona com `COMMUNICATIONS_ENABLED=true` **e** `WHATSAPP_EVOLUTION_ENABLED=true`.

## Arquitetura

```
navegador ── nginx (/api/) ── api (gest-o_default, alias crm-api-internal)
                                │  HTTP + apikey             ▲ webhook interno (segredo no header)
                                ▼                            │
                    evolution-api (gest-o_default, alias crm-evolution-api; whatsapp_internal)
                                │
                    evolution-db (só whatsapp_internal, internal: true)
```

- `docker-compose.whatsapp.yml`, projeto `gest-o-whatsapp`, separado de `docker-compose.production.yml`.
  O deploy exige que o compose de produção tenha exatamente `api` e `web`; cutover e rollback só mexem
  nesses dois. O Evolution nunca é reiniciado por um deploy do CRM, e vice-versa.
- Imagens fixadas por digest: `evoapicloud/evolution-api:v2.3.7` (última estável) e
  `postgres:16.15-alpine`. Atualizar = trocar tag e digest por PR.
- Sem portas publicadas. `mem_limit` 768 MB (Evolution) e 256 MB (banco). Logs `json-file` 25 MB × 4.
- PostgreSQL próprio do Evolution, em container separado, só na rede interna: o banco do CRM, o backup, o
  preflight e o gate de schema não mudam.
- Volumes `evolution_db` e `evolution_instances`. **Fora do backup de propósito**: guardam a sessão (uma
  credencial do WhatsApp). Perder a sessão só exige ler o QR de novo. A limpeza de previews só remove
  volumes `gesto_pgdata_pr_N`; a manutenção pós-cutover só faz `builder prune`.

### O que o Evolution guarda

Só a instância (sessão). Desligados: `DATABASE_SAVE_DATA_NEW_MESSAGE`, `DATABASE_SAVE_MESSAGE_UPDATE`,
`DATABASE_SAVE_DATA_CONTACTS`, `DATABASE_SAVE_DATA_CHATS`, `DATABASE_SAVE_DATA_LABELS`,
`DATABASE_SAVE_DATA_HISTORIC`, `DATABASE_SAVE_IS_ON_WHATSAPP`. Ligado: `DATABASE_SAVE_DATA_INSTANCE`.
Também `TELEMETRY_ENABLED=false`, webhook global desligado e `LOG_LEVEL=ERROR,WARN` (o aviso de conexão do
Evolution, que traz o número, é `INFO`). A instância é criada com `syncFullHistory: false` e `groupsIgnore`.
A sessão do WhatsApp ainda recebe mensagens em memória no Evolution; elas não são gravadas nem repassadas.

## API

| Rota | Quem | O que faz |
|---|---|---|
| `GET /whatsapp/connection` | o próprio usuário | status; com QR atual enquanto aguarda leitura. Flag desligada: `{ enabled: false }` |
| `POST /whatsapp/connection` | o próprio usuário | cria a instância (ou reaproveita a que aguarda) e devolve o QR |
| `DELETE /whatsapp/connection` | o próprio usuário | logout, instância apagada, `DISCONNECTED` |
| `GET /whatsapp/connections` | diretor, gerente | status de todos, número mascarado, sem consultar o Evolution |
| `DELETE /whatsapp/connections/:userId` | diretor, gerente | desconecta qualquer usuário (registra quem) |
| `POST /webhooks/communications/evolution` | Evolution | eventos de conexão (abaixo) |

Erros: flag desligada → 404; sem chave/segredo → 503 `not_configured`; sem celular → 422 `phone_missing`;
número de outro usuário → 409 `phone_in_use`; Evolution fora do ar → 503 `evolution_unavailable`.
Também com o prefixo `/api`.

### Webhook interno

A instância é criada com webhook só de `CONNECTION_UPDATE`, apontando para
`http://crm-api-internal:4000/webhooks/communications/evolution` (alias interno na `gest-o_default`, nunca o
domínio público), com o header `x-crm-webhook-secret`. Na API, nesta ordem:

1. flag desligada → 404;
2. requisição com `X-Forwarded-For`, `X-Real-IP` ou `Forwarded` (passou pelo nginx) → 404;
3. segredo comparado com `timingSafeEqual` (sobre SHA-256) → 401;
4. corpo cru de até 64 KiB, lido como JSON só depois do segredo.

Só `connection.update` muda algo: `open` confere o número (`data.wuid`), `close` marca `DISCONNECTED`.
QR e qualquer outro evento são ignorados sem gravar nada. O corpo traz o `apikey` da instância e o número:
**nunca vai para log** (o handler de erro registra `[raw-body-redacted]` em `/webhooks/communications/*`).

A consulta `GET /whatsapp/connection` também confere o estado no Evolution: se um evento se perder, a tela
corrige sozinha.

## Tela

- `/whatsapp` (todos os perfis): cartão **Meu número** acima do assistente. Conectar, QR atualizado a cada
  5 s (só enquanto aguarda e com a aba visível), status e Desconectar. Some com a flag desligada.
- Configurações → Usuários (diretor, gerente): coluna **WhatsApp** (só com a integração ligada) e "Desconectar
  WhatsApp" no menu de ações.

## Tabela

`WhatsAppConnection` (migration `20261106120000_whatsapp_connection`, só aditiva): `userId` único,
`instanceName` único, `expectedPhone`, `connectedPhone` (só quando confere), `status`
(`PENDING_QR`, `CONNECTED`, `DISCONNECTED`, `REJECTED_WRONG_NUMBER`, `ERROR`), `statusReason`, datas e
`disconnectedById`. Cadastrada no ferramental do **Production Schema PR827**; o cutover do código fica
bloqueado até a evidência de schema dessa migration.

## Variáveis

API (`docker-compose.production.yml`, valores no env protegido):

| Variável | Padrão | Uso |
|---|---|---|
| `WHATSAPP_EVOLUTION_ENABLED` | `false` | liga a Fase A (junto com `COMMUNICATIONS_ENABLED`) |
| `WHATSAPP_EVOLUTION_BASE_URL` | `http://crm-evolution-api:8080` | endereço interno do Evolution |
| `WHATSAPP_EVOLUTION_API_KEY` | vazio | chave do Evolution (`AUTHENTICATION_API_KEY`) |
| `WHATSAPP_EVOLUTION_WEBHOOK_SECRET` | vazio | segredo do header do webhook interno |

Compose do WhatsApp (env protegido próprio): `WHATSAPP_EVOLUTION_API_KEY` (a mesma) e
`EVOLUTION_DB_PASSWORD` (só letras e números, porque vai dentro da URL de conexão).

## Riscos e operação

- **Banimento:** a API não é oficial; o WhatsApp pode banir o número, sobretudo com automação.
- **Container fora do ar:** só as rotas `/whatsapp/*` respondem 503 e o cartão avisa; o CRM segue normal.
- **Sessão perdida** (volume perdido, aparelho removido em "Aparelhos conectados", celular muito tempo
  offline): status `DISCONNECTED`; ler o QR de novo.
- **Subir em produção:** só por workflow aprovado, em PR separada (ainda não existe). Antes de ligar a flag:
  migration aplicada com evidência, env protegidos criados, `docker compose -f docker-compose.whatsapp.yml`
  saudável e um teste de ponta a ponta em homologação.
- **A confirmar ao subir:** o header do webhook chegando de fato (confirmado no código da v2.3.7, não em
  execução), o healthcheck em `GET /` respondendo 200 e o caminho do volume `/evolution/instances`.
