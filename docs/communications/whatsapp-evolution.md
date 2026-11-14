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
- Envio só na [Fase D](#fase-d--resumo-diário-aos-vendedores): um único método no cliente do Evolution, que só
  aceita o celular de um usuário ativo do CRM. Nunca para cliente, nada de envio em massa.
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
- Limites do webhook interno: corpo de até 4 MiB e rate limit próprio de 30 mil eventos por 15 min, separado do
  webhook da Meta. O Evolution v2.3.7 manda os binários da mensagem (miniatura, chaves, hashes) como
  `{"0":12,"1":34,...}`, ~10 bytes por byte: imagem ou documento com miniatura de 60 KB passa de 600 KiB (o limite
  antigo, 512 KiB, recusava com 413). Acima de 4 MiB a rota responde 200 `{"status":"too_large"}` e registra
  `[whatsapp] webhook body too large` só com tamanho declarado, limite e contagem desde a subida (a mensagem se
  perde, mas sem 10 reenvios inúteis). O Evolution repete 413, 429, 5xx e timeout até 10 vezes e não repete 400,
  401, 403, 404 e 422; falha ao gravar responde 503 sem detalhes.

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
- **Editada:** troca o texto e guarda `metadata.previousText` (texto anterior) e `metadata.editedAt` (legenda
  editada mantém o tipo da mídia); nunca cria linha. Chega por `MESSAGES_EDITED` ou dentro de `MESSAGES_UPSERT`
  como `protocolMessage` type 14 (`MESSAGE_EDIT`) com `editedMessage` e a chave da original em `key.id` (solto,
  em `editedMessage.message` ou em `ephemeralMessage.message`: o Evolution v2.3.7 só desvia para
  `MESSAGES_EDITED` o `protocolMessage` de primeiro nível). Reentrega com o mesmo texto não muda nada.
  Original ainda não gravada: ignorada.
- **Editada cifrada (confirmado em produção):** o WhatsApp manda a edição dentro de `MESSAGES_UPSERT` como
  `secretEncryptedMessage` com `secretEncType` 2 (`MESSAGE_EDIT` no Baileys 7.0.0-rc.9) e a chave da original
  em `targetMessageKey.id`. O texto novo vem cifrado com o `messageSecret` da original, que o CRM **não guarda**
  (decisão: não decifrar). A original ganha só `metadata.editedInWhatsAppAt`: o texto fica, sem
  `previousText`, e o cartão mostra "(editada no WhatsApp – texto novo não disponível)". Reentrega, original
  apagada ou original não gravada: nada muda (log `[whatsapp] message event` com motivo `text_unavailable`,
  sem conteúdo nem ids). Outro `secretEncType` (`EVENT_EDIT` 1, `UNKNOWN` 0) é ignorado (`secret_encrypted`).
- **Apagada:** do vendedor, mantém o texto com `metadata.deletedInWhatsAppAt` ("apagada no WhatsApp"); do
  contato, o texto vira `[mensagem apagada]` e saem as marcas de edição e o texto anterior. Chega por
  `MESSAGES_DELETE` ou como `protocolMessage` type 0 (`REVOKE`) dentro de `MESSAGES_UPSERT`.
- **Avisos de protocolo:** qualquer outro `protocolMessage` no upsert é ignorado (não vira mensagem), assim como
  `secretEncryptedMessage` que não seja `MESSAGE_EDIT`.
- **Tipo desconhecido:** gravado como `[mensagem não suportada]`, com log `WARN [whatsapp] unsupported message
  type` só com os nomes dos campos de primeiro nível de `data.message` (nunca valores), para identificar
  formatos novos.
- **Relógio:** `messageTimestamp` do WhatsApp; ausente ou mais de 5 min no futuro, vale a hora de chegada
  (marcada em `metadata.clock`). A ordem de exibição é por esse horário.
- **Ignorados:** grupo, status (stories), lista de transmissão, canal, LID sem número, número de fora do
  Brasil, reação e conversa com números de usuários do CRM (celular cadastrado ou número conectado).
- **Mídia:** só tipo, duração e legenda (`[imagem] legenda`, `[áudio 0:42]`, `[documento] legenda`). URL,
  chave, miniatura, coordenadas, vCard e nome de arquivo não são gravados. Só o áudio é baixado, e só com a
  transcrição ligada (ver [Transcrição dos áudios](#transcrição-dos-áudios)).

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
| `GET /conversations/:conversationId/messages?day=AAAA-MM-DD` | Mensagens de um cartão (até 300 por página, `cursor`; `opportunityId` limita à criação dela): direção, tipo, texto, hora, origem (`app` = "via app", `crm` = "via CRM" na Fase C, `received` = "recebida"), `edited` e `deletedInWhatsApp`. Nunca devolve número, id externo ou nome do contato no WhatsApp. |
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
  antes da hora). Ao abrir, as mensagens do dia com "via app"/"recebida", "editada", "(editada no WhatsApp –
  texto novo não disponível)" (edição cifrada) e "apagada no WhatsApp" (do vendedor); apagada do contato aparece
  como "[mensagem apagada]".
- **`/whatsapp` → Conversas não vinculadas** (só com fila): número, nome no WhatsApp, última mensagem ("Você:"
  quando enviada), "expira em N dias", "mais de um cliente", Vincular (busca de cliente) e Descartar (com
  confirmação).
- **Meu número:** com o número conectado, "Gravação das conversas ligada/desligada desde dd/mm" e o aviso de que
  as conversas ficam registradas no CRM; contador da fila com link para ela.
- **Contato do cliente:** e-mail opcional no formulário e na API (`contactSchema`, `clientContactSchema`); se
  informado, continua validado como e-mail.

## Transcrição dos áudios

Áudios recebidos e enviados pelo app do celular viram texto na conversa do cliente. Só o texto é guardado; o
arquivo nunca vai para o banco nem para o disco. Desligada por padrão (`WHATSAPP_TRANSCRIPTION_ENABLED=false`) e só
funciona com a gravação das conversas ligada e com a chave do provedor. Sem migration.

### Provedor

- Groq, plano gratuito (sem cartão), `whisper-large-v3`, `language=pt`, com um vocabulário curto do agro fixo no
  código (`AGRO_VOCABULARY_PROMPT`, sem dados de clientes). Chamada por `fetch` no formato da OpenAI
  (`POST {WHATSAPP_TRANSCRIPTION_BASE_URL}/audio/transcriptions`, multipart), sem SDK.
- Limites publicados pela Groq para os modelos Whisper (página de limites, consultada em 07/11/2026; conferir os
  da conta na página de limites do console): 20 pedidos/min, 2.000/dia, 7.200 s de áudio/hora e 28.800 s/dia.
- Dados: por padrão a Groq não guarda as entradas de inferência, mas pode manter logs de confiabilidade e abuso
  por até 30 dias; a opção ZDR (zero retenção) nas configurações de dados da conta desliga isso. A página não diz
  se os dados são usados para treino. O áudio e a fala do cliente saem do país (EUA).

### Fluxo

1. **Webhook:** o áudio é gravado como antes (`textContent` = `[áudio 0:42]`) e ganha
   `mediaMetadata.transcription`:
   - `pending`: vai para a fila em memória com a `key` e o `audioMessage` (`url`, `directPath`, `mediaKey`), que
     nunca são gravados nem logados;
   - `skipped/too_long`: mais de `WHATSAPP_TRANSCRIPTION_MAX_SECONDS` (600) ou arquivo acima de 10 MB;
   - `skipped/no_duration`: sem duração.

   O webhook responde na hora; nada lento roda nele.
2. **Fila (um áudio por vez):**
   - confere o teto do dia (`WHATSAPP_TRANSCRIPTION_DAILY_MAX_MINUTES`, padrão 180, dia de Brasília, contado em
     `AppConfig` na chave `whatsapp_transcription_seconds:AAAA-MM-DD`); estourado: `skipped/daily_cap`, sem baixar;
   - baixa o áudio pelo Evolution (`POST /chat/getBase64FromMediaMessage/{instância}` com a mensagem inteira:
     o Evolution do CRM não grava mensagens, então a busca só pela chave não acharia nada);
   - manda ao provedor e grava `done` com o texto (até 8.000 caracteres). O buffer do áudio é zerado depois.
3. **Tentativas:** até 4.
   - 429 (limite do plano gratuito): pausa a fila inteira pelo `retry-after` (até 1 h; sem ele, a espera
     padrão) e tenta de novo; esgotadas, `failed/rate_limited`;
   - rede, timeout, 5xx do provedor e falha de download: esperas de 30 s, 2 min e 10 min; esgotadas,
     `failed/provider_failed` ou `failed/download_failed`;
   - 4xx do provedor (chave inválida, arquivo recusado): `failed/provider_failed` na hora.

   Cada tentativa baixa o áudio de novo (nada fica guardado entre elas).
4. **Apagada pelo contato** antes ou durante a transcrição (`mediaMetadata` zerado): nada é gravado.
5. **API reiniciada:** a referência do áudio se perde. O job de hora em hora marca como `failed/interrupted` o
   pendente com mais de 30 min que não está na fila, e apaga os contadores diários com mais de 30 dias.

### Tela

No cartão "WhatsApp · dd/mm", o áudio aparece como `🎤 0:42` com o selo **transcrição automática** e o texto
(acima de 400 caracteres começa cortado, com "ver mais"). Sem texto: "sem fala reconhecida". Pendente:
"transcrevendo…"; longo demais: "longo demais para transcrever"; teto do dia: "limite diário de transcrição
atingido"; falhou: "não foi possível transcrever". Áudio de antes da transcrição continua `[áudio 0:42]`.
`GET /whatsapp/conversations/:id/messages` manda `transcription: { status, text?, reason? }` só em áudio;
tentativas, data e modelo não saem.

### Log e privacidade

- Log só com códigos e números: motivo, código do erro (`rate_limited`, `http_401`, `media_http_400`),
  tentativa, espera, segundos e duração. **Nunca** texto, áudio, base64, URL, `directPath`, `mediaKey`, número ou
  id da mensagem; teste garante.
- A transcrição fica em `CommunicationMessage.mediaMetadata` (portanto nos backups), sai junto quando o contato
  apaga a mensagem e segue a mesma retenção das mensagens. Se o cliente falar CPF ou telefone, isso fica no
  texto, como numa mensagem digitada. A transcrição não vai para a IA do CRM.

### Variáveis da transcrição

| Variável | Padrão |
|---|---|
| `WHATSAPP_TRANSCRIPTION_ENABLED` | `false` |
| `WHATSAPP_TRANSCRIPTION_BASE_URL` | `https://api.groq.com/openai/v1` |
| `WHATSAPP_TRANSCRIPTION_API_KEY` | vazio (sem chave, não transcreve) |
| `WHATSAPP_TRANSCRIPTION_MODEL` | `whisper-large-v3` |
| `WHATSAPP_TRANSCRIPTION_MAX_SECONDS` | `600` |
| `WHATSAPP_TRANSCRIPTION_DAILY_MAX_MINUTES` | `180` |

Repassadas à API pelo `docker-compose.production.yml`. Para ligar: criar a chave na conta da Groq (com ZDR
ligado), pôr a chave e `WHATSAPP_TRANSCRIPTION_ENABLED=true` no arquivo de env protegido e recriar a API pelo
fluxo oficial, com a aprovação de sempre.

## Fase D — resumo diário aos vendedores

Nos dias úteis, cada vendedor ativo recebe no WhatsApp comercial dele um resumo da própria carteira, enviado do
número conectado de um diretor ou gerente (o remetente). **Desligado por padrão.** Sem migration e sem variável
nova: a configuração fica no `AppConfig` e o link do CRM usa o `FRONTEND_URL` que a API já recebe. Só funciona com
a Fase A ligada e configurada.

### Conteúdo

- Reativações abertas (automação de inativos recentes); as criadas nas últimas 24 h aparecem como "NOVA".
- Oportunidades lançadas nas últimas 24 h (sem as da automação, que já estão acima).
- Follow-ups vencidos e de hoje (etapa aberta; "hoje" é o dia de Brasília).
- Só oportunidades do vendedor, de cliente não arquivado. Cada item: cliente, cidade/UF, etapa e data do
  follow-up; até 10 por seção, com "+N no CRM" e o link do CRM. Os nomes dos clientes vão no texto (aprovado:
  são clientes da carteira do próprio vendedor).
- **Vendedor sem nada: não recebe mensagem** (fica "sem itens" no painel).
- Opcional: bloco "Dicas do gerente comercial", escrito pela IA (abaixo). Desligado por padrão.

### Dicas do gerente comercial (IA)

Até 3 dicas curtas e práticas para o dia (o que priorizar, como abordar conforme a etapa, argumento de fechamento,
calendário agrícola do mês), escritas pela persona "Claude, gerente comercial" (sementes de inverno e verão,
revendas e produtores do PR/SC/MS), no fim do resumo e antes do link. Liga/desliga próprio no painel ("Dicas do
gerente comercial (IA)"), **desligado por padrão**, no mesmo `AppConfig` (`managerTips`); configuração antiga sem o
campo vale desligado. Sem migration e sem variável nova. Código em
`apps/api/src/services/whatsappDailySummary/dailySummaryTips.ts`.

- **Provedor (11/11/2026):** com a chave da Groq configurada, as dicas vão à **Groq** (plano gratuito), e só elas: o
  resto da IA do CRM continua no provedor de `AI_*`. A chave e o endereço são os da transcrição dos áudios
  (`WHATSAPP_TRANSCRIPTION_API_KEY` e `WHATSAPP_TRANSCRIPTION_BASE_URL`, mesma conta Groq), lidos por
  `groqTextConfig` (`apps/api/src/services/ai/groqTextConfig.ts`); basta a chave existir, a transcrição não
  precisa estar ligada. O modelo fica no `AppConfig` do resumo (`managerTipsModel`): `openai/gpt-oss-120b`
  (padrão) ou `openai/gpt-oss-20b`, escolhido no painel; configuração antiga sem o campo, ou com modelo fora da
  lista, vale o padrão. Na Groq vão `response_format` JSON, `reasoning_effort: "low"`, `include_reasoning: false`
  e `max_completion_tokens`; o corpo enviado ao OpenRouter não mudou. **Sem a chave da Groq**, as dicas usam o
  provedor de `AI_*`, como antes. `AI_CHAT_ENABLED`, o filtro central, o teto diário (mesmo `AiUsageLimiter`) e o
  orçamento de 8 s valem igual nos dois casos. Limites da Groq são por organização e por modelo: o whisper da
  transcrição não divide a cota dos modelos de texto.

- **Privacidade (o modelo gratuito do OpenRouter registra os dados; a Groq, por padrão, não guarda as requisições,
  mas pode registrá-las por até 30 dias para investigar abuso ou falha, salvo com Zero Data Retention):** a IA recebe só um código por oportunidade (`C1`…`C12`, na
  ordem do resumo), a seção, a etapa, o valor, os dias de follow-up vencido, desde o último contato e na etapa, a
  cultura e os produtos (ofertado e itens), a data da última compra (só nas reativações), a UF, o dia e o mês.
  Nunca nome, documento, telefone, cidade, região, ids nem o nome do vendedor. O CRM troca os códigos pelos nomes
  depois da conferência. O prompt de sistema é próprio (não o prompt mestre) e o filtro central da IA continua
  valendo.
- **Conferência:** a resposta tem de ser `{"dicas": [...]}` com 1 a 3 textos de até 250 caracteres. Descarta
  **todas** as dicas se houver código inexistente, preço, valor em reais, percentual, desconto, promoção, brinde,
  prazo, parcelamento ou condição de pagamento, ou cultura de uma lista fixa (soja, milho, trigo, aveia…) que não
  esteja nos dados. A assinatura "— Claude, gerente comercial" é posta pelo CRM, não pela IA. Com os nomes, cada
  dica fica com até 320 caracteres no texto.
- **Tempo e limite:** as dicas são geradas na montagem do texto de cada vendedor, com orçamento de 8 s (fluxo
  `daily-summary-tips`). Disjuntor por rodada: a primeira falha da IA (erro, demora, limite, IA desligada) deixa
  os demais vendedores da rodada sem dicas, sem nova chamada. Um 429 (limite) não tem nova tentativa nem espera
  o `retry-after`: o resumo sai sem as dicas. Vendedor sem itens não chama a IA. Uma chamada por
  vendedor por dia, no balde `resumo-diario` do teto diário de IA (`ai.usage`, padrão 50); a prévia e o teste
  contam no teto de quem clicou. Sem dicas, por qualquer motivo, o resumo sai igual e na hora.
- **Prévia:** mostra o texto com as dicas e a situação (`ok`, `ai_unavailable`, `ai_failed`, `discarded`…).
- **Log:** `[whatsapp daily summary] tips` só com a situação, o motivo do descarte, contagens (códigos e dicas) e o
  provedor e o modelo usados (`provider`, `model`);
  os logs `[AI]` existentes só têm números. Nunca o prompt, a resposta ou dados de cliente.
- **Limitações conhecidas:** os limites do plano gratuito da Groq não estão confirmados pela página oficial (a tabela
  publicada para gpt-oss é 30 por minuto, 1.000 por dia, 8 mil tokens por minuto e 200 mil por dia; conferir em
  Settings → Limits da conta); sem a chave da Groq, valem os limites, também não confirmados, do modelo gratuito do
  OpenRouter; um nome comercial de produto inventado pela IA não é detectado (só culturas da lista fixa);
  "dias na etapa" é aproximado (última troca de etapa no `OpportunityChangeLog`, que a tela de rascunho e a
  automação não gravam; sem ela, a data de criação). O produto da última compra não existe no CRM e não vai.

### Trava do destino

- O envio do resumo é `EvolutionClient.sendTextToCrmUser` (`POST /message/sendText/{instância}`); o outro envio do
  sistema é o da Fase C (`sendTextToClient`), com destino próprio e recusado aqui. O destino tem de ser o objeto
  emitido por `resolveCrmUserRecipient`, que lê o usuário na hora: ativo, celular válido em `User.phone` e **fora
  do índice de telefones de cliente** (`ClientPhoneIndex`, inclusive cliente arquivado). O objeto vale 2 minutos; um objeto montado à mão, ou uma cópia dele, é recusado antes da rede.
- Teste estático (`whatsappSendGuard.test.ts`): só o resumo diário chama `sendTextToCrmUser`, e só o cliente do
  Evolution conhece `/message/...`.
- Celular do usuário também cadastrado em cliente: recusado (`phone_matches_client`). O painel e a prévia
  mostram "O celular deste usuário também está cadastrado em cliente(s) – corrija o cadastro", sem expor o
  cliente. O índice é reconstruído pela Fase B; com a gravação desligada ele pode estar desatualizado.

### Envio

- Agendador a cada 5 minutos (`bootstrap.ts`). Segunda a sexta, a partir do horário configurado (padrão 07:30,
  Brasília), numa janela de 3 horas. Feriados não são tratados.
- Remetente conferido antes de qualquer envio: diretor ou gerente ativo, `WhatsAppConnection` `CONNECTED` e
  instância `open` no Evolution. Indisponível: nada sai, o dia fica "remetente indisponível" com o código e a tela
  mostra o alerta; se reconectar dentro da janela, a rodada seguinte envia.
- Uma vez por vendedor por dia: a linha `whatsappDailySummary.day.<dia>.<usuário>` do `AppConfig` (chave única) é
  criada como "enviando" antes do envio. API reiniciada no meio: fica "enviando" (incerto) e não repete.
- Intervalo aleatório de 8 a 20 s entre envios e "digitando" de 1,2 s.
- Resultado: enviado (2xx com id); não enviado (número sem WhatsApp, instância inexistente, chave recusada,
  conexão recusada); **incerto** (timeout, 5xx, resposta desconhecida, 2xx sem id), registrado só com o código.
  Só "conexão recusada" tenta de novo, até 3 vezes. Instância inexistente ou chave recusada encerra a rodada.
- Linhas diárias com mais de 30 dias são apagadas.

### Tela (Configurações → Automações Comerciais)

Ligar/desligar, horário, remetente (com o status da conexão), seções, dicas do gerente comercial (IA), situação de
hoje por vendedor, **Ver
prévia** (não envia) e **Enviar teste para mim** (manda o resumo de um vendedor ao celular de quem clicou, pelo
remetente, marcado `[Teste]`, 1 por minuto). Diretor edita; gerente vê, faz prévia e testa.

### A confirmar no primeiro teste em produção

O código não mostra, e não foi possível confirmar fora de produção, a resposta do Evolution v2.3.7 para envio com
a instância desconectada, nem o evento que o envio pela API gera no webhook. A resposta desconhecida fica
"incerto" com o código; o evento, qualquer que seja, cai na regra de número interno (abaixo). Confirmar com o
"Enviar teste para mim".

### Linha do tempo e log

- O resumo não vira conversa: a ingestão ignora mensagem cujo contato é um `User.phone` ou o número conectado de
  outro usuário (`internal_number`), nos dois lados (cópia enviada no número do remetente e recebida no do
  vendedor). Teste garante.
- Log só com contagens e códigos (`sent`, `uncertain`, `connection_refused`, `sender_not_connected`…): sem texto,
  nomes, números ou ids. A situação de cada vendedor fica só no `AppConfig` e aparece na tela.

## Fase C — conversa pelo CRM (API, C1)

O vendedor conversa com o cliente **dentro do CRM, pelo próprio número comercial**, e tudo fica registrado. Este
PR (C1) traz só a API, com o envio **desligado**; a caixa de conversas, o botão "WhatsApp" do cliente e da
oportunidade e o "Gerar mensagem IA" no campo de resposta vêm no C2 (web). Só **texto** nesta fase. Sem migration
e sem variável nova: usa `CommunicationConversation.unreadCount` (já existia, sempre 0) e o `AppConfig`.

### Regras de segurança

- **Remetente:** só o número `CONNECTED` do próprio usuário, com a instância `open` no Evolution na hora.
- **Destino:** conferido no servidor por `resolveClientRecipient`, nunca número digitado:
  - uma conversa **vinculada do próprio número** (a de outro número nunca é usada, nem por gerente ou diretor); ou
  - cliente + referência de telefone = id da linha do `ClientPhoneIndex` daquele cliente.
  - Cliente não arquivado do tenant; vendedor só da carteira atual (`ownerSellerId`); gerente e diretor qualquer
    cliente, sempre pelo próprio número, em conversa própria.
  - Recusas: conversa na fila (`conversation_unlinked`, vincule antes); telefone em mais de um cliente sem conversa
    já vinculada a este (`phone_ambiguous`); número de usuário do CRM (`phone_internal`).
- **Um destino e um texto por requisição**, por ação humana: o corpo é um objeto estrito (lista, número solto ou
  campo a mais = 400). Nunca em lote, nunca repetido.
- **Trava do envio:** dois métodos no `EvolutionClient`, cada um com o próprio tipo de destino, emitido por um só
  módulo (objeto congelado, registrado num `WeakMap`, válido 2 minutos) e recusado pelo outro método:
  - `sendTextToCrmUser` (resumo diário): chamado só por `dailySummarySender.ts`;
  - `sendTextToClient` (Fase C): chamado só por `crmConversationSender.ts`.

  O POST comum (`#postSendText`) é privado de verdade. A trava estática
  (`services/whatsappConnection/whatsappSendGuard.test.ts`) lista exatamente quem chama cada método, cada
  resolvedor de destino e `sendCrmText`.
- **Chave:** `AppConfig` `whatsappCrmSend.config`, `{ "enabled": false }` por padrão; só o diretor muda
  (`PUT /whatsapp/inbox/send-config`). Também exige a gravação das conversas (Fase B) ligada e o Evolution
  configurado; sem isso, `send_unavailable`.

### Limites (por usuário)

Um envio de cada vez; 3 s entre envios; **6 por minuto**; **150 por dia** e **20 primeiros contatos por dia**
(contato que nunca escreveu para este número, contado uma vez por contato). Dia de Brasília. Contam os envios que
saíram ou podem ter saído (incerto); recusa certa do Evolution não conta. Contadores em memória; o dia é retomado
do banco (mensagens "via CRM" de hoje) depois de reiniciar a API. Uma só instância da API em produção.

### Envio, eco e "via CRM"

1. `POST /message/sendText/{instância do remetente}` com timeout de **10 s** (abaixo dos 15 s da requisição da API)
   e "digitando" de 1,2 s.
2. Com o `key.id` devolvido, a mensagem é gravada `OUTBOUND`/`SENT` com `metadata = { origin: "crm",
   sentByUserId, firstContact? }`, na conversa do número do remetente (criada vinculada, `linkSource = crm`, se não
   existia). Não lidas zeradas.
3. **Eco depois:** o `messages.upsert` `fromMe` com o mesmo id cai na unicidade (provedor, número, id) e vira
   `duplicate`. **Eco antes** da resposta do envio: é gravado "via app"; o envio recebe `duplicate` e só troca a
   origem para `crm`. Nunca duplica.
4. **Incerto** (timeout, 5xx, 2xx sem id): nada é gravado nem repetido; a resposta é 202 "Pode ter sido enviada.
   Confira no celular antes de reenviar." Se o eco chegar, entra como "via app".

### Não lidas

Por conversa = por dono do número. Recebida soma 1; enviada (app ou CRM) zera; abrir (`POST /inbox/read`) zera;
"marcar como não lida" põe 1. Gerente ou diretor olhando conversa de outro número não mexe nas não lidas.

### Rotas (`/whatsapp`, autenticadas)

| Rota | O que faz |
|---|---|
| `GET /inbox/status` | Chave, envio disponível, número conectado, limites, uso de hoje e total de não lidas do próprio número. |
| `PUT /inbox/send-config` `{ enabled }` | Liga/desliga o envio pelo CRM (só diretor). |
| `GET /inbox?scope=mine&cursor=&take=20` | Caixa: conversas **vinculadas** do próprio número, mais recente primeiro, com cliente, número mascarado, não lidas, trecho da última mensagem (até 120 caracteres, `viaCrm`), `own` e `canReply`. `scope=team` (opcional `ownerUserId`) só gestão: outros números do tenant, somente leitura. |
| `GET /inbox/messages?conversationId=&before=&changedSince=` | Últimas 50 mensagens (`nextBefore` para as anteriores) ou só as criadas/alteradas desde `changedSince` (polling; usar o `serverTime` da resposta anterior). Mesma visão da linha do tempo, com origem `app`, `crm` ou `received`. Vendedor só do próprio número. |
| `POST /inbox/read` e `POST /inbox/unread` `{ conversationId }` | Lida / não lida (só o dono do número). |
| `GET /inbox/client-targets?clientId=` | Telefones do cliente (um por número, ERP antes do CRM): `ref`, número formatado, celular/fixo, origem e a conversa do próprio número com ele. Vendedor só da carteira. |
| `POST /inbox/send` `{ conversationId, text }` ou `{ clientId, phoneRef, text }` | Envia (201 com a conversa e a mensagem; erro com `code` e `message`). |

Códigos de recusa: `send_disabled` 403, `send_unavailable` 503, `text_invalid` 400 (vazio ou acima de 4.000
caracteres), `send_in_progress`/`rate_interval`/`rate_minute`/`rate_day`/`rate_first_contact` 429,
`not_connected` 409, `conversation_not_found` 404, `conversation_unlinked` 409, `recipient_not_allowed` 404,
`phone_ambiguous` 409, `phone_internal` 409, `evolution_unavailable` 503, `number_not_on_whatsapp` 422,
`uncertain` 202.

Atualização da tela (C2): polling só com a aba visível, caixa a cada 20 s e conversa aberta a cada 5 s com
`changedSince`.

### Log

O serviço de envio grava uma linha `[whatsapp] crm send` só com `result` (`sent`, `refused`, `not_sent`,
`uncertain`) e `code`. Nunca texto, telefone (completo ou parcial), nome de cliente ou contato, `pushName`, JID,
`key.id`, instância do Evolution, chave ou segredo. O log de acesso da API grava a URL das rotas, com ids internos
do CRM (opacos), como no resto do sistema.

### Roteiro do envio de teste (antes de ligar para todos)

O código não mostra três comportamentos do Evolution v2.3.7. O desenho funciona nos três casos, mas eles precisam
ser confirmados no primeiro envio real. Com a chave ligada pelo diretor, um usuário com número conectado envia, pela
API (`POST /whatsapp/inbox/send`) ou pela tela do C2, uma mensagem curta a um cliente de teste da própria carteira
(número de um aparelho da empresa cadastrado como contato do cliente) e confere:

1. **Eco `fromMe` × `SEND_MESSAGE`:** no banco, a mensagem aparece **uma vez**, com `metadata.origin = "crm"`. No
   log do webhook da API, um evento `messages.upsert` com resultado `duplicate` (ou `stored`, com a origem corrigida
   em seguida pelo envio) confirma que o envio pela API volta como `MESSAGES_UPSERT` `fromMe`. Nenhum evento de
   mensagem indica que o Evolution só emite `SEND_MESSAGE` (que não assinamos): nada a fazer, a mensagem gravada no
   envio é o registro.
2. **`@lid`:** se o eco vier com o contato como `@lid`, a ingestão o ignora (sem número legível) e a mensagem
   gravada no envio continua sendo o registro. Conferir também se as respostas desse contato continuam caindo na
   mesma conversa; se vierem como `@lid`, ficam fora da Fase B: registrar em `TD-WHATSAPP-MESSAGES`.
3. **Nono dígito:** repetir com um contato cuja conta do WhatsApp é antiga (sem o 9). O destino vai com o 9
   (55 + DDD + 9 + número); confirmar que a mensagem chega ao aparelho e que o eco cai na mesma conversa (a
   ingestão acrescenta o 9). Se o Evolution responder `exists: false`, o CRM devolve `number_not_on_whatsapp` e
   nada sai: registrar e tratar em PR próprio.

## Fase C — telas da conversa pelo CRM (web, C2)

Só o web: usa as rotas do C1 sem mudar regras da API. Sem migration, sem variável nova, sem dependência nova.

### Caixa de conversas (`/whatsapp`)

- Bloco "Conversas" entre a fila de não vinculadas e o Assistente Comercial (os dois continuam como estavam).
- **Meu número** (todos os perfis): conversas vinculadas do próprio número, da mais recente para a mais antiga, com
  cliente, número mascarado, não lidas e trecho da última mensagem ("Você (CRM): …" quando saiu pelo CRM).
- **Equipe** (gerente e diretor): conversas dos outros números do tenant, com o nome do dono do número. **Somente
  leitura**: sem campo de resposta e sem `POST /inbox/read` (não zera as não lidas do vendedor). Sem filtro por
  vendedor nesta fase.
- Atualização só com a aba visível (`document.visibilityState`): lista e situação do envio a cada **20 s**; conversa
  aberta a cada **5 s**, só o que mudou (`changedSince` = `serverTime` da resposta anterior), juntado por id.
  Ao voltar para a aba, atualiza na hora.

### Conversa aberta

- Histórico com texto, transcrição do áudio (mesmo componente da linha do tempo), marcas "editada", "editada no
  WhatsApp – texto novo não disponível" e "apagada no WhatsApp", mídia como rótulo (`[imagem]`, `[documento]`…) e
  origem: **recebida**, **via app** ou **via CRM**. "Mensagens anteriores" carrega as 50 de antes.
- Abrir marca como lida **só para o dono do número** (e de novo se chegar mensagem com a conversa aberta).
- A linha do tempo do cliente e da oportunidade também passa a mostrar "via CRM" (antes aparecia "recebida").

### Campo de resposta

- Aparece só para o dono do número; sem envio ligado, sem número conectado ou com a conversa fora da carteira, mostra
  o motivo no lugar do campo.
- Até **4.000 caracteres**, com contador. "Gerar mensagem IA" (`POST /ai/assistant-whatsapp-message`, rota já
  existente) só **preenche** o campo; o vendedor revisa e envia.
- Uma ação por vez: enviar e gerar ficam bloqueados enquanto um dos dois está em andamento.
- Erro da API mostrado **como veio** (limite, não conectado, número sem WhatsApp…). **Incerto** (202 `uncertain`, ou
  sem resposta / tempo esgotado no navegador): aviso "Pode ter sido enviada. Confira no celular antes de reenviar.";
  o texto fica no campo e nada é reenviado sozinho.
- Abaixo do campo, o uso de hoje: envios e primeiros contatos contra os limites.

### Botão "WhatsApp" do cliente e da oportunidade

`ClientErpPhones` (tela do cliente, gaveta e tela da oportunidade) recebe o `clientId`. Com o envio ligado e o número
do usuário conectado (`GET /inbox/status`), lê `GET /inbox/client-targets` e procura o telefone do ERP pelo número:

- conversa já existente com esse telefone → `/whatsapp?conversationId=…`;
- sem conversa → `/whatsapp?clientId=…&phoneRef=…`: conversa vazia, **criada no primeiro envio**
  (`POST /inbox/send` com `{ clientId, phoneRef, text }`);
- envio desligado, número desconectado, telefone fora do índice ou erro → continua o **wa.me**.

### Configurações → Automações Comerciais → "Conversa pelo CRM no WhatsApp"

Liga/desliga a chave (`PUT /inbox/send-config`): **só o diretor** edita; o gerente vê. Mostra os limites (lidos da
API) e o aviso de risco de bloqueio do número. Ligada sem a gravação das conversas ou sem o Evolution: aviso de
indisponível.

### Roteiro de ativação

Pré-requisitos: C1 e C2 em produção; gravação das conversas (Fase B) ligada; número do usuário de teste conectado.
Nada disso liga o envio sozinho.

1. **Diretor** liga a chave em Configurações → Automações Comerciais → "Conversa pelo CRM no WhatsApp".
2. **Usuário de teste** (de preferência um gerente, com cliente de teste cujo contato é um aparelho da empresa): abre o
   cliente, toca em "WhatsApp" no telefone do aparelho de teste e confere que abriu a conversa no CRM (não o wa.me).
3. Envia uma mensagem curta. Confere: aparece "via CRM" na conversa, chega ao aparelho de teste e aparece também no
   celular do remetente.
4. Responde pelo aparelho de teste. Em até 5 s a resposta aparece na conversa aberta; a lista mostra a ordem e as
   não lidas zeradas com a conversa aberta.
5. Segue o **Roteiro do envio de teste** da Fase C (C1): eco sem duplicar, `@lid`, nono dígito.
6. Gerente abre a aba "Equipe": vê a conversa sem campo de resposta, e as não lidas do vendedor não mudam.
7. Desligar a chave: o campo de resposta mostra "Envio pelo CRM desligado" e o botão do cliente volta ao wa.me.
8. Só depois disso, liberar aos vendedores (avisar dos limites e do risco de bloqueio).

Algo errado em qualquer passo: o diretor desliga a chave (efeito imediato, sem deploy) e o caso vai para
`TD-WHATSAPP-CRM-SEND`.
