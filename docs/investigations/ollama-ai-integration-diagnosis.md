# Diagnóstico: integração de IA local com Ollama no CRM

Data: 2026-06-08

Projeto: Demetra Agro Performance / SalesForce Pro

## Escopo e premissas

Este diagnóstico investiga a preparação atual do CRM para IA e propõe uma implementação segura, sem custo inicial, usando Ollama local ou remoto controlado pela empresa.

Premissas adotadas:

- Não implementar grandes mudanças nesta fase.
- Não adicionar custo com API paga.
- Não alterar payload UltraFV3.
- Não alterar módulos comerciais existentes.
- Manter possibilidade futura de provider OpenAI/ChatGPT.
- Considerar execução em Docker/Docker Compose e VPS HostGator possivelmente limitada em CPU/RAM.

## Sumário executivo

O CRM já tem uma base relevante para IA, mas ela está concentrada em inteligência comercial determinística e em uma integração OpenAI opcional para sugestão de cliente. Ainda não há provider genérico configurável nem integração com Ollama.

O melhor MVP é criar um endpoint backend `POST /ai/chat`, protegido por autenticação e rate limit, usando um provider configurável `AI_PROVIDER=ollama|openai`. Para reduzir risco funcional, a primeira UI deve ser uma área simples dentro do módulo **Assistente Técnico**, sem RAG/base documental, com prompt system contextual da Demetra Agro e sem tocar em UltraFV3 ou fluxos comerciais existentes.

## Arquivos e módulos de IA já existentes

### Backend

| Arquivo | Situação atual | Observações |
| --- | --- | --- |
| `apps/api/src/services/ai/index.ts` | Barrel/export do módulo de IA. | Exporta tipos, inteligência comercial determinística e cliente OpenAI. |
| `apps/api/src/services/ai/types.ts` | Tipos de insights. | Define itens como `TodayPriorityItem`, risco e payloads de resumo/insight. |
| `apps/api/src/services/ai/commercialIntelligenceService.ts` | Orquestra engine de inteligência comercial. | Existe modo `deterministic` e `hybrid`, porém `hybrid` ainda resolve para engine determinística. |
| `apps/api/src/services/ai/engines/commercialIntelligenceEngine.ts` | Interface de engine. | Define contrato para observação, oportunidade, resumo de cliente e prioridades do dia. |
| `apps/api/src/services/ai/engines/deterministicCommercialIntelligenceEngine.ts` | Engine atual. | Encapsula regras locais/determinísticas. |
| `apps/api/src/services/ai/calculateTodayPriorities.ts` | Priorização do dia. | Calcula prioridades com base em oportunidade, atividades e timeline. |
| `apps/api/src/services/ai/openaiClient.ts` | Cliente OpenAI opcional. | Chama `https://api.openai.com/v1/responses` quando `OPENAI_ENABLED=true` e há `OPENAI_API_KEY`. |
| `apps/api/src/services/clientSuggestion.ts` | Sugestão inteligente de cliente. | Usa fallback determinístico e tenta OpenAI apenas se o cliente estiver disponível. |
| `apps/api/src/services/clientAiContext.ts` | Montagem de contexto do cliente. | Agrega cliente, oportunidades abertas, atividades recentes, última compra e observação recente. |
| `apps/api/src/services/opportunityInsight.ts` | Insight determinístico de oportunidade. | Avalia risco e próxima ação a partir de follow-up, estágio, valor e observações. |
| `apps/api/src/services/opportunitySalesMessage.ts` | Mensagem comercial determinística. | Gera mensagem pronta para oportunidade, útil para WhatsApp. |
| `apps/api/src/services/clientSummary.ts` | Resumo determinístico de cliente. | Usado por rota de resumo IA. |
| `apps/api/src/services/activityObservationParser.ts` e `activityObservationInsights.ts` | Classificação determinística de observações. | Detecta intenção/interesse/sentimento por regras locais. |

### Rotas backend de IA já existentes

As rotas estão dentro de `apps/api/src/routes/crudRoutes.ts`:

| Rota | Método | Função atual | Provider externo? |
| --- | --- | --- | --- |
| `/ai/client-suggestion` | `POST` | Sugestão inteligente para Cliente 360. | Sim, OpenAI opcional; fallback determinístico. |
| `/clients/:id/ai-context` | `GET` | Contexto estruturado para IA/sugestões. | Não. |
| `/ai/opportunity-insight` | `POST` | Insight de risco/próxima ação da oportunidade. | Não, determinístico. |
| `/ai/client-summary/:clientId` | `GET` | Resumo do cliente. | Não, determinístico. |
| `/ai/opportunity-message` | `GET` | Mensagem comercial para oportunidade. | Não, determinístico. |
| `/ai/today-priorities` | `GET` | Prioridades do dia. | Não, determinístico. |

Observação importante: como `app.ts` monta `crudRoutes` tanto em `/` quanto em `/api`, as rotas acima ficam disponíveis também com prefixo `/api`, por exemplo `/api/ai/client-suggestion`.

### Frontend

| Arquivo | Situação atual | Observações |
| --- | --- | --- |
| `apps/web/src/App.tsx` | Registra rota lazy `/assistente-tecnico`. | Usa `RoleRoute` para `assistenteTecnico`. |
| `apps/web/src/pages/AssistenteTecnico.tsx` | Módulo Assistente Técnico existe. | Hoje contém calculadora de semeadura e VC, sem chat/LLM. |
| `apps/web/src/layouts/AppLayout.tsx` | Menu do Assistente Técnico. | Módulo aparece no menu. |
| `apps/web/src/lib/authorization.ts` | Permissões da rota. | `assistenteTecnico` permitido para diretor, gerente e vendedor. |
| `apps/web/src/pages/ClientDetailsPage.tsx` | Consome `/ai/client-suggestion`. | Mostra “Sugestão inteligente” com fonte IA ou sistema. |
| `apps/web/src/pages/HomePage.tsx` | Consome `/ai/today-priorities`. | Central do Dia já usa endpoint de IA determinística. |
| `apps/web/src/pages/OpportunityDetailsPage.tsx` | Consome `/ai/opportunity-insight` e `/ai/opportunity-message`. | Oportunidade já recebe insight e mensagem comercial. |
| `apps/web/src/pages/WhatsAppPage.tsx` | Tela de WhatsApp mockada. | Tem estrutura de chat visual, mas sem integração real/IA. |

## Variáveis de ambiente já existentes para OpenAI/ChatGPT

Já existem variáveis OpenAI no backend e no Docker Compose:

- `OPENAI_ENABLED`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

No `docker-compose.yml`, elas são repassadas ao serviço `api` com defaults seguros (`OPENAI_ENABLED=false`, chave vazia e modelo `gpt-4.1-mini`). No `env.ts`, são lidas como `openAiEnabled`, `openAiApiKey` e `openAiModel`.

Lacuna: `.env.example` ainda não documenta essas variáveis OpenAI e não há variáveis para Ollama/provider genérico.

## Estrutura atual para chamadas externas HTTP

O backend já usa `fetch` nativo do Node com `AbortSignal.timeout` para chamadas externas, portanto não é necessário adicionar dependência para o MVP.

Exemplos existentes:

- `apps/api/src/services/ai/openaiClient.ts`: chamada à API OpenAI com timeout e erro tipado.
- `apps/api/src/services/ultraFv3Client.ts`: chamadas HTTP externas ao UltraFV3, com timeout e diagnóstico.
- `apps/api/src/services/cnpjLookupService.ts`: chamada HTTP externa para consulta de CNPJ, também com timeout.

Para Ollama, é seguro seguir o mesmo padrão: `fetch`, `AbortSignal.timeout`, logs sanitizados, erro tipado e fallback controlado.

## Lacunas atuais

1. Não existe provider genérico `AI_PROVIDER`.
2. Não existe cliente Ollama.
3. Não existe endpoint genérico `POST /ai/chat`.
4. Não existe tela de chat/assistant no frontend.
5. O modo `hybrid` da inteligência comercial ainda aponta para a engine determinística, sem uso real de LLM.
6. O cliente OpenAI atual usa `/v1/responses`, enquanto a compatibilidade OpenAI do Ollama é mais adequada para `/v1/chat/completions`.
7. `.env.example` não documenta OpenAI nem Ollama.
8. `docker-compose.yml` não tem serviço `ollama` nem variáveis `OLLAMA_*`.
9. Não há estratégia documentada de limits para prompts/respostas no CRM.
10. Não há política explícita de sanitização/escopo de dados para prompts enviados a LLM.

## Melhor ponto inicial para integração

### Recomendado: Assistente Técnico

O módulo **Assistente Técnico** é o ponto inicial mais seguro para o MVP porque:

- Já existe como página e rota dedicada.
- Tem escopo técnico/agronômico e menor acoplamento com fechamento comercial.
- Permite iniciar com perguntas gerais e contexto Demetra Agro, sem consultar banco/RAG.
- Evita alterar Clientes, Oportunidades, WhatsApp e Central do Dia nesta primeira etapa.
- Reduz risco de impactar payload UltraFV3 e módulos comerciais existentes.

### Pontos futuros, em ordem sugerida

1. **Clientes**: refinar `/ai/client-suggestion` para usar provider configurável, mantendo fallback determinístico.
2. **Oportunidades**: opcionalmente refinar mensagem comercial/insight com LLM, sempre com fallback determinístico.
3. **WhatsApp**: sugerir respostas/mensagens, sem envio automático no início.
4. **Central do Dia**: resumir prioridades e plano de ação após validar custo/performance.
5. **RAG/base documental**: etapa posterior, depois de governança de documentos, chunking e permissões.

## Proposta de arquitetura

### Backend

Criar um módulo de IA generativa separado da inteligência comercial determinística:

```text
apps/api/src/services/ai/
  providers/
    types.ts
    ollamaChatClient.ts
    openAiChatClient.ts
    index.ts
  chatService.ts
apps/api/src/routes/aiRoutes.ts
```

Responsabilidades:

- `providers/types.ts`: contrato comum `chat(messages, options)`.
- `ollamaChatClient.ts`: chamada ao Ollama, preferencialmente `/v1/chat/completions` no MVP.
- `openAiChatClient.ts`: chamada futura à OpenAI, preferencialmente Chat Completions ou Responses adaptado ao mesmo contrato.
- `chatService.ts`: resolve provider por env, aplica prompt system, valida tamanho de entrada, timeout e logs.
- `aiRoutes.ts`: expõe `POST /ai/chat` e, opcionalmente, `GET /ai/health` para status interno.

### Frontend

Adicionar um card simples no `AssistenteTecnico.tsx`:

- Campo de pergunta.
- Botão “Perguntar ao assistente”.
- Área de resposta.
- Loading/erro amigável.
- Sem histórico persistente no MVP, ou histórico somente em memória da sessão.

### Segurança mínima

- Rota protegida por autenticação existente.
- Reutilizar rate limit já existente (`appUsageRateLimit` ou rate limit específico de IA).
- Limitar tamanho da pergunta, por exemplo 2.000–4.000 caracteres.
- Limitar resposta via `max_tokens`/`num_predict`.
- Não enviar segredos, tokens, credenciais ERP ou payloads UltraFV3.
- Logar apenas metadados: provider, modelo, elapsedMs, status, tamanho da pergunta/resposta, requestId; nunca prompt completo por padrão.
- Timeout curto no MVP: 20–60s, configurável.

## Variáveis de ambiente necessárias

Sugestão para MVP:

```env
AI_PROVIDER=ollama
AI_CHAT_ENABLED=true
AI_CHAT_TIMEOUT_MS=60000
AI_CHAT_MAX_INPUT_CHARS=4000
AI_CHAT_MAX_OUTPUT_TOKENS=512

OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODEL=qwen2.5:7b

OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
```

Compatibilidade com configuração atual:

- Manter `OPENAI_ENABLED`, `OPENAI_API_KEY` e `OPENAI_MODEL` por compatibilidade.
- Para o novo chat, preferir `AI_CHAT_ENABLED` e `AI_PROVIDER`.
- Se `AI_PROVIDER=openai`, exigir `OPENAI_API_KEY`.
- Se `AI_PROVIDER=ollama`, exigir `OLLAMA_BASE_URL` e `OLLAMA_MODEL`.

Observação: se a VPS for fraca, `OLLAMA_BASE_URL` deve poder apontar para outro servidor controlado pela empresa, por exemplo `http://192.168.x.x:11434` via VPN/rede privada/reverse proxy protegido, em vez de rodar Ollama dentro da VPS.

## Endpoint Ollama recomendado

### Preferência para MVP: `/v1/chat/completions`

Usar o endpoint OpenAI-compatible do Ollama simplifica provider configurável porque o payload é parecido com OpenAI Chat Completions:

```json
{
  "model": "qwen2.5:7b",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "stream": false,
  "temperature": 0.2,
  "max_tokens": 512
}
```

Vantagens:

- Facilita futura troca para OpenAI.
- Mantém contrato comum `messages`.
- Evita acoplar o serviço a detalhes nativos do Ollama no início.

### Alternativa: `/api/chat`

A API nativa do Ollama também funciona e pode expor opções específicas (`num_predict`, `keep_alive`, etc.). É uma boa alternativa caso alguma opção local seja necessária, mas aumenta a diferença entre providers.

Recomendação: começar com `/v1/chat/completions` e encapsular em `ollamaChatClient.ts`. Se houver limitação prática, trocar internamente para `/api/chat` sem mudar o contrato do endpoint `/ai/chat`.

## Prompt system inicial sugerido

```text
Você é o Assistente Técnico da Demetra Agro Performance, apoiando vendedores e equipe técnica em dúvidas agronômicas e comerciais de pré-venda.
Responda em português do Brasil, com linguagem clara, objetiva e segura.
Use raciocínio técnico conservador e destaque quando uma recomendação depender de análise local, bula, receituário agronômico, legislação, clima, solo, cultivar, estágio da cultura ou orientação de engenheiro agrônomo responsável.
Não invente dados, preços, disponibilidade de produtos, condições comerciais ou informações do ERP/UltraFV3.
Não prometa resultados agronômicos garantidos.
Quando faltar contexto, faça perguntas objetivas antes de recomendar.
Para esta primeira versão, não use base documental/RAG; responda apenas com conhecimento geral e boas práticas.
```

## Riscos de rodar Ollama na VPS HostGator

1. **RAM insuficiente**: modelos 7B/8B podem exigir vários GB de RAM, principalmente com contexto maior.
2. **CPU limitada**: sem GPU, respostas podem ficar lentas e competir com API, web e PostgreSQL.
3. **Swap/IO**: se faltar memória, o sistema pode usar swap e degradar todo o CRM.
4. **Concorrência**: múltiplos usuários perguntando ao mesmo tempo podem travar ou gerar timeouts.
5. **Disco**: modelos ocupam GBs e podem pressionar armazenamento/backup.
6. **Disponibilidade**: se Ollama rodar no mesmo host, pico de inferência pode afetar o CRM.
7. **Segurança de rede**: nunca expor `11434` publicamente sem autenticação/restrição; preferir rede Docker interna, VPN ou proxy protegido.
8. **Manutenção**: atualização de modelo/Ollama pode exigir janela operacional.

Mitigações recomendadas:

- Começar com `AI_CHAT_ENABLED=false` em produção até validar recursos.
- Habilitar por usuário/ambiente depois de teste de carga manual.
- Timeout e rate limit específicos para `/ai/chat`.
- Permitir `OLLAMA_BASE_URL` externo para servidor mais forte da empresa.
- Monitorar CPU, RAM e tempo de resposta.
- Não colocar Ollama no mesmo Compose em produção se a VPS for muito limitada.

## Modelo local leve recomendado

Para VPS fraca, começar pequeno:

1. **`qwen2.5:3b`**: melhor opção leve para validar MVP com menor consumo.
2. **`llama3.2:3b`**: alternativa leve e rápida para perguntas gerais.
3. **`qwen2.5:7b`**: melhor qualidade, mas exige mais RAM/CPU; usar se a VPS suportar.
4. **`llama3.1:8b`**: qualidade boa, mas provavelmente pesado para HostGator sem GPU.

Recomendação prática: configurar default conservador em produção como `qwen2.5:3b` e deixar `qwen2.5:7b`/`llama3.1:8b` apenas para servidor com RAM adequada. Se o objetivo for qualidade em português/agro e houver servidor local melhor, testar `qwen2.5:7b` primeiro.

## Plano de implementação em etapas

### Etapa 0 — Preparação segura

- Documentar envs no `.env.example`.
- Adicionar envs ao `env.ts` sem mudar comportamento atual.
- Manter `AI_CHAT_ENABLED=false` por padrão.
- Não mexer em UltraFV3 nem em rotas comerciais.

### Etapa 1 — Provider Ollama e endpoint backend

- Criar contrato comum de chat.
- Implementar `ollamaChatClient` usando `/v1/chat/completions`.
- Criar `chatService` com prompt system, validação de entrada, timeout e logs sanitizados.
- Criar `POST /ai/chat` retornando `{ answer, provider, model, elapsedMs }`.
- Proteger com autenticação/rate limit.

### Etapa 2 — UI mínima no Assistente Técnico

- Adicionar card “Perguntar ao Assistente Técnico”.
- Enviar pergunta para `/ai/chat`.
- Exibir resposta simples, loading e erro amigável.
- Sem RAG, sem histórico persistido, sem gravação no banco.

### Etapa 3 — Docker/infra controlada

- Para desenvolvimento: opcional `ollama` no Compose ou documentação para usar Ollama local no host.
- Para produção: decidir se Ollama roda na VPS ou em outro servidor.
- Se rodar no Compose, usar rede interna e volume de modelos.
- Se rodar fora da VPS, apontar `OLLAMA_BASE_URL` para host privado/protegido.

### Etapa 4 — Evolução para clientes/oportunidades

- Adaptar `/ai/client-suggestion` para provider configurável, mantendo fallback determinístico obrigatório.
- Avaliar geração de mensagem em Oportunidades com LLM, mantendo `generateSalesMessage` como fallback.
- Adicionar guardrails por módulo e por perfil.

### Etapa 5 — RAG/base documental (não no MVP)

- Definir fontes oficiais, versionamento, permissões e atualização.
- Implementar ingestão/chunking apenas depois de validar o chat básico.
- Evitar misturar documentos comerciais sensíveis com respostas gerais sem autorização.

## Menor MVP possível

1. Backend `POST /ai/chat`.
2. Provider `ollama` configurável via env.
3. `OLLAMA_BASE_URL` apontando para `http://ollama:11434` ou servidor externo da empresa.
4. `OLLAMA_MODEL` inicial leve (`qwen2.5:3b` em VPS fraca; `qwen2.5:7b` se houver RAM suficiente).
5. Tela simples no **Assistente Técnico**.
6. Prompt system com contexto Demetra Agro.
7. Sem RAG/base documental.
8. Sem alteração em UltraFV3.
9. Sem alteração nos módulos comerciais atuais.
10. Fallback amigável quando IA estiver desabilitada/timeout.

## Critérios de aceite sugeridos para o MVP

- Com `AI_CHAT_ENABLED=false`, `POST /ai/chat` retorna erro controlado sem quebrar o app.
- Com `AI_PROVIDER=ollama` e Ollama ativo, uma pergunta simples retorna resposta em PT-BR.
- Timeout do Ollama não derruba a API e retorna mensagem amigável.
- Logs não contêm prompt completo nem dados sensíveis.
- Frontend do Assistente Técnico continua carregando calculadoras existentes.
- Nenhuma rota UltraFV3, Clientes, Oportunidades, WhatsApp ou Central do Dia muda de payload/comportamento.
