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
| `WHATSAPP_EVOLUTION_MESSAGES_ENABLED` | `false` | Fase B: grava as conversas (exige a Fase A ligada) |
| `WHATSAPP_MESSAGES_RETENTION_MONTHS` | `24` | Fase B: retenção das mensagens vinculadas (inteiro ≥ 1; inválido volta a 24) |

Compose do WhatsApp (env protegido próprio): `WHATSAPP_EVOLUTION_API_KEY` (a mesma) e
`EVOLUTION_DB_PASSWORD` (só letras e números, porque vai dentro da URL de conexão).

## Riscos e operação

- **Banimento:** a API não é oficial; o WhatsApp pode banir o número, sobretudo com automação.
- **Container fora do ar:** só as rotas `/whatsapp/*` respondem 503 e o cartão avisa; o CRM segue normal.
- **Sessão perdida** (volume perdido, aparelho removido em "Aparelhos conectados", celular muito tempo
  offline): status `DISCONNECTED`; ler o QR de novo.
- **Rede compartilhada:** o Evolution está na `gest-o_default`, a mesma do PostgreSQL do CRM (sem as
  credenciais dele). Registrado em `TD-WHATSAPP-EVOLUTION`.

## Subir e ligar em produção

Só pelo workflow **WhatsApp Evolution** (`.github/workflows/whatsapp-evolution.yml`), disparado na `main`, com
aprovação do environment `production-cutover` e no mesmo grupo de concorrência do Deploy Production (nunca
roda junto com build ou cutover). O workflow copia `scripts/whatsapp-evolution-remote.sh` e
`docker-compose.whatsapp.yml` do próprio commit para uma pasta temporária da VPS; a worktree `/apps/gest-o` não
é usada nem alterada. Nunca subir à mão na VPS.

| Ação | O que faz |
|---|---|
| `status` | Só leitura: env protegido (só metadados), estado e health, imagem em execução × digest declarado, redes e alias, portas publicadas (precisa ser nenhuma), limite e uso de memória, volumes e destino, nº de entradas em `/evolution/instances`, código HTTP de `GET http://crm-evolution-api:8080/` visto de dentro da API e contagem por código de `POST /webhooks/communications/evolution` no log da API (7 dias). Parado ou ausente = `NOT_RUNNING` (sucesso); qualquer problema = falha. |
| `up` | Confere os dois env protegidos (arquivo comum, `root:root`, `600`), os segredos presentes (abaixo) e a chave do Evolution **igual** no `.env` e no `whatsapp.env` (compara hash; imprime só `iguais`/`diferentes`, diferente = falha). Confere que as imagens têm digest exato e que o compose renderizado bate com elas. Faz `pull` e `up -d --no-build --pull never --wait` só do projeto `gest-o-whatsapp`, confere que api, web e db do CRM não mudaram (id, início, imagem, reinícios) e roda as checagens do `status`. |
| `stop` | `docker stop` dos dois containers (a API do Evolution antes do banco). Não remove container, volume nem rede: a sessão fica e o `up` seguinte volta sem QR. |

Não há `down` nem nada que apague volume.

### Segredos

| Arquivo (`root:root`, `600`) | Variável | Regra |
|---|---|---|
| `/root/demetra-env/.env` (API) | `COMMUNICATIONS_ENABLED`, `WHATSAPP_EVOLUTION_ENABLED` | `true` para ligar |
| | `WHATSAPP_EVOLUTION_API_KEY` | ≥ 32 caracteres; a mesma do `whatsapp.env` |
| | `WHATSAPP_EVOLUTION_WEBHOOK_SECRET` | ≥ 32 caracteres |
| `/root/demetra-env/whatsapp.env` | `WHATSAPP_EVOLUTION_API_KEY` | a mesma do `.env` |
| | `EVOLUTION_DB_PASSWORD` | ≥ 24 caracteres, só letras e números |

`WHATSAPP_INTEGRATION_ENABLED` (Meta) continua `false`: `COMMUNICATIONS_ENABLED=true` sozinho não liga a
Meta, que exige as duas flags. Valores gerados na VPS (por exemplo `openssl rand -hex 32`; hex atende à regra
da senha), nunca neste repositório, em PR ou em log. `scripts/backup-production-env.sh` copia o `whatsapp.env`
junto com o `.env` (`backups/whatsapp-env-<data>.backup`, `600`); `scripts/restore-production-env.sh` recusa
esse backup no lugar do `.env`. Restaurar o do WhatsApp: `install -m 600 <backup> /root/demetra-env/whatsapp.env`.
Perder `EVOLUTION_DB_PASSWORD` depois do primeiro `up` impede o Evolution de abrir o próprio banco.

### Ordem de ativação

1. Merge do PR do workflow.
2. Criar os segredos acima, com as flags já em `true` no `.env` da API (a API só lê o env ao ser recriada, no
   cutover do passo 5) e o `whatsapp.env` novo. Rodar o backup do env.
3. Workflow **WhatsApp Evolution** com `up`.
4. Workflow com `status`: tudo `healthy`, `portas_publicadas=nenhuma`, imagens `CONFERE`, `GET … pela API: 200`.
5. **Deploy Production** `phase=build` e depois `phase=cutover` do SHA do merge. O cutover recria a API com o
   `.env` novo (`docker restart` não basta: o env é lido na criação do container). O build recusa um SHA que a
   produção já roda, por isso a troca de flag vai junto com o deploy de um SHA novo.
6. Teste de ponta a ponta (abaixo).

### Desligar

- **Rápido:** workflow com `stop`. As rotas `/whatsapp/*` respondem 503 (`evolution_unavailable`), o cartão
  avisa e o resto do CRM segue normal. O Drift passa a mostrar `[WARN]` (sem reprovar) até o próximo `up`.
- **Definitivo:** flags em `false` no `.env` da API e deploy (build + cutover) de um SHA novo.

### Confirmar depois da subida

- **Healthcheck em `GET /`:** `status` mostra o health e `GET http://crm-evolution-api:8080/ pela API: <código>`.
  Se ficar `unhealthy` porque `GET /` não devolve 200, corrigir o healthcheck no compose por PR.
- **Volume `/evolution/instances`:** `status` mostra o destino da montagem e o nº de entradas (só a contagem).
  Prova decisiva: com um número de teste conectado, `stop` e depois `up`; o usuário precisa continuar
  `CONNECTED` sem novo QR. Com `DATABASE_SAVE_DATA_INSTANCE=true` a sessão pode estar no banco do Evolution e
  não no volume; o teste de reinício cobre os dois casos.
- **Header do webhook:** depois de conectar, `status` mostra `webhook interno (7 dias, por código)`: `200`/`202`
  = segredo aceito; `401` = segredo errado ou header ausente; `404` = flag desligada ou requisição pelo proxy.
  Prova independente: remover o aparelho em "Aparelhos conectados" no celular sem abrir `/whatsapp`; se
  Configurações → Usuários mostrar `DISCONNECTED`, foi o webhook (essa lista não consulta o Evolution).

Antes do teste de ponta a ponta: migration `20261106120000_whatsapp_connection` aplicada com evidência.

## Fase B — gravação das conversas (backend, B1)

Grava as mensagens do número comercial conectado, recebidas e enviadas, inclusive as que o vendedor manda
pelo app do celular, e liga cada conversa ao cliente. **Não existe envio pelo CRM** (Fase C). As telas, a fila e
as rotas de leitura ficam para o B2. O Evolution continua sem guardar mensagens: o CRM é o único lugar.
Desligado por padrão: exige `COMMUNICATIONS_ENABLED`, `WHATSAPP_EVOLUTION_ENABLED` **e**
`WHATSAPP_EVOLUTION_MESSAGES_ENABLED`.

### Eventos

- O webhook de cada instância assina `CONNECTION_UPDATE`, `MESSAGES_UPSERT`, `MESSAGES_EDITED` e
  `MESSAGES_DELETE` quando a Fase B está ligada, e só `CONNECTION_UPDATE` quando não está. A lista é sempre
  explícita: no Evolution, `enabled` com lista vazia assina **todos** os eventos. Ficam de fora de propósito
  `MESSAGES_UPDATE` (entrega e leitura), `MESSAGES_SET` (histórico), contatos, chats, grupos e presença.
- Instâncias já conectadas na Fase A passam para a lista nova **sem novo QR**, por `POST /webhook/set/{instância}`
  (o Evolution faz upsert por instância): na subida da API, uma vez por dia e na consulta de
  `GET /whatsapp/connection`. Instância nova já nasce com a lista atual.
- Limites do webhook interno: corpo de até 512 KiB (mensagens trazem miniatura e mensagem citada) e rate limit
  próprio de 30 mil eventos por 15 min, separado do webhook da Meta. O Evolution repete 429, 5xx e timeout até 10
  vezes e não repete 400, 401, 403, 404 e 422; falha ao gravar responde 503 sem detalhes.

### Regras

- **Conversa** = número comercial + número do contato (`CommunicationConversation`, provedor
  `evolution_whatsapp`). Cada vendedor tem a sua conversa com o mesmo contato.
- **Vínculo** pelo telefone na regra compartilhada (`normalizeBrazilPhone`; celular com o nono dígito e fixo de
  WhatsApp Business), pelo índice `ClientPhoneIndex`: telefones do ERP (cache do `/partners`, mesma busca do
  cartão do cliente) e dos contatos do CRM. Um cliente não arquivado = vinculada. Nenhum ou mais de um =
  fila **não vinculadas** do dono do número (`linkStatus` `unlinked` ou `ambiguous`), com o nome do contato no
  WhatsApp guardado só enquanto não houver vínculo. A cada mensagem nova o vínculo é tentado de novo. Sem
  vínculo em 7 dias, a conversa é apagada.
- **Índice** reconstruído por completo depois de cada gravação do cache de parceiros e uma vez por dia, e
  atualizado por cliente quando um contato muda, quando código ou documento do cliente mudam e na mesclagem.
- **Origem:** mensagem do vendedor = `OUTBOUND` com `metadata.origin = "app"` ("WhatsApp · via app").
- **Idempotência:** o id da mensagem é único dentro do número comercial; reentrega não grava de novo.
- **Editada:** troca o texto e marca `metadata.editedAt` (legenda editada mantém o tipo da mídia). Original
  ainda não gravada: ignorada.
- **Apagada:** do vendedor, mantém o texto com `metadata.deletedInWhatsAppAt` ("apagada no WhatsApp"); do
  contato, o texto vira `[mensagem apagada]` e a marca de edição sai.
- **Relógio:** `messageTimestamp` do WhatsApp; ausente ou mais de 5 min no futuro, vale a hora de chegada
  (marcada em `metadata.clock`). A ordem de exibição é por esse horário.
- **Ignorados:** grupo, status (stories), lista de transmissão, canal, LID sem número, número de fora do
  Brasil, reação e conversa com números de usuários do CRM (celular cadastrado ou número conectado).
- **Mídia:** só tipo, duração e legenda (`[imagem] legenda`, `[áudio 0:42]`, `[documento] legenda`). URL,
  chave, miniatura, coordenadas, vCard e nome de arquivo não são gravados; nada é baixado.

### Retenção, acesso e log

- Conteúdo só no PostgreSQL do CRM (`CommunicationMessage.textContent`), portanto também nos backups do banco.
- Mensagens vinculadas: `WHATSAPP_MESSAGES_RETENTION_MONTHS` (padrão 24); o job de hora em hora apaga as mais
  antigas e as conversas vinculadas que ficaram vazias. Só o provedor Evolution é tocado.
- Visibilidade (B2, detalhes em [Quem vê](#quem-vê)): vendedor vê as conversas dos clientes da carteira dele;
  gerente e diretor veem tudo. A conversa pertence ao cliente, não ao vendedor. Nada vai para a IA externa
  nesta fase.
- Log só com códigos e contagens (evento, resultado, motivo, vínculo, direção, usuário, duração). **Nunca** texto,
  legenda, nome do contato, número, JID, id da mensagem ou `apikey`; teste garante.

### Tabelas (migration `20261107120000_whatsapp_messages`, só aditiva)

- Valor `evolution_whatsapp` em `CommunicationProviderType`. **Caixa mista de propósito:** o gate de preview do
  schema só aceita valor novo de enum em minúsculas (`META_WHATSAPP_CLOUD` continua como está).
- `CommunicationConversation`: `numberOwnerUserId` (FK `User`, `SET NULL`), `linkStatus`, `linkSource`,
  `linkedById`, `linkedAt`, `unlinkedExpiresAt`, todas anuláveis, e dois índices.
- `CommunicationMessage`: índice `(conversationId, providerTimestamp)`.
- `ClientPhoneIndex` (`phone`, `clientId` com `CASCADE`, `source` `erp`/`crm`, `tenantId`).
- Cadastrada no ferramental do **Production Schema PR827**; o cutover do código fica bloqueado até a evidência.

### Antes de ligar

1. Migration `20261107120000_whatsapp_messages` aplicada com evidência.
2. Flag em `true` no `.env` da API e deploy (build + cutover) de um SHA novo. Na subida, a API ajusta os eventos
   das instâncias conectadas e reconstrói o índice.
3. Com um número de teste: mensagem recebida, enviada pelo app, editada e apagada, e conferir o formato do
   evento de edição (`protocolMessage` com a chave da original), que só foi lido no código-fonte do Evolution.

## Fase B2 — telas e rotas das conversas

Leitura das conversas gravadas no B1, fila "não vinculadas", vínculo manual e descarte. **Sem envio** e **sem
`TimelineEvent`**: os cartões vêm das próprias mensagens. Sem migration (usa as colunas do B1 e a tabela
`AppConfig`). A leitura não depende da flag de gravação: o que já foi gravado fica visível dentro da retenção.

### Quem vê

- Gerente e diretor: tudo do próprio tenant.
- Vendedor: conversas dos clientes da carteira atual dele (`Client.ownerSellerId`).
- Dono da oportunidade que não é dono do cliente: só pela rota e pela tela da oportunidade, e só desde a
  criação dela. O link "Ver histórico completo no cliente" aparece só para quem abre o cliente.
- Fila "não vinculadas": cada usuário vê só a do próprio número, inclusive gerente e diretor.
- Número do contato: mascarado nos cartões (`(DD) ****-NNNN`); completo só na fila, para o dono do número.

### Rotas (`/whatsapp`, autenticadas)

| Rota | O que faz |
|---|---|
| `GET /clients/:clientId/days?before=AAAA-MM-DD&take=20` | Cartões por conversa e dia de Brasília (UTC-3), mais recente primeiro. `take` até 60; `nextBefore` pagina por dia. |
| `GET /opportunities/:opportunityId/days` | O mesmo, só com mensagens desde a criação da oportunidade, mais `clientId`, `since` e `canOpenClient`. |
| `GET /conversations/:conversationId/messages?day=AAAA-MM-DD` | Mensagens de um cartão (até 300 por página, `cursor`; `opportunityId` limita à criação dela): direção, tipo, texto, hora, origem (`app` = "via app", `received` = "recebida"), `edited` e `deletedInWhatsApp`. Nunca devolve número, id externo ou nome do contato no WhatsApp. |
| `GET /unlinked?cursor=&take=20` | Fila do próprio número (`take` até 50): número completo, nome no WhatsApp, última mensagem (até 120 caracteres), dias para expirar, `unlinked`/`ambiguous` e `total`. |
| `POST /unlinked/:conversationId/link` `{ clientId }` | Vincula (só o dono do número). Vendedor só a cliente da carteira dele; gerente e diretor a qualquer cliente ativo do tenant. |
| `POST /unlinked/:conversationId/discard` | Apaga a conversa e as mensagens (só o dono). Se o contato escrever de novo, ela volta para a fila. |
| `GET /messages/summary` | Cartão Meu número: gravação ligada/desligada desde quando e o tamanho da fila. |

- **Cartões:** a varredura lê só data, direção e conversa de até 3.000 mensagens por página; o dia mais antigo
  de uma varredura cortada volta na página seguinte. Num dia com mais de 3.000 mensagens de um cliente, o
  cartão mostra só a contagem lida (as mensagens abrem todas, paginadas).
- **Vincular:** grava `clientId`, `tenantId`, `linkStatus = linked`, `linkSource = manual`, `linkedById` e
  `linkedAt`, limpa a expiração e o nome do WhatsApp e passa o tenant para as mensagens já gravadas. O telefone
  vira **contato do cliente** (nome do WhatsApp ou "Contato WhatsApp", telefone formatado, e-mail vazio, dono =
  dono da carteira do cliente), salvo quando já está no índice deste cliente ou num contato dele, comparado na
  regra compartilhada (`exists`), ou quando a conversa é ambígua ou o telefone está no índice de outro cliente
  ativo (`skipped_ambiguous`). Contato criado atualiza o índice em segundo plano (com a gravação ligada).
- **Corrida:** vincular e descartar só mexem em conversa ainda sem cliente; a segunda ação recebe 409 ou 404.
- **"Desde dd/mm":** na subida da API, se o estado em `AppConfig` (`whatsapp_messages_recording_state`) for
  diferente da flag, grava o novo estado com a data da subida. Ligada e número conectado depois da ligação =
  data da conexão. O primeiro registro marca o início do acompanhamento, não a data de uma ligação anterior.

### Telas

- **Linha do tempo do cliente e da oportunidade:** cartões "WhatsApp · dd/mm" intercalados por data com os
  eventos (as duas listas são paginadas; nada mais antigo que o último item carregado de cada uma aparece
  antes da hora). Ao abrir, as mensagens do dia com "via app"/"recebida", "editada" e "apagada no WhatsApp"
  (do vendedor); apagada do contato aparece como "[mensagem apagada]".
- **`/whatsapp` → Conversas não vinculadas** (só com fila): número, nome no WhatsApp, última mensagem ("Você:"
  quando enviada), "expira em N dias", "mais de um cliente", Vincular (busca de cliente) e Descartar (com
  confirmação).
- **Meu número:** com o número conectado, "Gravação das conversas ligada/desligada desde dd/mm" e o aviso de que
  as conversas ficam registradas no CRM; contador da fila com link para ela.
- **Contato do cliente:** e-mail opcional no formulário e na API (`contactSchema`, `clientContactSchema`); se
  informado, continua validado como e-mail.

