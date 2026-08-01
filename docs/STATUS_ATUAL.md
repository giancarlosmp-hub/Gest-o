# 🔵 PR — Prisma descartável executado pela imagem da API (01/08/2026)

O build da PR #757 foi aprovado, inclusive com Prisma 5.22.0 pinado na imagem da API. A execução
operacional do teste PostgreSQL descartável parou antes de aplicar qualquer migration porque o
checkout da VPS, intencionalmente sem `node_modules`, ainda tentava iniciar o Prisma pelo host. A
correção usa a imagem local do SHA, depois de validar seu label OCI, e conecta essa imagem e um
PostgreSQL temporário por uma rede Docker isolada, sem porta publicada. Nenhum schema foi aplicado,
nenhum cutover ocorreu e a produção permaneceu intacta com os containers anteriores atendendo. O
cutover continua bloqueado e a entrega permanece 🔵 PR.

# Histórico — correção do preflight de schema (01/08/2026)

O teste PostgreSQL descartável comprovou um falso negativo no parser da allowlist: o Prisma 5.22.0
agrupou as duas colunas aditivas aprovadas de `Contact` em uma única instrução `ALTER TABLE`, formato
que o filtro não reconhecia. A migration não foi aplicada, nenhuma produção ou VPS foi acessada e o
cutover continua bloqueado. A entrega permanece 🔵 PR.

# 🔵 PR — deploy seguro preservando PostgreSQL recuperado (31/07/2026)

Código, testes e runbooks foram preparados, sem deploy nem acesso à VPS. A causa é checkout atualizado com containers antigos somado ao risco do Compose genérico iniciar o banco padrão. A candidata contém apenas API/WEB, usa `gest-o_default`, exige banco recuperado e metadados do commit; o cutover é confirmado e reversível. A revisão da PR acrescenta paridade completa de variáveis, rollback executável e Prisma pinado na imagem. Esta PR corrige ainda o falso negativo do preflight: o hostname interno do PostgreSQL é resolvido por `pg_isready` em container efêmero dentro de `gest-o_default`, e não pelo host ou por IP fixo. Nenhum deploy foi realizado e o estágio permanece 🔵 PR. O incidente permanece aberto até execução e validação controladas.

---

==========================================

# GEST-O

## STATUS ATUAL

**Versão:** 3.1

**Última atualização:**

31/07/2026

**Última PR:**

#751

**Último commit:**

`cdba39d`

### Produção

🟢 Operacional

🟡 **Em Homologação**

🔴 Incidente

### Sprint Atual

**Consolidação UltraFV3**

==========================================

> Resumo operacional de uma página derivado do
> [Documento Mestre 4.0](DOCUMENTO_MESTRE.md), fonte única de verdade. Os indicadores acima formam
> uma legenda; o estado vigente é **🟡 Em Homologação**.

## Onde paramos

- **Concluído:** Dashboard Saúde da Plataforma (PR #749, commit `2f9cfd2`).
- **Parcial:** proteção de identidade UltraFV3 5050×4484 implementada, com regressões A–H e
  auditoria; ainda falta validar as duas filiais independentes e seus perfis em homologação.
- **Próxima funcionalidade:** Activity First, começando por inventário, plano de migração e testes;
  implementação bloqueada até a estabilização.
- **Bloqueadores:** comprovar revisão/topologia de produção, concluir homologação 5050×4484,
  publicar veredito ERP 5050, testar restauração de backup e revisar hardening da VPS.

## Próxima sprint

1. Registrar commit, imagem, stack, banco, volume e migrações reais de produção.
2. Homologar A–H e sincronização controlada; confirmar 5050 e 4484 independentes.
3. Reconciliar perfis financeiros e fechar o veredito ERP 5050.
4. Restaurar backup com SHA256 em ambiente isolado e revisar hardening.
5. Aprovar inventário/plano Activity First sem alterar contratos vigentes.

## Incidente aberto

**INC-5050-4484 — EM HOMOLOGAÇÃO.** Permanece nesse estado enquanto qualquer filial esperada
estiver ausente. Encerramento exige revisão confirmada, A–H aprovados, 5050/4484 com identidades
próprias, perfis reconciliados e evidências preservadas. O INC-ERP-5050 continua investigando o
arquivamento/ausência associado ao ERP 5050.

## Último deploy

A topologia conhecida é API `gest-o-api-recovery-20260718`, PostgreSQL
`gest-o-db-clean-v2-20260717`, database `salesforce_pro` e rede `gest-o_default`. **Data e commit do
último deploy não estão comprovados no repositório** e devem ser coletados na VPS antes de qualquer
mudança.

## Última PR

**#751**, “reorganizar Documento Mestre do projeto Gest-o”, merge `cdba39d` em 31/07/2026.

## Próximos passos

1. Fechar todos os P0 com evidência objetiva.
2. Atualizar este resumo e o Documento Mestre após a validação/deploy.
3. Só então iniciar Activity First; não ampliar IA, canais, Financeiro, Fretes, aplicativo ou ERP futuro.

## Gate de schema de produção — 31/07/2026

O cutover permanece bloqueado. O preview encontrou DDL aditiva legítima e oito tabelas históricas
`incident_*` que `prisma db push` tentaria excluir. Foi preparado fluxo versionado de preview/apply,
sem acesso à VPS ou produção; o banco recuperado permanece preservado. As imagens do commit
`a2daeb5e2b8470a8a68bc5e5b164627a7cc18743` foram construídas, mas não publicadas. O incidente
5050×4484 continua em homologação. Consulte a [auditoria](investigations/production-schema-transition-july-2026.md).
