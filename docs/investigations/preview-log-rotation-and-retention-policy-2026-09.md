# Diagnóstico de Correlação Run-PR, Rotação de Logs e Política de Retenção de Previews

**Data:** Setembro 2026
**Status:** Diagnosticado e Implementado em Código com Testes (Sem execuções destrutivas na VPS)

---

## 1. Causa Raiz Comprovada e Análise Específica da PR #881 (`run_pr_correlation_missing`)

### Análise Detalhada dos Endpoints e Run `35668904948` (Projeto `gesto-pr-881-35668904948-1`)

1. **Resposta real do endpoint top-level `/actions/runs/35668904948`:**
   Retorna o objeto de workflow run contendo `id: 35668904948`, `name: "Preview Deploy"`, `path: ".github/workflows/preview.yml"`, `event: "pull_request"`, `head_branch: "fix/preview-run-pr-correlation-and-logging-13429101441148764393"`, `head_sha: "ef1bd1069cb23e1e887aef7154d94fae8879797e"`, `status: "completed"`, `conclusion: "failure"` (no run inicial devido ao preflight de capacidade de redes da VPS) e **`pull_requests: []`**.

2. **Resposta do endpoint `/actions/runs/35668904948/attempts/1`:**
   Retorna a tentativa imutável com `run_attempt: 1`, `status: "completed"`, `conclusion: "failure"`, `head_sha`, `head_branch`, `name: "Preview Deploy"`, `path: ".github/workflows/preview.yml"`, `event: "pull_request"` e **`pull_requests: []`**.

3. **Valores dos campos de identidade:**
   - `pull_requests`: `[]` (vazio na API REST do GitHub para PRs fechadas ou mescladas).
   - `event`: `"pull_request"`.
   - `head_branch`: ref exata da branch da PR #881 (`fix/preview-run-pr-correlation-and-logging-13429101441148764393`).
   - `head_sha`: commit SHA da PR.
   - `run_attempt`: 1.
   - `conclusion`: `"failure"` na execução inicial de deploy (devido a `PREVIEW_NETWORK_CAPACITY=FAIL`), ou `"success"` em execuções de deploy com sucesso.

4. **Confirmação do repositório e número da tentativa:**
   - O código consulta o repositório correto `giancarlosmp-hub/Gest-o` via `https://api.github.com/repos/giancarlosmp-hub/Gest-o`.
   - O código consulta a tentativa exata `1` registrada no manifesto e nas labels OCI.

5. **Por que o fallback top-level ainda não autorizava a correlação após o merge:**
   - Quando uma PR é mesclada ou fechada no GitHub, a API REST do GitHub limpa a propriedade `pull_requests` (retornando `[]`) em **ambos** os endpoints (`/actions/runs/{run_id}` e `/actions/runs/{run_id}/attempts/{attempt}`).
   - Como a lógica procurava a PR dentro do array `pull_requests`, o resultado de `pullRequests.find(...)` retornava `undefined`, disparando `die('run_pr_correlation_missing')`.
   - **Garantia de Desambiguação:** Evento + branch + commit coincidentes isoladamente não comprovam unicidade para um número específico de PR caso existam múltiplas PRs para a mesma branch/commit. Por isso, a verificação consulta `GET /pulls?head={owner}:{branch}&state=all`. Se mais de uma PR for retornada para a mesma branch/commit, o sistema identifica ambiguidade e interrompe com `run_pr_correlation_missing`, preservando o candidato.

### Solução Implementada
1. No método `authenticateProducer()` de `scripts/preview-image-lifecycle.mjs`:
   - Quando a PR está fechada (`pr.state === 'closed'`) e o array `pull_requests` retorna vazio `[]` na API do GitHub:
     a) Valida `topRun.event === 'pull_request'`, `topRun.head_branch === pr.head?.ref` e `topRun.head_sha === expectedBase.commit` (ou `pr.head?.sha === expectedBase.commit`).
     b) Consulta `GET /pulls?head=${owner}:${pr.head.ref}&state=all` para verificar se existe exatamente 1 PR para a branch/commit.
     c) Se houver ambiguidade (múltiplas PRs para a mesma branch/commit), preserva fail-closed com `run_pr_correlation_missing`.
2. Se qualquer um dos campos (`event`, `head_branch`, `commit` ou `workflow`) divergir, o script aciona a proteção fail-closed (`run_pr_correlation_missing` / `authenticated_run_identity_diverged`) e preserva os recursos.

---

## 2. Rotação de Logs (Análise e Alterações)

### Inspeção
- A configuração `json-file` com limites de tamanho é definida nos arquivos Compose (`docker-compose.preview.yml` e `docker-compose.production.yml`).
- `docker-compose.preview.yml` define `x-preview-logging` com `max-size: "25m"` e `max-file: "4"`.
- Containers antigos de previews (como PRs #535, #538, #539, etc.) foram criados antes da inclusão dessas opções nos arquivos Compose, assumindo a configuração padrão da daemon (`{}` sem rotação).
- As opções de log do Docker são **imutáveis** na instância do container existente. Para aplicar limites de log a containers ativos antigos, o container precisa ser recriado (`docker compose up -d --force-recreate`).
- A recriação do container preserva integralmente os volumes PostgreSQL nomeados (`gesto_pgdata_pr_*`).
- Em `docker-compose.production.yml`, foi configurada a instrução `x-production-logging` (`max-size: "25m"`, `max-file: "4"`) para garantir limites em futuras implantações de produção.

---

## 3. Matriz de Política de Retenção para Previews

| Cenário | Ação / Retenção | Escopo e Impacto |
|---|---|---|
| **1 execução ativa por PR aberta** | PRESERVAR todos os recursos | Containers, redes, imagens, diretório de preview, volume PostgreSQL, manifesto e rota Nginx mantidos. |
| **Múltiplas execuções da mesma PR aberta** | PRESERVAR execução ativa (mais recente). Containers/redes da execução anterior podem ser desligados, mas o volume PostgreSQL e o manifesto NUNCA são removidos enquanto a PR estiver aberta. | Volume e manifesto PRESERVADOS. Rota Nginx aponta para a nova execução. |
| **Tentativas canceladas ou com falha** | PRESERVAR imagens e volumes para inspeção. Containers de runtime com falha são desmontados pelo trap de falha. Limpeza pós-merge preserva candidatos não bem-sucedidos (`reason=producer_run_not_successful`). | Volumes e imagens PRESERVADOS. |
| **Previews sem atividade (ociosos)** | PRESERVAR todos os recursos enquanto a PR estiver aberta. Proibida a remoção de recursos de PR aberta por idade. | Todos os recursos PRESERVADOS. |
| **PR Fechada ou Mesclada** | LIMPEZA AUTORIZADA somente após validação estrita de identidade, proveniência e sucesso no GitHub API. | Desmonta containers, redes, volumes, imagens, diretório de preview, manifesto e rota Nginx (se não houver outros recursos ativos). |
| **Rollback / Evidência Produtiva** | PRESERVAR imagem, container, volume e evidência. Cancelar exclusão imediatamente. | Todos os recursos PRESERVADOS. |

---

## 4. Plano de Migração para Containers Antigos (Execução Manual e Separada)

Para aplicar rotação de logs a containers de previews antigos que possuem `json-file` sem `max-size`:

1. Identificar o diretório do preview em `/var/www/preview/pr-<PR>/<PROJECT_NAME>`.
2. Executar o comando sem remover volumes de dados:
   ```bash
   cd /var/www/preview/pr-<PR>/<PROJECT_NAME>
   docker compose -p <PROJECT_NAME> -f docker-compose.yml -f docker-compose.preview.yml up -d --force-recreate
   ```
3. A recriação do container aplica as opções de log (`max-size: 25m`, `max-file: 4`), substituindo o arquivo de log JSON ilimitado por um arquivo rotacionado, preservando intactos o volume PostgreSQL nomeado e todos os dados.

---

## 5. Comando Somente Leitura para Medição de Logs

Para medir os 20 maiores arquivos de log dos containers na VPS antes e depois de qualquer intervenção:

```bash
du -ch /var/lib/docker/containers/*/*-json.log | sort -h | tail -n 20
```

---

## 6. Confirmação Operacional na VPS

**CONFIRMAÇÃO EXPLICITA:** Nenhuma ação mutativa, remoção, deploy, prune, truncamento de logs, recriação de container ou alteração de arquivos foi executada no servidor VPS durante esta investigação e implementação de código.
