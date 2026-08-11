# Matriz de variáveis do runtime de produção

> 🔵 Estado de PR. Auditoria estática de `docker-compose.yml`, `apps/api/src/config/env.ts` e todas as ocorrências de `process.env` na API. “Obrigatória” significa que o Compose aborta a interpolação; variáveis opcionais de integrações são repassadas e têm feature flag/falha explícita no uso, nunca desaparecem por omissão do Compose.

| Variável | Uso | Obrigatoriedade e ausência | Política no Compose de produção |
|---|---|---|---|
| `DATABASE_URL` | Prisma/bootstrap | Obrigatória; API não inicia | `${VAR:?}`; preflight valida host/database sem exibir segredo |
| `NODE_ENV` | segurança/logs/defaults | Obrigatória operacional | fixada em `production` |
| `PORT` | listener HTTP | Obrigatória operacional | fixada em `4000` |
| `APP_VERSION` | health/build-info | Obrigatória | `${VAR:?}`, calculada pelo deploy |
| `APP_COMMIT` | health/build-info/imagem | Obrigatória | `${VAR:?}`, igual ao HEAD/SHA esperado |
| `APP_BUILT_AT` | health/build-info | Obrigatória | `${VAR:?}`, UTC do build |
| `JWT_SECRET` | autenticação/diagnóstico ERP | Crítica | `${VAR:?}` |
| `JWT_ACCESS_SECRET` | assinatura access token | Crítica | `${VAR:?}`; não aceita segredo default |
| `JWT_ACCESS_EXPIRES_IN` | expiração access token | Opcional | default explícito `12h` |
| `JWT_REFRESH_SECRET` | assinatura refresh token | Crítica | `${VAR:?}`; não aceita segredo default |
| `FRONTEND_URL` | CORS/links | Necessária em produção | default canônico do domínio |
| `CORS_ALLOWED_ORIGINS` | CORS | Necessária em produção | default canônico do domínio |
| `API_REQUEST_TIMEOUT_MS` | timeout global HTTP | Opcional numérica | default explícito `15000` |
| `ERP_ORDER_REQUEST_TIMEOUT_MS` | timeout da rota de pedido | Opcional numérica | default explícito `50000` |
| `SEED_ON_BOOTSTRAP` | seed | Proibida na publicação | fixada `false` |
| `ENABLE_PREVIEW_SEED` | preview seed | Proibida na publicação | fixada `false` |
| `ENABLE_SMOKE_BOOTSTRAP` | fixture smoke | Proibida na publicação | fixada `false` |
| `ADMIN_BOOTSTRAP_ENABLED` e `ADMIN_BOOTSTRAP_*` | criação administrativa | Não fazem parte do runtime produtivo seguro | omitidas; feature permanece false por default |
| `SMOKE_DIRECTOR_EMAIL`, `SMOKE_DIRECTOR_PASSWORD`, `SMOKE_SELLER_EMAIL` | testes/fixtures | Não usadas com smoke desligado | omitidas deliberadamente |
| `CNPJ_LOOKUP_PROVIDER` | seleção do provedor CNPJ | Necessária para funcionalidade | `${VAR:?}` |
| `CNPJ_LOOKUP_BASE_URL` | endpoint CNPJ | Necessária para funcionalidade | `${VAR:?}` |
| `CNPJ_LOOKUP_API_KEY` | autenticação de provedor quando aplicável | Opcional por provedor; erro explícito do provedor no uso | repassada, default vazio |
| `AI_PROVIDER` | seleção do provedor de IA | Opcional; IA desabilitada sem configuração | repassada |
| `AI_CHAT_ENABLED` | gate da IA | Opcional, segura desligada | default `false` |
| `AI_BASE_URL` | endpoint IA configurável | Condicional ao gate/provedor | repassada; serviço acusa configuração ausente |
| `AI_API_KEY` | credencial IA | Condicional ao gate/provedor | repassada somente por env seguro |
| `AI_MODEL` | modelo IA | Condicional ao gate/provedor | repassada |
| `AI_TIMEOUT_MS` | timeout IA | Opcional | default `30000` |
| `AI_MAX_OUTPUT_TOKENS` | limite de saída IA | Opcional | default `512` |
| `AI_TEMPERATURE` | temperatura IA | Opcional | default `0.4` |
| `OLLAMA_BASE_URL` | endpoint Ollama | Condicional ao provider | default compatível `http://localhost:11434` |
| `OLLAMA_MODEL` | modelo Ollama | Condicional ao provider | default `qwen2.5:3b` |
| `OPENAI_ENABLED` | compatibilidade do env operacional legado | Opcional; runtime atual usa `AI_CHAT_ENABLED` | repassada, default `false` |
| `OPENAI_API_KEY` | compatibilidade OpenAI legada | Condicional a integração legada | repassada pelo arquivo seguro |
| `OPENAI_MODEL` | compatibilidade OpenAI legada | Opcional | default legado `gpt-4.1-mini` |
| `ULTRAFV3_BASE_URL` | cliente e runtime ERP | Crítica; envio ERP seria bloqueado | `${VAR:?}` |
| `ULTRAFV3_USERNAME` | credencial ERP global | Opcional porque credencial por vendedor é suportada | repassada pelo env seguro |
| `ULTRAFV3_PASSWORD` | credencial ERP global | Opcional porque credencial por vendedor é suportada | repassada pelo env seguro |
| `ERP_CREDENTIAL_ENCRYPTION_KEY` | criptografia de credenciais ERP | Crítica; salvar/usar credenciais falha | `${VAR:?}` |
| `ERP_SYNC_SCHEDULER_ENABLED` | gate do scheduler | Obrigatória | deve ser literalmente `true`; ausência, vazio ou `false` bloqueia o deploy produtivo |
| `ERP_SYNC_PRODUCTS_INTERVAL_MS` | intervalo produtos | Opcional | default `21600000` |
| `ERP_SYNC_PARTNERS_INTERVAL_MS` | intervalo parceiros | Opcional | default `21600000` |
| `ERP_SYNC_ORDER_STATUS_INTERVAL_MS` | intervalo status | Opcional | default `900000` |
| `ERP_SYNC_HEALTHCHECK_INTERVAL_MS` | intervalo health ERP | Opcional | default `300000` |
| `ULTRAFV3_PROTOCOL_INVESTIGATION_ENABLED` | gate de captura diagnóstica | Opcional, segura desligada | default `false` |
| `ULTRAFV3_PROTOCOL_INVESTIGATION_BODY_MAX_CHARS` | limite de captura | Opcional | default `200000` igual ao runtime |
| `ULTRAFV3_ORDER_PROTOCOL_TEST_ENABLED` | gate de teste de protocolo | Opcional, segura desligada | default `false` |
| `FEATURE_ERP_INVESTIGATION` | endpoint investigativo | Opcional, segura desligada | default `false` |
| `COMMUNICATIONS_ENABLED` | gate do módulo de comunicações | Opcional, segura desligada | default `false` |
| `WHATSAPP_INTEGRATION_ENABLED` | gate WhatsApp | Opcional, segura desligada | default `false` |
| `WHATSAPP_PROVIDER` | provider WhatsApp | Opcional | default `meta` |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | validação webhook | Condicional ao gate | repassada pelo env seguro |
| `WHATSAPP_APP_SECRET` | assinatura webhook | Condicional ao gate | repassada pelo env seguro |
| `WHATSAPP_ACCESS_TOKEN` | API WhatsApp | Condicional ao gate | repassada pelo env seguro |
| `WHATSAPP_PHONE_NUMBER_ID` | identificação WhatsApp | Condicional ao gate | repassada pelo env seguro |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | conta WhatsApp | Condicional ao gate | repassada pelo env seguro |
| `WHATSAPP_API_VERSION` | versão Graph API | Opcional | default `v20.0` |
| `COMMUNICATIONS_WEBHOOK_RETENTION_DAYS` | retenção de eventos | Opcional | default `30` |
| `GIT_COMMIT`, `GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`, `COMMIT_SHA` | aliases de commit | Não usados no fluxo canônico | substituídos por `APP_COMMIT` validado |
| `BUILD_TIMESTAMP`, `BUILT_AT` | aliases de build | Não usados no fluxo canônico | substituídos por `APP_BUILT_AT` |
| `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET` | aliases somente diagnósticos ERP | Não necessários com JWT canônico obrigatório | não repassados; `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` são obrigatórios |
| `BOOTSTRAP_SMOKE_EXIT`, `SEED_FIXTURE_CLEAN` | execução de testes | Fora do runtime de produção | omitidas |

O teste `scripts/smoke/production-deploy-safety.mjs` extrai automaticamente as referências de `process.env` de `config/env.ts` e falha se uma variável de runtime não estiver no Compose, excetuando apenas aliases e bootstrap/smoke deliberadamente desativados e documentados acima.

## Autoridade de schema

| Variável | Produção real | CI/Preview descartável | Regra |
|---|---|---|---|
| `NODE_ENV` | `production` | `production` | comportamento do runtime; não concede DDL |
| `DATABASE_SCHEMA_MODE` | `external` literal no Compose | `ephemeral-push` literal | obrigatório; valor ausente/inválido falha fechado |

Em `external`, seeds e alterações automáticas são proibidos. Em `ephemeral-push`, somente o banco
incluído no stack descartável pode ser reconciliado e as flags existentes controlam os seeds.
