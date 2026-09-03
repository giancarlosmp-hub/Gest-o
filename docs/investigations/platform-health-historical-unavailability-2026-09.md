# Saúde da Plataforma — indisponibilidade histórica (03/09/2026)

## Reconciliação sem acesso a produção

O checkout recebido está em `16dba36` (merge da PR #851). O `FETCH_HEAD` local aponta a `main` para o mesmo SHA. A PR #850 é ancestral (`e83b0a4`), mas a última identidade produtiva registrada nos documentos é `72edf59` (PR #849); portanto #850 continua **não comprovada em produção**. A tentativa de `git fetch origin main` foi bloqueada pelo proxy do ambiente (HTTP 403). Nenhuma conclusão de deploy foi misturada à análise de código, e produção não foi acessada ou alterada.

INC-ERP-5050 permanece resolvido conforme a evidência operacional fornecida (execuções automáticas das 15:00 e 16:00). Não houve Recovery, sincronização manual ou chamada ao UltraFV3.

## Call graph e causas comprovadas

O navegador construía `baseURL=/api` + `/platform-health/snapshot`. O Nginx do container usava `proxy_pass http://api:4000/`, cujo `/` final removia `/api`; a API, porém, registrava Saúde somente em `/api/platform-health`. Assim, o request público virava `/platform-health/snapshot` e terminava em 404. Em desenvolvimento o cliente desviava para `http://localhost:4000` sem `/api`, com o mesmo resultado, embora a rota local explicitamente prefixada funcionasse. O fallback SPA não é aplicado dentro de `location /api/`.

A indisponibilidade atual é esse desencontro entre cliente, proxies e registro Express. Os zeros históricos tinham outra causa: `metricFrom` convertia métrica ausente, objeto ausente e valor inválido em `0`, e a UI usava fallbacks falsy/opcionais. Isso confundia ausência de instrumentação/falha com zero legítimo.

Call graph corrigido: página → cliente único (`/api` + constante `/platform-health`) → Bearer do interceptor → proxy Vite/Nginx preservando `/api` (ou alias legado quando o proxy externo remove o prefixo) → router duplo → `authMiddleware` → RBAC diretor/gerente → coleta Prisma bounded → projeção sanitizada → contrato Zod v3 → validação Zod no navegador → estados explícitos.

## Contrato, banco e segurança

O contrato `3.0` aceita `available`, `empty` e `partial`; métricas ausentes são `null`, enquanto zero numérico permanece zero. Uma falha total responde 503 sanitizado e o frontend descarta o snapshot anterior. Refreshes têm timeout de 12 s e uma sequência monotônica impede uma resposta antiga de vencer a mais nova.

As consultas usam as tabelas `ErpSyncRun`, `ErpSyncLock`, `Client`, `Contact` e `ClientCodeAudit`, janelas UTC e limites. A execução automática canônica continua sendo somente `scope=automatic` + `trigger=scheduler`. O payload deixou de transportar ids de run, correlationId, mensagens de erro, IP, requestId, e-mail, Partner ERP e identidade de cliente. A auditoria publica apenas instante, classe de origem e classe de alteração.

Produção opera com `TENANCY_MODE=disabled`; portanto o painel é administrativo global e não afirma isolamento multi-tenant ativo. Não se habilitou tenancy nem se criou migração. Antes de habilitar `default-only`, as agregações globais devem receber contexto obrigatório e testes PostgreSQL específicos; falhar fechado é preferível a alegar isolamento inexistente.

## Validação pós-deploy e rollback

Após merge e deploy oficial, provar que os SHAs API/WEB/domínio convergem; autenticar como diretor e gerente; verificar 200 JSON e `contractVersion=3.0` no domínio; verificar 401 sem Bearer, 403 como vendedor, zero/ausente/parcial, atualização, timeout e ausência de campos sensíveis. Confirmar separadamente a presença visual da PR #850. Não executar sincronização para validar o painel.

Rollback: reverter este único commit e republicar API e WEB pelo fluxo oficial. Não há DDL, migration, backfill nem alteração de dados.
