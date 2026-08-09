# Plano de backfill condicionado ao preflight

## Contrato e fronteira

O contrato `1.0B.2-M/v1` aceita somente o envelope imutável `1.0B.2-L/v1`, com inventário fechado `1.0B.2-A/roots-v1`, exatamente os 11 roots e SHA-256 recalculado. Campos desconhecidos, versão/hash/tempo inválidos, relatório parcial, blockers, quarentena, tenant ausente/suspenso, membership ambígua e leitura incompleta falham fechados antes de existir plano. Somente códigos técnicos sanitizados são devolvidos no resultado `PREFLIGHT_GATED_BACKFILL_PLAN=BLOCKED`.

Evidência sintética só pode ser habilitada explicitamente pelo harness e nunca pode se apresentar como produtiva. Evidência produtiva também não é aceita pelo caminho padrão: esta Sprint não acessou produção. Um registry compartilhado liga atomicamente `evidenceId` ao `evidenceHash`; replay idêntico é determinístico e qualquer troca posterior do relatório é recusada.

## Plano permitido

O resultado READY preserva `evidenceId` e `evidenceHash`, tenant técnico, ordem canônica dos 11 roots, total/NULL, batches limitados, cursores SHA-256 determinísticos e hashes por root. O `planHash` cobre o plano inteiro e fica inseparavelmente ligado ao `evidenceHash`. `dryRunOnly=true`, `applyAuthorized=false`, blockers/quarentena são zero. **READY para gerar plano não autoriza apply.** Não existe função de DML, escrita de ledger produtivo ou conexão de banco no planejador.

## Expiração, auditoria, risco e rollback

A janela padrão é 24 horas, configurável pelo chamador de prova; timestamp futuro/inválido/expirado bloqueia. A auditoria deve preservar envelope e plano imutáveis, hashes e blocker codes sanitizados, nunca payload empresarial. Riscos pendentes incluem armazenamento distribuído do registry/ledger, autorização produtiva, escala, locks, WAL e restore. Concorrência sem registry compartilhado falha fechada. Rollback remove módulo, testes, gate e documentação; não há dados ou schema a reverter.

O harness PostgreSQL 16 usa rede interna sem porta publicada, recusa `DATABASE_URL`, executa `docker exec -i`/`psql -X`/`ON_ERROR_STOP=1`, lê em transação read-only, compara hashes antes/depois e prova ausência de tabelas de plano/ledger.
