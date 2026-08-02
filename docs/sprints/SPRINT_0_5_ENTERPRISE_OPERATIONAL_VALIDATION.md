# Sprint 0.5 — Enterprise Operational Validation

**Estágio:** 🔵 PR em 02/08/2026. **Sem acesso a produção, banco, deploy ou restore.**

## Diagnóstico inicial

O `HEAD` inicial era `d798951`, merge local da PR #768. O histórico local também registra as PRs
#766 e #767, correspondentes às Sprints 0.2 e 0.3; Git não foi usado para inferir o runtime. A
produção conhecida continua condicionada às evidências descritas no Documento Mestre. Os incidentes
`INC-5050-4484`, `INC-ERP-5050` e `INC-PROD-2026-07` permanecem abertos nos estados vigentes, e
TD-ER-001/002/003 não são encerrados por esta Sprint. A revisão de `TECH_DEBT.md` não identificou
novo débito distinto sem duplicar itens existentes.

## Objetivo e arquitetura operacional

A Sprint consolida, sem funcionalidade nova, uma única rotina capaz de declarar PASS/FAIL de uma
instalação por SHA. `scripts/production-health-validation.sh` recebe identidades e credenciais por
entrada protegida, inspeciona somente metadados Docker, sistema, TLS, respostas HTTP e logs recentes
sanitizados. Não abre conexão com PostgreSQL: compatibilidade de schema e preservação das tabelas de
incidente são verificadas em evidência previamente aprovada informada pelo operador.

A coleta é fail-collect: uma falha entra no TSV correspondente e as demais verificações continuam.
Somente erro de pré-condição impede a coleta. A decisão final ocorre depois de todos os grupos e não
dispara remediação. O smoke estático bloqueia comandos de ciclo de vida Docker, acesso SQL, mudança
de schema/dados, referências a segredo de banco e arquivos operacionais protegidos.

## Checklist Enterprise coberto

- identidade: SHA da API, SHA da WEB, labels das imagens e `build-info`;
- disponibilidade: health local/público, containers, nginx, TLS e certificados;
- infraestrutura: imagens, volume PostgreSQL esperado, rede, restart policy e Docker;
- plataforma: disco, memória, CPU, permissões e versões Node, Prisma, PostgreSQL e Docker;
- continuidade: configuração executável de backup/restore e evidência de schema/incidentes;
- segurança: variáveis obrigatórias por nome, ausência de diagnóstico admin, login, endpoint
  protegido e varredura sanitizada de logs;
- integração: sinal recente do ERP, inicialização do scheduler e ausência de falha fatal de filas.

Sinais de log provam apenas a janela coletada. Eles não substituem SLO, tracing, retenção central,
ensaio de continuidade ou validação direta do fornecedor ERP.

## Evidências e contrato de resultado

O diretório é `/var/log/gest-o/health/<SHA>/`, modo 0700, novo por execução. São gerados
`health.tsv`, `runtime.tsv`, `containers.tsv`, `images.tsv`, `network.tsv`, `storage.tsv`,
`system.tsv`, `security.tsv`, `erp.tsv`, `summary.tsv` e, por último, `result.tsv`. Respostas de
login, tokens, headers, cookies, e-mail, senha e logs brutos não são persistidos. Um único FAIL torna
o resultado final FAIL; ausência do arquivo final significa execução incompleta, nunca aprovação.

## Riscos e limites

- um checkout saudável não comprova produção; a execução precisa ocorrer no host autorizado;
- inspeção Docker não consulta conteúdo ou integridade lógica do banco;
- o manifesto de schema pode estar obsoleto e deve ter cadeia de custódia operacional;
- logs limitados podem não conter um ciclo ERP/scheduler e produzir FAIL conservador;
- login gera somente uma tentativa válida e um GET protegido, mas ainda exige conta dedicada;
- certificado válido não comprova configuração TLS completa; capacidade instantânea não é teste de carga;
- nenhuma falha autoriza reinício, deploy, restore, limpeza, alteração de dados ou fechamento de incidente.

## Rollback e aceite

Reverter o commit remove script, smoke, comando npm e documentação; não há rollback de runtime ou
dados porque a rotina não modifica recursos. Aceite exige smoke estático, sintaxe shell, suites
obrigatórias, links Markdown e revisão humana dos TSVs de uma execução futura. Esta PR apenas prepara
o mecanismo e mantém o estágio 🔵 PR.
