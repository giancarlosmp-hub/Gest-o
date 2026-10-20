# IA: modelo, dados enviados e teto de uso

> Estado de PR (série "regra oficial da carteira", PR 4). Nenhuma troca foi feita em produção por esta mudança.

## Onde a configuração da IA fica em produção

As variáveis `AI_*` **não** estão em secrets do GitHub nem fixas no Compose. O caminho é:

1. Arquivo protegido na VPS: a fonte canônica `/root/demetra-env/.env` (dono `root:root`, modo `600`), escolhida por
   `scripts/resolve-production-env.sh`. O legado `/root/demetra-env/production.env` só vale para `phase=build` quando
   o canônico não existe; o `phase=cutover` exige o canônico.
2. `scripts/deploy-production.sh` carrega esse arquivo (`docker compose --env-file "$ENV_FILE"`).
3. `docker-compose.production.yml` repassa ao container da API: `AI_PROVIDER`, `AI_CHAT_ENABLED` (padrão `false`),
   `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_TIMEOUT_MS` (30000), `AI_MAX_OUTPUT_TOKENS` (512) e `AI_TEMPERATURE` (0.4).
4. `apps/api/src/config/env.ts` lê os valores na subida da API. Trocar o arquivo sem recriar o container não muda nada.

Os secrets do GitHub do workflow **Deploy Production** são só de acesso SSH. `.env.example` é referência local.

## Passo a passo para trocar o modelo

Feito pelo responsável pela produção, com a aprovação de sempre:

1. No OpenRouter, escolher o modelo e copiar o **identificador exato** da página dele (ex.: `fornecedor/modelo:free`).
2. Conferir a política de dados do modelo **e** da conta antes de usar (ver abaixo). Modelos grátis podem registrar
   os prompts.
3. Na VPS, editar só a linha `AI_MODEL=` em `/root/demetra-env/.env`, mantendo dono `root:root` e modo `600` (o
   resolvedor recusa o arquivo se mudarem). Não imprimir o arquivo em logs nem copiar valores para o repositório.
   `AI_PROVIDER=openrouter`, `AI_BASE_URL` e `AI_API_KEY` continuam como estão. Para desligar a IA: `AI_CHAT_ENABLED=false`.
4. Recriar a API pelo fluxo oficial (workflow **Deploy Production**, `phase=build` e depois `phase=cutover`, como em
   [`docs/DEPLOY_GUIDE.md`](../DEPLOY_GUIDE.md)). Não usar `docker compose up` manual.
5. Conferir como diretor ou gerente: `GET /ai/status` mostra `model`, `configured`, `fallback` e `lastError`
   (`http_402`/`http_429` = sem saldo ou limite do provedor; `http_404` = identificador errado). Gerar uma sugestão
   inteligente de um cliente e ver `source: "ai"`.
6. Para voltar: restaurar a linha anterior de `AI_MODEL` e repetir o passo 4.

### Retenção de dados nos modelos grátis

A página do modelo grátis da NVIDIA no OpenRouter (`nvidia/nemotron-3-super-120b-a12b:free`, consultada em
19/10/2026) avisa que o uso é registrado (*logged*) pelo provedor. Isso **não** é zero retenção. Antes de trocar,
conferir nas configurações de privacidade da conta do OpenRouter a opção de usar só endpoints com zero retenção
(ZDR) e se o modelo escolhido tem um endpoint desse tipo. Se a conta só permitir ZDR e o modelo não tiver um, a
chamada falha e o CRM cai no fallback determinístico.

Decisão do diretor em 20/10/2026: aceitar o modelo grátis sem zero retenção, porque o filtro central garante que só
saem nome, cidade/UF, situação da carteira, data da última compra e textos operacionais curtos.

## O que vai para o provedor de IA

Decisão de 18/10/2026: do cliente, só **nome e cidade/UF**, a **situação da carteira** (Ativo, Inativo recente,
Ex-cliente, Prospect e o alerta "esfriando"), a **data da última compra** e textos operacionais curtos.
Nunca CPF/CNPJ, IE, RG, telefone, celular, e-mail, endereço nem valores de títulos e crédito.

- Filtro central: `apps/api/src/services/ai/aiPayloadSanitizer.ts`, aplicado pelo `AiService` em **toda** chamada,
  sobre o texto final (system e mensagens). Objetos JSON embutidos perdem os campos de nome proibido (inclusive
  campos novos com esses nomes) e o texto livre tem documentos, telefones, e-mails, CEP, endereços e valores de
  títulos/crédito mascarados.
- Contextos de cliente (sugestão inteligente, WhatsApp, mensagem da oportunidade, timeline) usam a situação oficial
  (`resolveLastPurchase`: data do ERP ou pedido sent do CRM) e a abordagem: reativação para inativo recente e
  ex-cliente, primeira venda para prospect, manutenção/recompra para ativo esfriando.
- Cliente arquivado fica fora: sugestão, WhatsApp e timeline respondem 404; insight e mensagem da oportunidade, 409.

## Teto diário por usuário

- Padrão: 50 chamadas por usuário por dia de Brasília. Acima disso, o fluxo usa o fallback determinístico, sem erro.
- Configuração no AppConfig (`ai.usage`), não em variável de ambiente (o Compose de produção só repassa as variáveis
  que declara). Diretor: `PUT /ai/usage-config` com `{"dailyCallLimitPerUser": N}` (1 a 1000). `GET /ai/status`
  (diretor e gerente) mostra o teto vigente.
- Chamadas sem usuário (IA Comercial da gestão, cacheada) dividem o balde `sistema`.
- A contagem fica em memória da API: reinício zera o dia, e mais de uma réplica contaria em separado.
- Log `[AI] chat-success` / `[AI] chat-failed` / `[AI] daily-limit-reached`: usuário, dia, chamadas e uso de tokens
  do dia, sem conteúdo.
