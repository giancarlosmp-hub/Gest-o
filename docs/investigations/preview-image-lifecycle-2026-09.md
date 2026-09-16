# Ciclo de vida de imagens de preview — investigação e plano (16/09/2026)

## Evidência e causa

**Evidência local observada:** o merge local da PR #873 é `12086bc`; este checkout não possui remote configurado. Foram inspecionados os workflows, Dockerfiles, Compose, diagnóstico e contratos de rollback versionados. O `Preview Cleanup` anterior descobria projetos por labels, confirmava o run concluído, executava `docker compose down -v`, removia diretório/nginx e terminava. Ele não executava remoção de imagem nem registrava proveniência por IMAGE ID. Como o Compose não recebe opção de remover imagens, o acúmulo é consequência confirmada do caminho versionado, não apenas hipótese.

**Evidência remota:** `NOT_OBSERVED` nesta sessão: sem remote configurado não foram reconsultadas main, PRs/checks/incidentes no GitHub. A PR #873 efetivamente mesclada foi revisada no histórico local (`12086bc`, filhos `f748c98` e `502fd76`); seu apply legado está desabilitado porque o TSV declarado não comprova ownership.

**Relato do operador, não execução do agente:** o inventário histórico de 16/09 contou 889 IMAGE IDs: 3 produção, 24 rollback, 40 outros referenciados, 156 sem container com tags novas, 555 previews legados e 111 demais. O primeiro lote removeu, sem force e após revalidação, somente `sha256:a1c950315749d44bc0131d013e440b36203008aee7fda4245c49624f8802a6d1` (API) e `sha256:a2ceed22911d5835c97fd11ef6081a6db1becfae435443e669d383ee34813a2a` (WEB), revision `502fd76d5a994872dc6277910b78b8b0864f8976`. Preview Deploy `35041221319` e Cleanup `35041671959` passaram. O livre relatado variou de 9.005.348 para 9.168.560 KiB (+163.212 KiB, ~159,4 MiB), sem remoção de backup/volume/container; API/WEB continuaram healthy e `/health/version` permaneceu em `186fe0c5f8710ac3c4368711fd348e1be6e27474`. A variação não é atribuição exclusiva diante de atividade concorrente.

## Novos previews

A imagem final de cada Dockerfile, inclusive o estágio runtime do build multi-stage, recebe repositório, PR, run, tentativa, workflow, commit, serviço e projeto. Após o build, `record` resolve `docker compose images -q`, exige dois IDs `sha256:` completos e distintos, reinspeciona labels/tags/digests e publica JSON por rename. O contrato opera sobre imagens locais finais; não presume manifest list. Se o builder retornar identidade que não seja um IMAGE ID local completo, falha fechado. Digests conhecidos são registrados e revalidados.

No fechamento, o workflow confiável é serializado por PR. Ele consulta PR e run com token do GitHub, exige PR fechada, run concluído, tentativa/commit/workflow/event/PR correlacionados e pagina estados concorrentes. Depois do cleanup normal, para cada ID ele exige manifesto e labels idênticos, conjunto integral de tags/digests invariável, nenhuma tag de proteção, nenhuma ocorrência nos contratos de deploy/backup, e nenhum container ativo ou parado. Faz nova inspeção de imagem e nova enumeração de containers imediatamente antes de `docker image rm <IMAGE_ID>`. Não usa force; Docker administra camadas compartilhadas. Imagem já ausente é idempotente. Qualquer falha preserva e interrompe o lote.

## Legado e manifesto revisável

`plan-legacy-preview-images.mjs` consome o inventário agrupado por ID e um arquivo separado de evidência independente. Nomes/tags não fabricam ownership. O planejador consulta PR/run com cache (a API é paginada no gate de concorrência dos novos previews; PR/run legado são consultas pontuais deduplicadas), trata falta de autenticação, erro e rate limit como indisponibilidade e produz `PROTECTED`, `NOT_PROVEN` ou `ELIGIBLE_FOR_HUMAN_REVIEW`, com motivos, timestamp, expiração de 24 h e hash de aprovação. Espaço é `NOT_MEASURED`.

Nenhum executor legado foi implementado: ownership suficiente ainda depende de evidência operacional independente real. O apply genérico continua bloqueado. Um executor futuro separado teria de exigir manifesto fechado/íntegro/não expirado, aprovação vinculada ao hash, limite por lote, ausência de recurso extra, revalidação integral e parada na primeira divergência/falha parcial; jamais ampliar o conjunto. Esta entrega não limpa a VPS.

## Retenção

- **preview ativo:** preservar a versão servida e a reversão de preview explicitamente necessária; runs anteriores de PR aberta não são descartados automaticamente;
- **preview encerrado:** remover no fechamento somente após todos os gates;
- **produção:** preservar referências reais do runtime, não só nomes conhecidos;
- **rollback:** preservar todos os IDs dos contratos/bundles;
- **incidente/recuperação:** hold explícito, sem expiração nesta política;
- **origem desconhecida:** `NOT_PROVEN`, preservar.

Backups, volumes e retenção/rollback produtivo não mudam. Permanecem protegidos os três containers conhecidos, `gest-o_pgdata`, `gest-o_pgdata_clean_v2_20260717`, containers parados e quaisquer recursos descobertos pelo runtime/contratos.

## Testes, limites e próximos passos

A suíte cobre por comportamento do planejador a indisponibilidade de autenticação e agrupamento multi-tag, e por barreiras contratuais os gates de PR aberta, run não concluído, falha GitHub, labels/commit/run/tentativa divergentes, tag protegida, container parado/produção, referência criada no TOCTOU, hold/evidência protegida, dry-run legado, idempotência, concorrência, parada em falha e ausência da imagem. Manifesto adulterado/expirado e conjunto extra são requisitos documentados para um executor legado que deliberadamente não existe. Camadas compartilhadas ficam com Docker e volumes não entram no seletor de imagens.

Se Docker não estiver disponível, testes estáticos/semânticos não são prova operacional. O próximo passo é CI remoto, seguido de ensaio Docker descartável sintético; só após merge e execução real o comportamento pode ser considerado ativado. Validar `df -Pk` antes/depois de cada lote humano e registrar variação líquida, sem somar tags/camadas nem usar reclaimable negativo.

## Revisão pós-commit 56424ce

A revisão encontrou quatro lacunas comprovadas: o deploy não compartilhava a concorrência do cleanup; `status=completed` aceitava conclusão cancelada; projetos deixados apenas no diretório de proveniência não eram descobertos; e a validação/removal ocorria intercalada, permitindo excluir a primeira imagem antes de descobrir uma proteção na segunda. As correções serializam ambos os workflows, exigem `conclusion=success`, incluem manifestos na descoberta e realizam uma fase integral de elegibilidade antes da fase destrutiva. O manifesto passou a exigir arquivo regular do owner, modo 600, schema fechado e timestamp válido. Ele permanece um índice: GitHub + labels finais + inspeção Docker são a autoridade composta.

Gatilhos observados localmente: `Preview Deploy` em `opened`, `synchronize` e `reopened`; `Preview Cleanup` em `closed`; e traps de falha do deploy que desmontam o candidato atual. Close abrange merge e fechamento sem merge. Uma reabertura enquanto cleanup aguarda muda o estado autenticado para aberto e preserva; nova tentativa fica na mesma fila. Run cancelado preserva. Falha anterior ao record não deixa manifesto novo; falha posterior pode deixar manifesto, agora descoberto mesmo sem runtime. Falha na remoção interrompe o lote; nenhuma ampliação automática ocorre.

A busca versionada encontrou downs de preview, teardown do Docker Compose CI e remoções em harnesses sintéticos. Isso não prova o estado dos schedulers da VPS. `scripts/diagnose-preview-cleanup-schedulers.sh` publica apenas contagens/hashes e indisponibilidades, sem conteúdo de cron, comandos, argumentos ou env.

O ensaio `test:preview-images:docker` foi adicionado ao `Docker Compose CI` para construir imagens scratch multi-tag sem rede, criar/inventariar o preview, desmontá-lo, remover os IDs elegíveis e comprovar preservação diante de GitHub 503, produtor cancelado e container parado; depois remove somente fixtures sintéticas. Nesta sessão Docker não está disponível, então a prova permanece `NOT_EXECUTED` e o parecer é `BLOQUEADO` até CI remoto verde. Branch/remoto: o ambiente inicialmente apresentou branch replay `work`; ela foi renomeada, sem criar outra linha de trabalho, para `codex/preview-image-lifecycle-safe`. GitHub remoto, PR existente, comentários inline e checks são `NOT_OBSERVED` porque não há remote e `gh` não está autenticado.
