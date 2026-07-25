# Análise forense dos clientes arquivados — ERP 5050

> **Aviso:** as conclusões deste documento somente podem ser consideradas
> definitivas após a execução das consultas em ambiente de produção e a análise
> das evidências coletadas. Até lá, hipóteses, datas e classificações permanecem
> provisórias.

## 1. Escopo, pergunta e limites

Esta investigação busca responder **“como os 1.298 registros chegaram ao estado
atual?”** sem alterar o estado observado. A entrega é um protocolo de coleta, e
não afirma antecipadamente que existem exatamente 1.298 linhas: esse número é a
alegação do incidente e deve reconciliar com a consulta 1.

São permitidos apenas `SELECT`, inspeção de artefatos e correlação de evidências.
São proibidos sincronização, chamadas aos endpoints de sync, migrations,
`UPDATE`, `INSERT`, `DELETE`, correções e testes que inicializem o scheduler. O
arquivo [`evidence/erp-5050-read-only.sql`](evidence/erp-5050-read-only.sql)
inicia explicitamente uma transação `READ ONLY`, define timeout e termina em
`COMMIT` (sem mutações). Execute-o com credencial que já tenha apenas
`CONNECT`, `USAGE` e `SELECT`, preferencialmente em réplica consistente.

### 1.1 Definição reproduzível da população

“Relacionado ao ERP 5050” significa que o `Client.code`, removidos zeros à
esquerda, é `5050`, ou que sua parte anterior a `__MERGED__` ou
`__LEGACY_DUP__` é `5050`. Os marcadores são importantes: o merge online
preserva o código como `<code>__MERGED__<epoch-ms>`; o saneamento legado usa
`<code>__LEGACY_DUP__<epoch-ms>`. Um nome com `[ARQUIVADO ERP DUP]` sozinho
**não** inclui a linha na população, pois o prefixo pode pertencer a outro código.

Antes da análise:

1. confira amostras sob acesso controlado e valide que `5050` é código de
   parceiro, não identificador de vendedor ou outro conceito;
2. reconcilie total, ativos e arquivados; se arquivados ≠ 1.298, registre a
   divergência e não ajuste silenciosamente o predicado;
3. preserve o resultado bruto fora do Git, cifrado e com SHA-256; versione apenas
   agregados não sensíveis no
   [`modelo de saída`](evidence/erp-5050-output-template.md).

### 1.2 Limitação decisiva: `Client` não tem `updatedAt`

O schema versionado possui `createdAt` e `erpUpdatedAt`, mas não `updatedAt` em
`Client`. Logo, agrupar `Client.updatedAt` seria SQL inválido neste estado do
schema e, mesmo se `erpUpdatedAt` estiver presente, ele representa atualização
do ERP, não necessariamente o arquivamento. A consulta 0b confirma o schema real
de produção antes da coleta.

Para as neutralizações conhecidas, a data é **inferida** do epoch em `code`.
Isso é evidência forte da execução que neutralizou o código, mas não substitui
uma trilha imutável. Registros sem marcador só podem ser datados por timeline,
logs, backup/WAL/auditoria externa ou comparação de snapshots. Nunca apresente o
epoch inferido como `updatedAt` observado.

## 2. Matriz das consultas

As consultas numeradas estão no SQL de evidências e não exibem nomes ou
documentos. A impressão digital MD5 da consulta 8 é apenas um identificador de
reconciliação dentro da coleta, **não anonimização criptográfica**; trate-a como
dado pseudonimizado e não a versione.

| Nº | Pergunta | Saída e interpretação |
|---:|---|---|
| 0 | Ambiente e schema | Prova banco/role/read-only/fuso e se as colunas existem. |
| 1 | Quantos relacionados? | Total separado em ativo/arquivado; soma é o universo. |
| 2 | `archiveReason` | Frequência dos motivos, incluindo `NULL`. |
| 3a–b | Pico no instante | Epoch neutralizado por segundo e por minuto; `NULL` mede a lacuna. |
| 4 | `createdAt` | Coortes de criação por dia, separadas por estado atual. Não é data de arquivo. |
| 5 | `ownerSellerId` | Concentração dos registros ativos e arquivados por vendedor. |
| 6 | Prefixo | Quantidade com `[ARQUIVADO ERP DUP]`. |
| 7 | Neutralização | Marcadores explícitos no documento e código, mais `cnpjNormalized IS NULL`. |
| 8 | Mesmo documento ativo | Substitutos ativos pelo documento original recuperável, com owner igual/diferente. |
| 9 | Outro owner | Candidato ativo em owner distinto por documento ou código base. É candidato, não identidade provada. |
| 10 | Motivo × owner | Revela se um motivo está concentrado em vendedor/lote operacional. |
| 11 | Linha do tempo | Primeiro, último, intervalo, cobertura e maior lote por segundo. |
| 12 | `ErpSyncRun` | Runs cuja execução se sobrepõe à janela inferida, com trigger/correlation ID. |
| 13 | Timeline | Eventos compatíveis com merge/saneamento na mesma janela. Texto é pista, não chave. |

**Validações cruzadas obrigatórias:** (a) 1 arquivados = soma de 2 = soma de 5
arquivados = soma de 10; (b) soma de 6 = total da 1; (c) população arquivada da
11 = arquivados da 1; (d) `timestamps_inferred ≤ archived_population`; (e) os
resultados 8 e 9 não devem ser somados, pois podem se sobrepor.

## 3. Reconstrução da linha do tempo

### 3.1 Método

1. **Fixar o universo e o relógio.** Registrar horário UTC, fuso da sessão,
   snapshot/réplica e SHA do SQL. Não converter horários para hora local durante
   a correlação.
2. **Medir cobertura.** Calcular `timestamps_inferred / archived_population`.
   Sem cobertura completa, “primeiro” e “último” significam primeiro/último
   **inferível**, não absolutos.
3. **Extrair instantes.** Interpretar somente sufixos de 10–16 dígitos após os
   dois marcadores conhecidos como epoch-ms. Conferir plausibilidade contra
   `createdAt` (arquivo não pode anteceder criação) e data de introdução do
   mecanismo no Git.
4. **Formar lotes.** Primeiro agrupar por segundo (o saneamento legado reutiliza
   um único `Date.now()` para a execução); depois por minuto para tolerar o merge
   online, que calcula o timestamp durante cada operação.
5. **Correlacionar.** Procurar `ErpSyncRun` sobreposto (±5 min), timeline e logs
   pelo `correlationId`. Coincidência temporal isolada é “compatível”; a mesma
   correlation ID em run e logs torna a atribuição muito mais forte.
6. **Triangular com snapshots.** Em backup anterior, contar as mesmas identidades
   ainda ativas/não neutralizadas; no primeiro backup posterior, confirmar o
   estado atual. Isso limita a janela mesmo para linhas sem epoch.

### 3.2 Regra de classificação

Não marque uma caixa antes da coleta:

- **Lote único:** 100% (ou cobertura explicitamente justificada) no mesmo
  segundo/epoch, e run/log/timeline compatíveis.
- **Vários lotes:** dois ou mais picos discretos; relatar tamanho, início/fim e
  evidência operacional de cada um. Não contar segundos contíguos de uma mesma
  run automaticamente como runs diferentes.
- **Arquivamento gradual:** eventos espalhados de forma contínua por período
  longo, sem picos dominantes, preferencialmente associados a runs recorrentes.
- **Inconclusivo:** timestamps insuficientes/conflitantes. Não forçar uma das
  três narrativas.

Estado a preencher após produção:

- [ ] um único lote
- [ ] vários lotes
- [ ] arquivamentos graduais
- [x] inconclusivo antes da coleta

## 4. Fontes de auditoria e força probatória

| Fonte | Informação possível | Limite / cuidado |
|---|---|---|
| `Client` atual | Estado, motivo, owner, criação, código/documento neutralizados e epoch embutido. | Sem `updatedAt`; estado presente não prova sozinho autor ou endpoint. |
| `ErpSyncRun` | Scope, trigger manual/scheduler, status, vendedor, auth mode, início/fim, métricas, erros e correlation ID. | `syncedCount` não é necessariamente quantidade arquivada; runs antigos podem preceder a tabela/retenção. |
| `TimelineEvent` | Evento e horário do merge/saneamento, associado ao cliente principal e owner. | Relacionamentos foram movidos ao principal; descrição textual pode não guardar ID estruturado do duplicado. |
| Logs da aplicação | Mensagem de duplicate merge, IDs técnicos, correlation ID, instante, processo/host. | Retenção, rotação e relógio; restringir busca à janela e mascarar PII. |
| Correlation IDs | Liga request, logs e `ErpSyncRun`. | Só prova ligação se o mesmo valor persistir nas fontes, não por proximidade. |
| Request IDs / proxy | Método, rota, usuário autenticado (se auditado), status e duração do endpoint manual. | Request ID e correlation ID são campos distintos; proxy pode não guardar corpo/ator. |
| Scheduler | Janela/tick, skip reason, início/fim e runs com trigger `scheduler`. | Configuração atual não prova configuração histórica; usar logs/deploy env histórico. |
| Endpoint manual | Rotas POST de partners/full/all-sellers e controles de autorização no commit implantado. | Existência da rota não prova invocação; requer access log/audit de identidade. **Não chamar.** |
| Histórico Git/deploy | Quando prefixos, motivos, scripts e algoritmos passaram a existir; SHA implantado. | Data de commit não é data de execução. Confirmar manifesto/deploy SHA. |
| Backups/snapshots | Estado antes/depois, documentos/códigos originais e limite da janela. | Restaurar apenas em ambiente isolado; nunca sobre produção; registrar consistência e horário. |
| WAL/CDC/audit DB | Operação, timestamp/transaction ID e possivelmente role/origem. | Disponibilidade e decodificação dependem da retenção/configuração; acesso altamente restrito. |

Motivos/marcadores esperados no código conhecido são
`MERGED_INTO:<clientId>` (merge online), `legacy_duplicate_cleanup`
(saneamento) e neutralizações `__MERGED__`/`__LEGACY_DUP__`. Outros valores devem
ser tratados como uma nova trilha, não encaixados por conveniência.

## 5. Hipóteses reavaliáveis

| Hipótese | Confirmaria | Descartaria ou enfraqueceria | Prioridade |
|---|---|---|---:|
| **Saneamento legado executado uma vez** | Predomínio de `legacy_duplicate_cleanup`, prefixo, `__LEGACY_DUP__`, epoch idêntico; timeline de saneamento; deploy/script e log na janela. | Motivo `MERGED_INTO`, epochs distribuídos em runs recorrentes ou prefixo ausente. | P0 |
| **Uma sincronização/merge online em lote** | `MERGED_INTO:*` + `__MERGED__`, pico curto; `ErpSyncRun(scope=partners)` e logs de merge com mesma correlation ID. | Nenhum run/log na janela, `__LEGACY_DUP__` dominante ou janela anterior à implantação do código. | P0 |
| **Várias execuções do scheduler** | Picos alinhados às janelas, vários runs `trigger=scheduler`, correlation IDs distintos e logs de ticks. | Um único epoch compartilhado e uma única execução manual/script comprovada. | P1 |
| **Endpoint manual** | Run `trigger=manual`, access log POST, request/correlation IDs ligados e ator autorizado na janela. | Apenas runs scheduler comprovados; nenhum access log compatível com retenção completa. | P1 |
| **Clientes substituídos pelo cadastro ativo** | Consulta 8 encontra documento original igual; `archiveReason` aponta para ID ativo; timeline diz “fundido”; relações no principal. | Nenhum match por documento/código e target de `MERGED_INTO` inexistente (considerando retenção/restauração). | P0 |
| **Mudança de owner causou duplicação** | Arquivados concentrados em owner A, substitutos de mesma identidade em owner B, runs seller-specific e sequência temporal coerente. | Substitutos no mesmo owner ou distribuição sem correlação com troca/runs por seller. | P1 |
| **Apenas correção de flag em registros já prefixados** | Prefixo preexistente, motivo de cleanup, mas sem neutralização de código/documento; backup anterior já contém prefixo. | Código/documento foram neutralizados no mesmo instante e backup anterior mostra linhas normais ativas. | P1 |
| **Ação manual direta no banco** | Auditoria/WAL mostra SQL/role fora da aplicação, sem run/request/correlation; padrão diverge do código. | Logs e run correlacionados explicam integralmente as linhas, com marcadores exatos da aplicação. | P2 |
| **Artefato/restauração de backup** | Muitos `createdAt`/estados mudam entre snapshots, deploy/restore log na janela, ausência de trilha normal da aplicação. | Continuidade de WAL/auditoria e eventos por registro/run explicam transição. | P2 |

“Descartada” exige fonte com cobertura suficiente. Ausência em logs expirados não
descarta hipótese; registre “não observada”.

## 6. Plano operacional de coleta em produção

### Passo 1 — Autorizar e congelar a coleta lógica

- **Objetivo:** estabelecer cadeia de custódia e evitar efeitos operacionais.
- **Consulta:** nenhuma; registrar ticket, janela, réplica/snapshot, role e commit.
- **Resultado esperado:** autorização, retenção de logs e credencial SELECT-only.
- **Conclusão possível:** coleta reproduzível e escopo temporal preservado.
- **Risco:** rotação de logs; mitigar com hold aprovado, sem mudar a aplicação.

### Passo 2 — Provar read-only e validar schema

- **Objetivo:** impedir escrita e confirmar que `updatedAt` existe ou não.
- **Consulta:** 0a e 0b.
- **Resultado esperado:** `transaction_read_only=on`; colunas compatíveis com o
  schema, normalmente sem `updatedAt`.
- **Conclusão possível:** quais relógios podem ser usados legitimamente.
- **Risco:** conectar no ambiente errado; validar database/role e parar se divergir.

### Passo 3 — Fixar e reconciliar a população

- **Objetivo:** comprovar total, estado, motivos, prefixos e neutralização.
- **Consulta:** 1, 2, 6 e 7.
- **Resultado esperado:** total reconciliado e 1.298 arquivados, ou divergência
  formalmente registrada.
- **Conclusão possível:** alcance do incidente e mecanismo predominante.
- **Risco:** definição errada de “5050”; validar conceito e amostra sob controle.

### Passo 4 — Medir tempo e lotes

- **Objetivo:** achar primeiro/último, maior lote e distribuição.
- **Consulta:** 3a, 3b, 4 e 11.
- **Resultado esperado:** cobertura do epoch, picos e intervalo total.
- **Conclusão possível:** lote único, vários, gradual ou inconclusivo conforme §3.2.
- **Risco:** confundir `createdAt`/`erpUpdatedAt` com arquivo; rotular sempre
  timestamps derivados.

### Passo 5 — Analisar ownership e substituição

- **Objetivo:** determinar concentração por seller e candidatos ativos.
- **Consulta:** 5, 8, 9 e 10.
- **Resultado esperado:** matriz motivo/owner e matches ativos agregados.
- **Conclusão possível:** mesmo vendedor, migração de owner ou ausência de
  substituto observável.
- **Risco:** falso positivo por código compartilhado; documento válido + target
  de `MERGED_INTO` + timeline têm precedência sobre código isolado.

### Passo 6 — Correlacionar runs e timeline

- **Objetivo:** ligar lotes a execução e trigger.
- **Consulta:** 12 e 13.
- **Resultado esperado:** runs/eventos dentro da janela, IDs e horários.
- **Conclusão possível:** execução manual/scheduler compatível ou lacuna.
- **Risco:** JSON pode conter dado sensível; spool cifrado, mínimo acesso e não Git.

### Passo 7 — Coletar logs sem disparar endpoints

- **Objetivo:** encontrar merge/cleanup, request ID, correlation ID, rota e ator.
- **Consulta:** busca no agregador pela janela e IDs da 12; mensagens
  `[ultrafv3 sync partners] duplicate client merged`, saneamento e scheduler.
- **Resultado esperado:** cadeia run → correlation ID → logs → request/tick.
- **Conclusão possível:** origem operacional e processo executor.
- **Risco:** PII e segredos em payload; não pesquisar por CPF/CNPJ, limitar campos,
  aplicar política de retenção. Jamais chamar POST para “testar”.

### Passo 8 — Verificar Git e implantação

- **Objetivo:** identificar lógica efetivamente implantada na janela.
- **Consulta:** `git log -S'[ARQUIVADO ERP DUP]' --all -- ...`, `git show <sha>` e
  manifesto/BUILD_SHA do deploy, todos sobre artefatos locais.
- **Resultado esperado:** commits de introdução, SHA implantado e horário do deploy.
- **Conclusão possível:** mecanismo estava disponível; não prova que rodou.
- **Risco:** confundir author date, commit date e deploy; preservar os três.

### Passo 9 — Comparar backups isoladamente

- **Objetivo:** observar o estado anterior/posterior, sobretudo linhas sem epoch.
- **Consulta:** executar 1–11 em restaurações isoladas, com nova cadeia de custódia.
- **Resultado esperado:** último snapshot “antes” e primeiro “depois”.
- **Conclusão possível:** limite máximo da janela e identidades predecessoras.
- **Risco:** exposição/alteração; restauração somente em ambiente forense isolado,
  rede restrita, role read-only e descarte aprovado.

### Passo 10 — Fechar, revisar e assinar

- **Objetivo:** produzir resposta objetiva sem exceder a evidência.
- **Consulta:** reconciliações do §2 e preenchimento do modelo.
- **Resultado esperado:** tabela de lotes, fontes, hipóteses confirmadas,
  descartadas e inconclusivas, revisada por banco/segurança/aplicação.
- **Conclusão possível:** narrativa auditável de como as linhas chegaram ao estado.
- **Risco:** causalidade por correlação; marcar cada afirmação como fato, inferência
  ou desconhecido e exigir duas fontes independentes para atribuição causal.

## 7. Critério de resposta final

A conclusão deve declarar: população efetivamente observada; cobertura temporal;
primeiro/último inferíveis; quantidade e tamanho dos lotes; distribuição de
`archiveReason` e owner; número com substituto ativo; run/trigger/correlation
confirmados; e lacunas. Se a cobertura não permitir responder “quando” para todos
os 1.298, a resposta correta é limitada (por exemplo, “1.250 inferíveis no lote
X; 48 sem timestamp, limitados entre backups A/B”), nunca uma extrapolação.
