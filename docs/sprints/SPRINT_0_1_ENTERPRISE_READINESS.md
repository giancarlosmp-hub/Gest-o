# Sprint 0.1 — Auditoria Enterprise

**Estado:** 🔵 PR
**Natureza:** auditoria documental e inspeção read-only do checkout; nenhuma alteração de aplicação,
banco, infraestrutura, deploy ou produção.
**Baseline Git no início:** branch `work`, `HEAD e2a41a76a7a97ecc5b0fdbb8519a1dd3da248697`,
worktree limpo. Não havia branch `main` local, referência `origin/main` nem remote configurado; portanto,
a relação atual com `main` não foi comprovada. O histórico local registra como última PR a #764, mas
merge, deploy e produção não são inferidos desse registro.

## Reconciliação posterior ao intake

Após a baseline inicial, foram fornecidas evidências operacionais da VPS de 01/08/2026. A matriz foi
reconciliada sem reexecutar operações:

- **Evidência do repositório:** código, schema, ADRs, migrations, workflows, scripts, testes e
  documentação versionados; prova o artefato auditado, não sua execução.
- **Evidência operacional da VPS:** `applied.tsv`, checksum validado, pós-diff gerenciado vazio,
  cinco tabelas, sete enums, duas colunas de `Contact` e oito `incident_*` preservadas; cutover local
  para `a08a62670c4940322ce037d0c86c54959db32f71` e containers API/WEB iniciados.
- **Validação funcional humana:** CRM acessível, login/navegação, sincronização de clientes, 5050
  presente e Saúde da Plataforma carregando, sem relato de perda de dados.

A validação complementar por `docker compose ps` falhou depois do cutover porque `API_IMAGE` e
`WEB_IMAGE` não estavam exportadas no shell. Essa falha posterior não torna o deploy malsucedido.
Por outro lado, a validação humana ou eventual screenshot não prova SHA público, `build-info.json`,
rollback, restore, componentes internos, estabilidade prolongada ou encerramento dos incidentes.

## Objetivo

Produzir a primeira baseline verificável de maturidade comercial e técnica do Gest-o.

## Problema

O projeto possui governança, operação, documentação e mecanismos técnicos relevantes, mas ainda não
existe uma matriz única que mostre:

- o que está comprovadamente pronto;
- o que está parcialmente pronto;
- o que não foi comprovado;
- quais riscos impedem comercialização;
- quais ações devem formar o roadmap.

## Critérios de sucesso

- baseline baseada em evidências;
- nenhuma nota arbitrária;
- todos os pontos críticos vinculados a fonte;
- backlog priorizado por severidade e dependência;
- distinção explícita entre “não existe” e “não foi comprovado”;
- nenhum incidente encerrado sem evidência operacional.

## Fora do escopo

- desenvolver funcionalidades;
- corrigir código;
- alterar infraestrutura;
- realizar deploy;
- executar migration;
- acessar ou modificar produção;
- declarar suporte multiempresa sem comprovação.

## Intake, dependências e decisões vigentes

- Fontes oficiais lidas na ordem de governança: `STATUS_ATUAL.md`, `DOCUMENTO_MESTRE.md`,
  `OPERACAO.md`, `DEPLOY_GUIDE.md`, `GOVERNANCA_DESENVOLVIMENTO.md`, índice e ADRs aceitas;
  depois investigações, roadmap, arquitetura e Dashboard Saúde.
- ADR 001 mantém estabelecimentos UltraFV3 distintos por documento completo; dados corrompidos não
  são reparados automaticamente.
- ADR 002 separa autoridade runtime e migration; a reconciliação operacional comprova o apply sem
  conceder DDL permanente à identidade runtime.
- `INC-5050-4484` continua em homologação e `INC-ERP-5050` continua sem causa raiz comprovada.
- Cutover local e revisão operacional `a08a626` estão comprovados; a convergência pública do SHA
  continua não comprovada caso as saídas técnicas não tenham sido preservadas.
- Dependência de gate: fechar P0 e obter evidência operacional antes de evolução funcional,
  multiempresa ou alegação comercial enterprise.

## Método e plano de testes

1. Inventariar código, schema, workflows, scripts e documentação com `find` e `rg`.
2. Classificar somente pela força da evidência, usando a escala da baseline.
3. Tratar existência de artefato como evidência de implementação versionada, nunca de execução.
4. Validar links Markdown locais, escala, campos obrigatórios dos itens críticos, terminologia e diff.

## Riscos e rollback

O risco principal é uma leitura documental ser confundida com certificação operacional. A mitigação é
marcar separadamente o que foi comprovado na VPS e o que continua pendente. O rollback desta entrega
é reverter apenas a PR documental; não há efeito em runtime ou dados.

## Documentação obrigatória

- [`../ENTERPRISE_READINESS.md`](../ENTERPRISE_READINESS.md);
- [`../TECH_DEBT.md`](../TECH_DEBT.md);
- atualizações de índice e estado em `DOCUMENTO_MESTRE.md` e `STATUS_ATUAL.md`.
