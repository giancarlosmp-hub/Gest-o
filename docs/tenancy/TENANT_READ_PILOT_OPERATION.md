## Estabilidade sintética do preview (1.0B.2-K)

Após repetir seed/certificação, o preview executa 10 ciclos de quatro GET `/clients` concorrentes. Aceite: 40 HTTP 200/exit 0, 40 IDs internos válidos e distintos, um evento por ID, 40 MATCH e zero MISMATCH. Não enviar `X-Request-Id`; limitar logs por `--since`/`--until` e pelo conjunto retornado. Em rerun, volume pode ser reutilizado, mas eventos antigos não contam e cardinalidades não podem crescer. Timeout, rate limit ou atraso de log falham fechados; rollback restaura disabled/false e recria só a API. A janela curta é sintética, não estabilidade produtiva. `TENANT_READ_PREVIEW_STABILITY = NOT_PROVEN` até o Preview Deploy real.

# Operação do piloto read-only tenant-aware

O piloto de `GET /clients` é shadow e retorna sempre o resultado legado. Produção deve manter literalmente `TENANCY_MODE=disabled` e `TENANT_READ_PILOT_ENABLED=false`; nessa condição não há resolução, consulta de control plane, repository, shadow ou log tenant-aware.

A ativação é autorizável somente em dataset sintético validado: `NODE_ENV=test`, ou `DEPLOYMENT_ENV=preview`, junto de `TENANCY_MODE=default-only`, `TENANT_READ_PILOT_ENABLED=true` e `DEFAULT_TENANT_ID=<tenant técnico validado>`. Qualquer combinação ativa em produção aborta o startup. Nunca transportar tenant por HTTP.

Monitorar apenas o evento `[tenant read pilot] client list shadow comparison`. `MISMATCH` bloqueia a prova automatizada e requer manter o gate desligado; não inspecionar nem logar payload para diagnosticar. Rollback: definir `TENANT_READ_PILOT_ENABLED=false`; rollback máximo: `TENANCY_MODE=disabled`. Não há migration ou dado a desfazer. O preview possui seed certificado, mas permanece desligado antes dos gates e volta a disabled/false após qualquer falha.

## Preview certificado (1.0B.2-J)
A sequência obrigatória é banco/schema, seed, validador, ativação, health/login, GET `/clients` concorrente e MATCH. Checkpoints: `TENANT_READ_PREVIEW_SEED=PASS`, `TENANT_READ_PREVIEW_DATASET=PASS` e `TENANT_READ_PREVIEW_SHADOW=MATCH`. MISMATCH restaura disabled/false e recria somente a API preview. Logs são limitados a IDs técnicos, contagens, fonte/versão, resultado, duração e requestId.
