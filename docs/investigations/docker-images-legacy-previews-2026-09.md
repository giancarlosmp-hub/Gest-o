# Imagens Docker e previews legados — inventário e plano (15/09/2026)

## Escopo e nível de evidência

Esta entrega prepara diagnóstico **somente leitura**; não acessou a VPS e não removeu imagem, container, rede, volume, backup ou evidência. O checkout local está no merge `186fe0c5f8710ac3c4368711fd348e1be6e27474` da PR #872. O checkout não possui remote e a tentativa pública de consultar as PRs #836, #821, #820, #818, #774, #604, #570, #549, #547, #546, #545, #542, #539, #538, #535, #528, #527, #526, #510 e #508 falhou por indisponibilidade de rede; estado atual das PRs e conclusão dos runs são, portanto, `NOT_OBSERVED`, nunca inferidos de nomes ou idade.

**Relato do operador, não reobservado aqui:** produção saudável no SHA `186fe0c5f8710ac3c4368711fd348e1be6e27474`, containers `gest-o-production-api-1`, `gest-o-production-web-1` e `gest-o-db-clean-v2-20260717`, banco `salesforce_pro` no volume `gest-o_pgdata_clean_v2_20260717`; os nove containers das PRs #526–#528 foram parados e a saúde/SHA continuaram corretos. Os três PostgreSQL desses previews montavam o mesmo `gest-o_pgdata`, rotulado para o projeto original `gest-o`; ele é histórico compartilhado e protegido.

Também segundo o operador, `docker builder prune --all --keep-storage 2GB` recuperou 6,754 GB e não excluiu explicitamente backup, volume ou imagem. A medição posterior (`total_kb=103024380`, `used_kb=87228424`, `available_kb=11384724`, 89%) supera o mínimo inalterado de 5.242.880 KiB por 6.141.844 KiB. `docker system df` relatou 883 imagens/44 ativas/48,36 GB, mas reclaimable de -62% é inválido; 77 containers/54 ativos/365,4 MB (53,94 MB reclaimable), 32 volumes/26 ativos/2,347 GB (532,7 MB reclaimable) e cache 115/2,271 GB (2,149 GB reclaimable). Esses totais não identificam objetos removíveis e não devem ser somados.

## Diagnóstico reproduzível

Execute na VPS e preserve o JSON como evidência da janela, sem redirecioná-lo para diretório público:

```bash
sudo --preserve-env=PRODUCTION_CONTAINERS,DEPLOY_EVIDENCE_ROOT \
  node scripts/diagnose-docker-images.mjs > /root/docker-images-before.json
docker system df
df -Pk /root/backups
```

O diagnóstico agrupa todas as tags/digests pelo IMAGE ID completo, usa o `Image` real de `docker inspect` para todos os containers inclusive parados, registra data/tamanho e somente publica compartilhado/exclusivo quando Docker o fornece de forma válida. Não lê `Config.Env`. Produção exata e metadados de rollback gerados pelo deploy são protegidos; qualquer referência não comprovada fica como **vínculo desconhecido, preservar**. Bundles externos à raiz informada, retomada/reconstrução, PR e run ainda exigem revisão humana.

Para completar a correlação GitHub sem imprimir token:

```bash
export GITHUB_TOKEN='fornecido por canal protegido'
for pr in 836 821 820 818 774 604 570 549 547 546 545 542 539 538 535 528 527 526 510 508; do
  curl -fsS -H "Authorization: Bearer $GITHUB_TOKEN" -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/giancarlosmp-hub/Gest-o/pulls/$pr" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let x=JSON.parse(s);console.log(JSON.stringify({pr:x.number,state:x.state,merged_at:x.merged_at,head_sha:x.head.sha}))})'
done
unset GITHUB_TOKEN
```

Consultar, pelo `run-id` comprovado nas labels/evidências, `/actions/runs/<id>` e registrar apenas `id`, `status`, `conclusion`, `head_sha` e `name`. Ausência das labels nos legados não autoriza criá-las artificialmente.

## Classificação e candidatos atuais

Não existe lista honesta de IMAGE IDs candidatos sem o JSON real da VPS. Assim, a lista exata nesta revisão é: **nenhum candidato aprovado; espaço recuperável `NOT_MEASURED`**. Em particular, imagem sem tag/container, imagem antiga e PR encerrada não bastam. Ficam protegidas imagens da produção atual, tags/IDs de rollback, recuperação/incidente, containers parados, referências de bundle/deploy e qualquer vínculo desconhecido. Os projetos PR #508–#836 permanecem **não classificados** até correlação de recursos, PR e run; `gest-o_pgdata` e `gest-o_pgdata_clean_v2_20260717` não são candidatos.

Uma imagem só pode entrar no lote quando o inventário registra IMAGE ID completo, todas as tags/digests, nenhum container (incluindo parado), ausência comprovada em produção/rollback/bundles/retomada, ownership inequívoco do preview e PR/run concluídos consultados. Shared/exclusive desconhecido continua `NOT_MEASURED`; mede-se o ganho real após cada lote.

## Previews legados e plano em lotes

Após a revisão da PR #873, `legacy-preview-cleanup.sh` ficou estritamente read-only. O manifesto declara projeto, PR e IDs completos, mas a PR é publicada como `PR_STATE=NOT_PROVEN`: os recursos legados não possuem labels de PR/run e o número escrito pelo operador não constitui evidência independente. O inventário descobre containers e redes pelo label Compose e exige igualdade exata dos conjuntos; duplicidade, ausência, recurso adicional, ID/projeto/nome/topologia divergente, container produtivo ou os volumes `gest-o_pgdata` e `gest-o_pgdata_clean_v2_20260717` abortam.

O modo `apply` está **desabilitado** e sempre falha antes de consultar ou alterar Docker; com mais de uma linha, falha primeiro em `APPLY_SINGLE_PROJECT_REQUIRED`. Não há confirmação capaz de habilitá-lo, nem chamada a `rm`, Compose ou prune. Isso também protege rollback, recuperação/incidente e identidades desconhecidas: sem correlação independente revisável de PR/projeto/run e evidências operacionais, nenhuma identidade legada pode atravessar para remoção. Uma implementação futura exigirá desenho e revisão separados, snapshot/revalidação contra produção, rollback e evidências imediatamente antes de cada objeto; não faz parte da PR #873.

1. Produzir JSON e TSV, consultar GitHub, reconciliar nginx/diretórios e revisar manualmente cada ID. Começar somente por imagens comprovadamente dispensáveis, não por volumes.
2. Medir `df -Pk /root/backups` e `docker system df`; executar `inventory` para um único projeto.
3. Revisar a saída; não executar apply, pois ele está fail-closed e desabilitado nesta entrega.
4. Qualquer futura remoção de imagens exige etapa separada, explicitamente aprovada e ainda não implementada. Não usar prune amplo.
5. Volumes, backups, imagens e evidências históricas ficam fora desta operação.

Exemplo de dry-run (o arquivo deve conter IDs reais revisados, não placeholders):

```bash
bash scripts/legacy-preview-cleanup.sh inventory /root/reviewed-legacy-previews.tsv
```

O ensaio de restauração isolado/funcional continua pendente. A limpeza relatada não comprova restore e esta entrega não implementa retenção de dois backups locais.

Os testes automatizados exercitam conjuntos parciais/adicionais/duplicados, mudanças de ID/rede/projeto, nomes produtivos, ambos os volumes protegidos, múltiplas linhas e apply desabilitado. Também comprovam inventário sem `rm`, container parado protegendo a imagem e tags duplicadas agrupadas no mesmo IMAGE ID. O cenário “apply controlado remove somente IDs exatos” é deliberadamente **não aplicável**: não existe caminho de remoção nesta revisão.
