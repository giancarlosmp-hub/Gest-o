# Production Schema PR827 — lições consolidadas do rollout

## Evidência conclusiva do legado — run 33213116026 / job 98990686108

O diagnóstico read-only comprovou database, usuário administrativo, schema e `search_path` esperados em PostgreSQL 16.14, e distinguiu ausência global de `_prisma_migrations` de invisibilidade. Os catálogos de tenancy e PR827 estavam ausentes e nenhuma escrita ocorreu. A causa raiz foi impor um ledger Prisma e o predecessor de tenancy escolhido pela ordem dos diretórios, embora produção use bundles `applied.tsv` da transição SQL de julho.

O contrato corrigido trata `20260731150000_safe_production_schema_transition` como baseline real e valida `ErpOrderSync.id`, `Opportunity.id`, `User.id` e `Role`. O SQL PR827 não referencia Tenant nem `tenantId`. Preview dispensa imagem e não escreve. Apply mantém confirmação, SHA, backup, imagem, transação, publicação atômica, catálogo exato, diff vazio e idempotência.

Data de consolidação: 2026-08-28. Este registro não é autorização operacional.

| Falha observada | Causa | Correção | Regressão obrigatória |
|---|---|---|---|
| `production environment file absent` (run `33196976100`, job `98936493036`) | O workflow assumia o caminho canônico, mas a fonte real era a cópia legada protegida. | Usar o resolvedor existente, exigir exatamente uma fonte e entregar ao runner somente classe e referência validada. | `pr827-production-env-safety.sh`: cardinalidade, arquivo regular, owner/mode, sintaxe, `DATABASE_URL` única e hash imutável. |
| token literal `:'migration_name'` (run `33199668348`, job `98945662977`) | `psql -c` não fez a substituição esperada e enviou o token ao servidor. | SQL em stdin por heredoc literal e valor em `--set`, depois da allowlist. | `pr827-schema-runner-safety.mjs`: proíbe interpolação shell e `-c` no bloco parametrizado. |
| `_prisma_migrations` ausente (run `33204493337`, job `98961963978`) | O runner novo assumiu um ledger Prisma, contrariando o contrato histórico documentado: produção foi sincronizada por `prisma db push` e a transição SQL de julho gerou `applied.tsv`, não ledger. A mensagem isolada prova apenas que a relação não estava visível no `search_path`; ainda não prova ausência global nem exclui outro schema. | O preview passa a classificar conexão, schema, `search_path`, versão PostgreSQL, localização/visibilidade do ledger, catálogo predecessor e catálogo PR827, somente em transações read-only. Ledger ausente ou fora de `public` continua falha fechada; apply segue bloqueado. | Teste estático exige todas as sondagens sanitizadas, `BEGIN TRANSACTION READ ONLY`, ausência de DDL/DML no diagnóstico e falha antes da consulta ao ledger. |
| SQL diagnóstico inválido (run `33206303362`, job `98968114798`) | A revisão foi somente estática e aceitou `current_schemas(false)[1]`, sintaxe que o PostgreSQL 16 rejeita. | O acesso posicional agora é `(current_schemas(false))[1]`; os blocos reais foram extraídos para arquivos únicos, executados pelo runner e pelo harness. | `test:pr827-preview:postgres` executa conexão, ledger, predecessor e catálogo PR827 reais, cobre todos os estados e `search_path`, e prova que uma escrita em transação read-only é recusada. |

## Contrato legado proposto, não adotado automaticamente

Se a nova sondagem confirmar ledger globalmente ausente, classificar a história como
`LEGACY_NO_PRISMA_LEDGER`: exigir catálogo exato dos 11 roots da migration predecessor,
checksum versionado, evidência histórica `applied.tsv`/diff do SHA correspondente e revisão
humana auditada. Isso pode provar a precondição estrutural, mas **não** equivale a registro
Prisma e não autoriza o runner atual a inserir baseline. A eventual criação/adoção de ledger
é uma mudança operacional separada. Até essa decisão, preview termina em erro e apply não é
alcançável.

## PR827 final — histórico legado e incidente UltraFV3/Tailscale (31/08/2026)

O run `33383729453`/job `99461567959` falhou no estágio de metadata da raiz do histórico, antes de PostgreSQL e sem escrita: `SCHEMA_EVIDENCE_DIR_MODE` recebeu a classe produtiva `755_PROTECTED_BUNDLE_ROOT`, enquanto o runner permitia apenas `700_OWNER_PRIVATE` e `750_GROUP_TRAVERSE`. Isso não era `ERP_PRODUCTION_ENV_SOURCE=legacy_build_only`, `PR827_ENV_SOURCE=legacy_copy`, nem o modo `preview/apply`; era a permissão da raiz que contém os bundles protegidos. O contrato agora valida explicitamente o par `legacy_build_only:legacy_copy`, aceita somente 700/750/755 na raiz, mantém diretórios de bundle em 700 e `applied.tsv`/`migration.sha256` em 600, e registra apenas variável, classes, classe recebida e estágio. Valores desconhecidos falham sem fallback. Preview e apply suportam exclusivamente `applied.tsv` + `migration.sha256`; `_prisma_migrations` e `tenancy_expand_roots` não são exigidos. Preview não exige imagem e não escreve.

A causa operacional comprovada da indisponibilidade foi o peer Windows “servidor” offline no Tailscale; a VPS permaneceu conectada. Após reconectar o Windows e iniciar o UltraFV3Rest, as simulações passaram e um único novo pedido real foi confirmado como ERP **900113**. Isso não caracteriza defeito do Tailscale e não autoriza novo pedido para evidência. O pedido antigo `6f5edc8a-55a7-4502-a816-a8b94b8e67c2`, confirmado ausente por operador no UltraFV3, permanece imutável e bloqueado até o diretor registrar resolução append-only e o fluxo criar exatamente uma tentativa com `supersedesErpOrderSyncId`; nunca há resolução ou reenvio automático.

Antes de simulação/envio, `GET /salesmen` funciona como preflight read-only limitado a 10 s. Falha de timeout/conexão/autenticação bloqueia antes de qualquer `ErpOrderSync` e apresenta: “UltraFV3 indisponível. Verifique se o servidor, Tailscale e UltraFV3Rest estão conectados antes de tentar novamente.” Logs registram somente `correlationId`, classe `ERP_REACHABILITY`, classe de endpoint, duração e razão `timeout|connect|auth|5xx`. `scripts/diagnose-ultrafv3-reachability.sh` faz diagnóstico periódico GET-only, publica estado sanitizado para Saúde da Plataforma e retorna falha para o alertador; recuperação jamais chama `POST /orders`. No Windows, `scripts/windows/Ensure-UltraFV3Connectivity.ps1` configura o serviço Tailscale como Automatic, verifica conexão e inicia UltraFV3Rest apenas se parado, de forma idempotente e sem dados de rede no log. Instalação/execução remota não faz parte desta entrega.

Alternativas documentadas, não implementadas: manter Tailscale com autostart/watchdog é a recomendação atual; Cloudflare Tunnel autenticado e WireGuard site-to-site são alternativas futuras; IP público fixo/porta exposta não é recomendado sem reverse proxy, TLS, firewall, autenticação forte e allowlist.
