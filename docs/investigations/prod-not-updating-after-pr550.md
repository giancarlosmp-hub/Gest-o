# Investigação — produção não atualiza após merge da PR #550

Data: 2026-04-25 (UTC)

## Escopo e limitação da investigação

Esta investigação foi feita **sem alterar código funcional** da aplicação. O diagnóstico foi baseado em:

- inspeção dos workflows e arquivos de infraestrutura presentes no repositório;
- inspeção do histórico Git local (incluindo merge da PR #550);
- comparação entre esteira de preview e produção.

**Limitação importante:** não há acesso direto à execução do GitHub Actions da organização (runner/logs) nem acesso SSH à VPS nesta sessão. Portanto, itens de status em runtime da VPS (containers ativos, hash da imagem em execução, cache efetivo do Nginx) são descritos como **procedimento de validação** com comandos objetivos.

---

## 1) Workflows GitHub Actions (produção)

### Workflow responsável por deploy de produção

Arquivo: `.github/workflows/deploy-prod.yml`

- trigger atual: `on.push.branches = [main]`
- job: `deploy-prod`
- ação remota: `appleboy/ssh-action@v1.2.0`
- script remoto:
  - usa diretório `APP_DIR="/apps/production"`;
  - faz `git fetch origin && git checkout main && git reset --hard origin/main`;
  - executa `docker compose pull || true`;
  - executa `docker compose up -d --no-deps --build api web`.

### Verificação sobre disparo no merge da PR #550

No histórico local há merge commit da PR #550:

- `0cd8e5c Merge pull request #550 ...`

Isso confirma que a PR #550 foi mergeada na linha principal deste checkout.

⚠️ **Não foi possível confirmar aqui** se o workflow realmente iniciou/falhou/cancelou no GitHub Actions, pois não há CLI `gh` instalada e não há acesso aos logs da organização nesta sessão.

---

## 2) Branches e branch de deploy

### Branch esperada pelo deploy

- O workflow de produção está fixado em `main` (trigger e reset para `origin/main`).
- Não há referência a `principal` ou `master` no deploy de produção.

### Evidência de possível divergência operacional

O serviço systemd versionado no repositório (`docs/ops/gest-o.service`) usa:

- `WorkingDirectory=/apps/gest-o`
- `ExecStart=/usr/bin/docker compose up -d`

Já o workflow de produção atua em **outro diretório**:

- `APP_DIR="/apps/production"`

Isso indica provável cenário de **duas raízes de deploy** (ou documentação/operação divergente):

- esteira automática atualiza `/apps/production`;
- stack efetivamente servindo produção pode estar em `/apps/gest-o`.

Se a produção real estiver rodando de `/apps/gest-o`, atualizar `/apps/production` **não muda o que o domínio público entrega**.

---

## 3) VPS / Deploy (diagnóstico de mecanismo)

### Diferença crítica de robustez entre deploy local e deploy Actions

`deploy.sh` (fluxo operacional robusto) inclui:

- sync de repositório com `origin/main`;
- backup obrigatório;
- snapshot/validação de segurança de dados;
- `docker compose down` + `docker compose up -d --build`;
- validações de health.

Workflow `deploy-prod.yml` faz fluxo **mínimo**:

- `docker compose pull || true` (pouco útil para serviços `build:` sem `image:` tag fixa);
- `docker compose up -d --no-deps --build api web` (sem `down`, sem validação explícita pós-deploy, sem auditoria).

### Risco associado

Se houver stack ativa em outro diretório/projeto compose, o comando pode:

- atualizar containers que não são os publicados no domínio;
- ou falhar por conflito de portas sem visibilidade operacional consolidada.

---

## 4) Containers (o que precisa ser confirmado na VPS)

Para fechar prova material de causa raiz, validar na VPS (produção):

```bash
# 1) qual stack está ativa de fato
cd /apps/gest-o && docker compose ps
cd /apps/production && docker compose ps

# 2) timestamps e imagem efetiva dos containers web/api em cada diretório
cd /apps/gest-o && docker compose images && docker compose ps
cd /apps/production && docker compose images && docker compose ps

# 3) commit do código em cada diretório
cd /apps/gest-o && git rev-parse --short HEAD && git log -1 --oneline
cd /apps/production && git rev-parse --short HEAD && git log -1 --oneline
```

Esperado para confirmar hipótese principal:

- `/apps/production` com commit novo (incluindo PR #550);
- `/apps/gest-o` com commit antigo (sem Sidebar V2);
- domínio em produção apontando para a stack do `/apps/gest-o`.

---

## 5) Build frontend (prova dentro do container)

Validar no container que realmente atende produção:

```bash
# dentro da stack ativa de produção
docker compose exec -T web sh -lc 'ls -lah /usr/share/nginx/html/assets | head'
docker compose exec -T web sh -lc 'grep -R "Recolher\|Expandir\|sidebar" /usr/share/nginx/html/assets | head -n 20'
```

E no código fonte do diretório ativo:

```bash
# conferir se AppLayout com Sidebar V2 está no diretório realmente usado pela stack ativa
sed -n '1,220p' apps/web/src/layouts/AppLayout.tsx
```

Se os assets do container ativo não contiverem strings/estrutura compatíveis com Sidebar V2, o build servido é antigo.

---

## 6) Nginx / cache

Checklist objetivo na VPS:

```bash
# verificar vhost efetivo do domínio de produção
sudo nginx -T | sed -n '/server_name crm.demetraagronegocios.com.br/,+80p'

# validar headers e asset hash servido externamente
curl -I https://crm.demetraagronegocios.com.br/
curl -s https://crm.demetraagronegocios.com.br/ | head -n 40

# validar se hash de assets muda após deploy
curl -s https://crm.demetraagronegocios.com.br/ | grep -Eo 'assets/[^"'"']+\.(js|css)' | head
```

Se o HTML continua referenciando hash antigo de assets, não houve publicação efetiva da nova build na stack que o Nginx aponta.

---

## 7) Preview vs Produção — diferenças encontradas

### Preview (`.github/workflows/preview.yml`)

- provisiona diretório dedicado por PR (`/var/www/preview/pr-<N>`);
- clona branch do PR;
- usa compose com override de preview (`-f docker-compose.yml -f docker-compose.preview.yml`);
- executa `down --remove-orphans` e `up -d --build`;
- roda checks de saúde de API, WEB e proxy reverso;
- falha explicitamente em inconsistências.

### Produção (`.github/workflows/deploy-prod.yml`)

- usa diretório fixo `/apps/production`;
- só atualiza `api` e `web` com `up -d --no-deps --build`;
- não executa validações pós-deploy;
- não garante convergência com diretório real de operação citado em `docs/ops/gest-o.service` (`/apps/gest-o`).

---

## 8) Conclusão técnica (causa raiz)

## Causa raiz confirmada no repositório

**Inconsistência de alvo de deploy em produção (path drift):**

- workflow automático publica em `/apps/production`;
- operação versionada indica stack de produção em `/apps/gest-o`.

Essa divergência explica exatamente o sintoma observado:

- preview da PR #550 mostra Sidebar V2 (pipeline de preview correta);
- produção permanece antiga porque a stack servida não é a que o workflow está atualizando.

## Evidências-chave

1. `deploy-prod.yml` usa `APP_DIR="/apps/production"`.
2. `docs/ops/gest-o.service` aponta `WorkingDirectory=/apps/gest-o`.
3. Histórico Git contém merge da PR #550 no tronco local (`0cd8e5c`).

---

## 9) Correção mínima necessária (plano exato, sem implementar ainda)

1. **Decidir e oficializar um único diretório de produção** (recomendado: o realmente usado pelo systemd/Nginx hoje).
2. **Alinhar `deploy-prod.yml` ao diretório oficial** (mesmo `WorkingDirectory` da stack publicada).
3. Adicionar validação pós-deploy mínima no workflow de produção:
   - `docker compose ps`;
   - healthcheck API e WEB;
   - registro do commit deployado (`git rev-parse --short HEAD`).
4. Opcional recomendado: reutilizar `bash deploy.sh` no job remoto para manter o mesmo mecanismo de segurança já adotado no deploy manual.
5. Executar validação final na VPS:
   - commit em runtime = commit de `origin/main` pós-PR #550;
   - assets web novos servidos no domínio de produção;
   - Sidebar V2 visível sem depender de cache local do navegador.

---

## Comandos de auditoria imediata (ordem sugerida)

```bash
# A. descobrir stack real em produção
cd /apps/gest-o && docker compose ps
cd /apps/production && docker compose ps

# B. comparar commit entre diretórios
cd /apps/gest-o && git log -1 --oneline
cd /apps/production && git log -1 --oneline

# C. validar conteúdo servido
curl -s https://crm.demetraagronegocios.com.br/ | grep -Eo 'assets/[^"'"']+\.(js|css)' | head

# D. validar build dentro do web ativo
cd <DIRETORIO_DA_STACK_ATIVA>
docker compose exec -T web sh -lc 'grep -R "Recolher\|Expandir" /usr/share/nginx/html/assets | head -n 20'
```

Se A/B confirmarem divergência de diretório + C/D confirmarem build antiga no diretório ativo, a causa raiz fica comprovada de ponta a ponta.
