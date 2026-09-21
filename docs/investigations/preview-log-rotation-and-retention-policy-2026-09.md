# Diagnóstico de Correlação Run-PR, Rotação de Logs e Política de Retenção de Previews

**Data:** Setembro 2026
**Status:** Diagnosticado e Implementado em Código com Testes (Sem execuções destrutivas na VPS)

---

## 1. Causa Raiz Comprovada (`run_pr_correlation_missing`)

### Sintoma
Na PR #880 (e workflows pós-merge de cleanup), o workflow `preview-cleanup.yml` executou com sucesso, porém o script `preview-image-lifecycle.mjs` retornou:
```text
PREVIEW_IMAGE_RESULT=PRESERVED reason=run_pr_correlation_missing
PREVIEW_PROJECT_CLEANUP=PRESERVED project=gesto-pr-880-35529184912-1
PREVIEW_PROJECT_CLEANUP=PRESERVED project=gesto-pr-880-35554756505-2
...
```

### Causa Raiz
1. O script `preview-image-lifecycle.mjs` autenticava o produtor consultando **exclusivamente** o endpoint de tentativa específica:
   `GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{run_attempt}`.
2. Na API REST do GitHub Actions, a sub-rota `/attempts/{attempt_number}` retorna metadados da tentativa (status, conclusão, run_attempt), mas omite ou retorna o array `pull_requests` vazio (`[]`), pois as associações de Pull Request pertencem ao objeto top-level da execução (`GET /repos/{owner}/{repo}/actions/runs/{run_id}`).
3. Como a consulta era feita apenas no sub-recurso de tentativa, a propriedade `run.pull_requests` retornava vazia (`[]`), resultando em `correlatedPull = undefined`.
4. O mecanismo fail-closed acionou `die('run_pr_correlation_missing')` preservando os recursos para evitar exclusão indevida.

### Solução Implementada
1. No método `authenticateProducer()` de `scripts/preview-image-lifecycle.mjs`, o código passa a consultar **ambos** os endpoints:
   - Objeto top-level: `GET /actions/runs/${run_id}` (de onde extrai `topRun.pull_requests`).
   - Objeto da tentativa: `GET /actions/runs/${run_id}/attempts/${run_attempt}` (de onde valida `status === 'completed'`, `conclusion === 'success'`, `run_attempt`).
2. Se `pull_requests` estiver presente no objeto top-level, ele é utilizado para correlacionar a PR com o commit da PR.
3. Se o array `pull_requests` continuar ausente em ambos os endpoints, a proteção fail-closed aciona `run_pr_correlation_missing` e preserva o candidato.

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
