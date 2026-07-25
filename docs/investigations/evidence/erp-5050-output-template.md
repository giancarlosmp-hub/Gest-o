# Modelo de evidências — ERP 5050

> Não colar nomes, documentos, payloads, tokens ou credenciais. IDs técnicos e
> hashes de documento podem ser mantidos somente no repositório de evidências
> aprovado pela organização; neste arquivo versionado, prefira totais.

## Cadeia de custódia

| Campo | Valor |
|---|---|
| Data/hora UTC da coleta | `<YYYY-MM-DDTHH:mm:ssZ>` |
| Operador | `<identificador corporativo>` |
| Ticket/incidente | `<id>` |
| Banco/ambiente | `<produção; nome lógico, sem host>` |
| Role read-only | `<role>` |
| Commit das consultas | `<git sha>` |
| Cliente SQL e versão | `<psql ...>` |
| SHA-256 do spool bruto protegido | `<sha256>` |
| Local protegido do spool | `<referência, não segredo>` |

## Resultados consolidados

| Questão | Resultado | Consulta | Evidência/observação |
|---|---:|---|---|
| População total | `<n>` | 1 | Critério 5050 validado: `<sim/não>` |
| Ativos | `<n>` | 1 | |
| Arquivados | `<n>` | 1 | Deve reconciliar com 1.298 antes de avançar |
| Com prefixo legado | `<n>` | 6 | |
| Documento neutralizado | `<n>` | 7 | Marcador explícito, não apenas NULL |
| Código neutralizado | `<n>` | 7 | |
| Com timestamp inferível | `<n>` | 11 | Cobertura `<n/1298>` |
| Primeiro arquivamento inferido | `<UTC>` | 11 | |
| Último arquivamento inferido | `<UTC>` | 11 | |
| Maior lote (segundo) | `<n @ UTC>` | 11 | |
| Com substituto ativo (documento) | `<n>` | 8 | |
| Com substituto em outro owner | `<n>` | 9 | |

## Classificação temporal

- [ ] Lote único: um timestamp/segundo explica todos os registros com cobertura completa.
- [ ] Vários lotes: dois ou mais picos discretos, separados por intervalos materialmente maiores que a duração interna de cada pico.
- [ ] Gradual: distribuição contínua, sem picos dominantes.
- [ ] Inconclusivo: cobertura de timestamp insuficiente ou fonte conflitante.

**Regra usada e justificativa:** `<preencher>`

## Correlação

| Janela UTC | ErpSyncRun | Trigger | Scope | Correlation ID | Logs/request ID | Conclusão |
|---|---|---|---|---|---|---|
| `<início–fim>` | `<id>` | `<manual/scheduler>` | `<scope>` | `<id>` | `<referência>` | `<confirmado/compatível/não relacionado>` |

## Divergências e lacunas

| Divergência/lacuna | Impacto | Próxima fonte | Responsável |
|---|---|---|---|
| `<ex.: 12 registros sem epoch no código>` | `<não datáveis pelo banco atual>` | `<backup/log>` | `<time>` |

## Conclusão assinada

`<Conclusão limitada às evidências, distinguindo fato, inferência e desconhecido.>`
