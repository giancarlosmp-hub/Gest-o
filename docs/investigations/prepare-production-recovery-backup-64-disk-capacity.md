# Prepare Production Recovery Backup #64 — capacidade de disco

## Evidência e conclusão limitada

O run `34983466759`, informado para o workflow **Prepare Production Recovery Backup #64** após o merge da PR #869, chegou a `disk_capacity/validate_available_disk_capacity` depois dos gates de path, container, rede, volume e mount. O checkout local está no merge SHA `2a38fb11d13b4d2a942e90ccc225f0accea87414`. Não há credencial do GitHub CLI nem chave/configuração SSH disponível neste ambiente; portanto o log remoto e a VPS não puderam ser consultados daqui.

O código executa `df -Pk` sobre `AUTHORIZED_DIR`, que o workflow fixa como `/root/backups`. Logo, mede os blocos disponíveis no filesystem que contém `/root/backups`, em unidades POSIX de 1024 bytes. A condição é:

```text
available_kb >= PRODUCTION_MIN_DISK_KB (default: 5,242,880 KiB = 5 GiB)
```

O run antigo não publicou o operando medido. O exit 1 prova apenas que a comparação foi falsa; sem a medição da VPS não é possível distinguir insuficiência real de uma medição inesperada ou configuração explícita de limite. Não se deve declarar falta de espaço operacional comprovada.

A correção mantém o limite e a comparação fail-closed, valida que os três valores lidos são inteiros e publica somente: alvo lógico (`authorized_directory`), KiB disponíveis, inodes disponíveis e KiB exigidos. Nenhum path, nome de backup, credencial ou conteúdo é publicado.

## Diagnóstico somente de leitura na VPS

Executar em uma sessão administrativa. Os comandos não leem `.env`, não imprimem URLs/credenciais e não abrem dumps:

```bash
set -u
printf '%s\n' '== filesystem do destino e inodes =='
df -Pk -- /root/backups
df -Pi -- /root/backups
findmnt -T /root/backups -o TARGET,SOURCE,FSTYPE,OPTIONS -n
stat -c 'device=%d mode=%a uid=%u gid=%g' -- /root/backups

printf '%s\n' '== tamanhos (metadados, sem conteúdo) =='
du -x -h -d 2 -- /root/backups 2>/dev/null | sort -h
du -x -h -d 2 -- /var/backups/gest-o/automatic 2>/dev/null | sort -h
find /root/backups /var/backups/gest-o/automatic -xdev -type f \
  -printf '%s\t%TY-%Tm-%TdT%TH:%TM:%TSZ\n' 2>/dev/null | sort -n

printf '%s\n' '== Docker: uso agregado/detalhado somente de leitura =='
docker system df
docker system df -v
docker image ls --digests --format 'table {{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}'
docker volume ls --format 'table {{.Name}}\t{{.Driver}}'

printf '%s\n' '== previews em disco e objetos rotulados =='
du -x -h -d 3 -- /var/www/preview 2>/dev/null | sort -h
docker ps -a --filter label=com.gesto.preview=true \
  --format 'table {{.ID}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.gesto.preview.pr"}}\t{{.Status}}\t{{.Image}}'
docker volume ls --filter label=com.gesto.preview=true \
  --format 'table {{.Name}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.gesto.preview.pr"}}'
docker network ls --filter label=com.gesto.preview=true \
  --format 'table {{.ID}}\t{{.Name}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.gesto.preview.pr"}}'
```

Calcular sem arredondamento o resultado do gate (substituir `AVAILABLE_KB` pelo campo `Available` de `df -Pk` e usar o valor publicado/configurado para `REQUIRED_KB`; na ausência de override, usar `5242880`):

```bash
AVAILABLE_KB=... REQUIRED_KB=5242880
printf 'available_kb=%s required_kb=%s deficit_kb=%s pass=%s\n' \
  "$AVAILABLE_KB" "$REQUIRED_KB" "$(( REQUIRED_KB > AVAILABLE_KB ? REQUIRED_KB - AVAILABLE_KB : 0 ))" \
  "$(( AVAILABLE_KB >= REQUIRED_KB ))"
```

## Candidatos de limpeza (não executar nesta investigação)

Somente após registrar as medições, correlacionar o recuperável com `docker system df -v` e `du`:

1. **Diretórios de previews encerrados** sob `/var/www/preview/pr-*/gesto-pr-*`: o recuperável é a soma exibida por `du`. Dependência: confirmar PR encerrada e ownership pelos labels; usar depois o workflow `preview-cleanup`, não remoção manual improvisada.
2. **Containers, redes e volumes de preview rotulados**: correlacionar PR, project e run. Volumes podem conter bancos de preview e só podem ser removidos pelo cleanup escopado após confirmar que o preview acabou. Nunca incluir volumes produtivos.
3. **Build cache Docker**: o máximo teórico aparece como `RECLAIMABLE` em `docker system df`; validar que não há build concorrente. Se futuramente autorizado, limpeza deve ser deliberada e escopada, nunca `docker system prune` amplo.
4. **Imagens não referenciadas**: somar somente IDs comprovadamente sem container e sem tag necessária. Preservar imagens correntes e todas as tags/IDs de rollback registradas; imagem “unused” no relatório não implica que seja descartável.
5. **Backups antigos fora do bundle atual**: tamanhos vêm de `du/find`, mas preservar o bundle publicado válido, manifesto, backup de recuperação vigente e retenção aprovada. Não remover nenhum backup apenas por idade ou nome.

O tamanho recuperável concreto permanece `NOT_MEASURED` até obter a saída acima. Cache/imagens podem compartilhar camadas; portanto não se deve somar cegamente os totais das linhas.

## Retomada segura

Depois de liberar capacidade de modo aprovado ou corrigir uma medição comprovadamente incorreta:

1. Mesclar a correção, aguardar checks verdes e obter o SHA completo atual de `main`.
2. Executar **Deploy Production** com `phase=build` para esse SHA e confirmar imagens pinadas. Essa fase não autoriza cutover.
3. Disparar **Prepare Production Recovery Backup** uma vez, com confirmação literal `PREPARE_PRODUCTION_RECOVERY_BACKUP` e o mesmo SHA. Confirmar `AVAILABLE_KB >= REQUIRED_KB`, todos os gates `PASS` e a publicação íntegra/recente do bundle.
4. Se a implantação pretendida exigir schema PR827, seguir separadamente `Production Schema PR827`: `preview`, revisão humana e somente então `apply` confirmado.
5. Executar **Deploy Production** com `phase=cutover` apenas após todos os preflights, aprovações e evidências requeridos pelo runbook. Validar saúde e identidade das imagens depois do cutover.
6. **ERP Production Recovery** é humano, separado e excepcional; não é etapa automática para contornar esta falha e não deve ser executado nesta investigação.

## Inventário implementado versus medições coletadas

**Diagnóstico implementado:** `scripts/diagnose-production-disk-capacity.sh` executa somente consultas, aceita como argumento opcional o limite efetivo em KiB (default `5242880`), calcula o déficit, inventaria os três diretórios confirmados, correlaciona previews por labels e apresenta `docker system df -v`. A busca por outros consumidores fica no mesmo filesystem (`du -x`), profundidade 1, baixa prioridade e timeout de 60 segundos. O script não lê arquivos `.env` nem conteúdo de dumps.

**Medições realmente coletadas:** nenhuma. O ambiente desta investigação continua sem material SSH para a VPS. Consequentemente, espaço disponível, déficit, tamanhos e objetos obsoletos continuam `NOT_MEASURED`; nenhum candidato é classificado como dispensável.

Não presumir que o arquivo de uma PR ainda não disponibilizada exista na VPS. Antes de executar, confirmar o caminho real, SHA, worktree e arquivo sem mudar branch:

```bash
cd /apps/gest-o
printf 'checkout=%s\n' "$(git rev-parse --show-toplevel)"
git status --short --branch
git rev-parse HEAD
test -x scripts/diagnose-production-disk-capacity.sh && sha256sum scripts/diagnose-production-disk-capacity.sh
```

Se ausente, usar o bloco inline read-only acima. Depois de merge e checks verdes, o meio suportado para disponibilizar a versão é executar **Deploy Production** somente em `phase=build` para o SHA aprovado; isso atualiza checkout/constrói imagens sem cutover. Então revalidar SHA/worktree/arquivo e anexar a saída de `bash scripts/diagnose-production-disk-capacity.sh 5242880` à revisão. Não copiar o script avulso nem atualizar manualmente o checkout nesta investigação.

Se o novo run sanitizado publicar `PRODUCTION_BACKUP_DISK_REQUIRED_KB` diferente, fornecer exatamente esse inteiro como argumento. Não extrair nem imprimir o arquivo de ambiente.

## Mecanismo existente para previews

Não foi criada automação de limpeza paralela. O workflow `.github/workflows/preview-cleanup.yml` já reage ao fechamento da PR, descobre somente recursos com `com.gesto.preview=true`, valida o projeto `gesto-pr-<PR>-*`, confere PR/run/workflow e exige que o run esteja concluído antes do `docker compose down -v` escopado. Qualquer remoção proposta de preview deve reutilizar esse workflow; o inventário novo é apenas leitura.

## Proposta exata de remoção — pendente de evidência

A lista só pode ser preenchida depois da saída real. Para revisão, registrar uma linha por objeto, sem somar camadas compartilhadas:

| identificação | tamanho exclusivo/reclaimable | motivo de possível obsolescência | vínculo PR/container/imagem | prova de não-produção e não-rollback | ação proposta |
|---|---:|---|---|---|---|
| `NOT_MEASURED` | `NOT_MEASURED` | aguardando inventário | aguardando labels/IDs | aguardando containers ativos e registros de rollback | nenhuma |

Para imagens, usar o valor agregado `RECLAIMABLE` do Docker como teto, nunca a soma da coluna `SIZE`. Para previews, exigir PR fechada, labels coerentes, run concluído e ausência de qualquer vínculo com containers produtivos. Para backups, excluir da proposta o bundle publicado vigente, seu manifesto/evidência, todo backup de recuperação válido sujeito à retenção e qualquer arquivo cuja função não esteja comprovada. Até essa revisão, a estimativa recuperável é `NOT_MEASURED` e a lista exata de remoções é vazia.
