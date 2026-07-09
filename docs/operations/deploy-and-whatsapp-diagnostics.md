# Diagnóstico pós-merge: deploy, Central do Dia e WhatsApp

## Deploy automático

O repositório possui o workflow `.github/workflows/deploy-production.yml` para deploy de produção. Ele roda em `push` para `main` e também por `workflow_dispatch` com confirmação `production`.

O workflow conecta por SSH no servidor, entra em `/apps/gest-o`, sincroniza `origin/main` com `git pull --ff-only` e executa `scripts/deploy-production.sh`.

O script de deploy usa Docker Compose v2 no arquivo padrão `docker-compose.yml`, carrega `/root/demetra-env/.env` quando existir, valida `docker compose config`, reconstrói `api web` e sobe os mesmos serviços. O comando manual seguro equivalente é:

```bash
cd /apps/gest-o
git fetch origin main
git checkout main
git pull --ff-only origin main
bash scripts/deploy-production.sh
```

Para diagnosticar produção sem alterar dados, conferir no servidor:

```bash
cd /apps/gest-o
git status --short --branch
git rev-parse --short HEAD
docker compose ps
docker compose images api web
```

Nesta PR o script passou a imprimir branch/status Git e IDs das imagens usadas pelos containers após o deploy, para diferenciar falha de workflow, branch incorreta, imagem antiga ou cache do navegador.

## Cache do frontend

O Nginx já mantinha `/assets/` com cache imutável, adequado para assets versionados do Vite, e `index.html` sem cache. A rota SPA `/` agora também envia headers `no-cache, no-store, must-revalidate`, reduzindo risco de shell HTML antigo em navegação direta/fallback.

## WhatsApp atual

Existe a página `apps/web/src/pages/WhatsAppPage.tsx`, acessível pela rota `/whatsapp`. Ela gera uma mensagem assistida por IA/fallback e abre WhatsApp/Web WhatsApp via URL; o envio real depende de ação manual do usuário.

No backend existem endpoints para gerar mensagem (`POST /ai/assistant-whatsapp-message`) e registrar contato (`POST /assistant-whatsapp/contact`). O registro cria uma `Activity` do tipo `whatsapp` e um `TimelineEvent` do tipo `status` com descrição de contato via WhatsApp.

O schema Prisma possui `ActivityType.whatsapp` e `TimelineEvent`, mas não há model dedicado de conversas/mensagens, webhook de provedor, armazenamento de mensagens recebidas/enviadas, nem integração real com API externa de WhatsApp nesta base.

## Recomendação para próxima PR de WhatsApp real

Fazer uma PR separada com desenho pequeno e seguro:

1. Escolher provedor oficial/compatível (ex.: WhatsApp Business Cloud API) e variáveis de ambiente isoladas.
2. Criar models de conversa/mensagem e vínculo opcional com cliente/oportunidade/atividade/timeline.
3. Adicionar webhook assinado/idempotente para mensagens e status de entrega.
4. Implementar envio backend auditável, sem expor token no frontend.
5. Gravar timeline resumida por conversa/contato para não poluir a linha do tempo com cada evento técnico.
6. Incluir feature flag para ativação gradual por perfil/ambiente.
