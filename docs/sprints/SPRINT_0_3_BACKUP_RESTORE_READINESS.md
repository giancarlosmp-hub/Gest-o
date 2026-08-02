# Sprint 0.3 — Backup, restauração isolada e continuidade de dados

**Estágio:** 🔵 PR em 02/08/2026.
**Classificação:** ensaio técnico descartável; não é restore de produção.

## Objetivo e problema

Converter o backup de mero arquivo em recuperação verificável: catálogo e hash antes, restore
PostgreSQL 16 totalmente isolado, pós-condições objetivas, cleanup e evidência auditável. Hoje o
backup oficial é SQL compactado, enquanto o restore legado espera SQL descompactado e aponta
diretamente ao Compose operacional, sem checksum ou pós-validação.

## Estado atual e fontes de evidência

Foram auditados `backup.sh`, `restore.sh`, `docs/ops/backup.md`, preflight/schema/deploy, coletor
forense, workflows, Prisma/migrations, ADR 002, incidentes e investigações de recuperação de julho.
O inventário e as 12 respostas objetivas estão em
[`backup-restore-readiness.md`](../ops/backup-restore-readiness.md). A branch/HEAD e Git não foram
tratados como evidência de produção.

Entregas desta Sprint: harness isolado, teste estático, fixture sintética, job CI pequeno, manifesto
de evidência e proposta inicial de RPO/RTO. `backup.sh` e `restore.sh` não foram substituídos.

## Fora do escopo

- VPS, banco/dump real, restore ou alteração de produção;
- contratar/provisionar nuvem, off-site, KMS ou política jurídica;
- reescrever caminhos legados sem plano de migração;
- aprovar RPO/RTO empresarial, integrar gate de deploy ou atualizar runbook operacional aprovado;
- encerrar `INC-PROD-2026-07` ou `TD-ER-003`.

## Riscos e proteções

Os riscos atuais são dump parcial, ausência de checksum/catálogo, formatos divergentes, retenção
somente por quantidade, falta de criptografia/off-site e restore legado destrutivo. O ensaio rejeita
variáveis externas de produção, usa apenas rede interna/container/database aleatórios próprios,
`tmpfs`, nenhuma porta/volume, imagem local e cleanup limitado aos nomes da execução. Checksum e
catálogo falham antes do restore; `--single-transaction` e `--exit-on-error` impedem sucesso parcial.

## Critérios de aceite e resultados

- [x] guardrails estáticos executáveis sem Docker;
- [x] checksum, catálogo, metadados e emissão final de `result.tsv` implementados;
- [x] pós-condições estruturais, redump catalogável e segunda conexão implementados;
- [x] fixture sem PII, com FK, índice, enum, migrations e `incident_*`;
- [x] CI configurado para gerar/restaurar sem secret ou artifact;
- [ ] execução Docker real aprovada no check da PR;
- [ ] teste futuro com cópia autorizada e revisão operacional;
- [ ] RPO/RTO aprovados por Product Owner/Operação.

## Plano de testes

Rodar testes estático e PostgreSQL, suites de deploy/schema/auth, build/typecheck, `bash -n`, links,
referências proibidas, `git diff --check` e status. Código 77 significa apenas SKIP por ausência de
Docker/imagem, nunca aprovação end-to-end.

## Rollback

Reverter o commit remove harness, scripts npm, passo CI e documentos. Durante execução, o trap
remove source/target/rede e temporários; como não há porta, volume externo ou conexão operacional,
nenhum rollback de dados é necessário. Metadados de evidência são preservados para diagnóstico.

## Enterprise Readiness e limitações probatórias

Backup/Restauração pode avançar de 🔴 para 🟡 somente depois de evidência Docker real revisada. O
ensaio melhora repetibilidade, mas continuidade empresarial continua não comprovada: não mede
download/decriptação, volume real, pessoas, capacidade, off-site nem indisponibilidade completa.
RPO 24 h e RTO 4 h são propostas, e o tempo do harness é somente medição de laboratório.

## Dependências

`INC-PROD-2026-07` continua corrigido aguardando encerramento, estabilidade e restore operacional.
`TD-ER-003` fica em **correção/validação em 🔵 PR** e exige merge, check Docker, ensaio autorizado e
aprovação operacional futura. Nenhum dos dois é encerrado por esta entrega.
