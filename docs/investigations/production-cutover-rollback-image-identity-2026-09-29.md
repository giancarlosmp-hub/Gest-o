# Identidade da imagem anterior no cutover e análise de recuperação do artefato — 29/09/2026

## Escopo e evidência

O caminho auditado é `deploy-production.yml` → `production-deploy-entrypoint.sh` →
`deploy-production.sh` → inventário → `production-rollback.sh` → `scripts/lib/production-rollback-image.sh`.
Nenhum comando mutativo foi executado na VPS. Remotes, PRs e incidentes remotos estão **NOT_VERIFIED**
porque este checkout não possui remote Git configurado.

No incidente reportado no ambiente produtivo:
- **Runtime API:** `.Config.Image = gest-o-api:310198aea1f09177e158bf85b89a6b9ecd356f9a` E `.Image = sha256:f4dcccfb2c25004a61f117c022fb5028d16ac891a3d7648a05b3168939a6dda2`.
- **Resultado da resolução:** O cutover foi bloqueado fail-closed com o erro:
  `api sem imagem anterior verificável; nenhuma imagem local demonstra vínculo criptográfico com sha256:f4dcccfb2c25004a61f117c022fb5028d16ac891a3d7648a05b3168939a6dda2; fallback por container proibido`.

A trava de segurança (`resolve_rollback_image`) funcionou exatamente como projetada: ela recusou prosseguir para o cutover sem comprovação criptográfica local do artefato de rollback da versão em execução.

---

## Investigação das fontes autorizadas de recuperação do artefato

Investigaram-se estritamente as três fontes autorizadas para recuperação da imagem anterior referente ao commit `310198aea1f09177e158bf85b89a6b9ecd356f9a` e digest `.Image` `sha256:f4dcccfb2c25004a61f117c022fb5028d16ac891a3d7648a05b3168939a6dda2`:

### 1. Registry (Registro OCI Externo)
- **Análise:** A arquitetura do Gest-o (`docker-compose.production.yml`, `scripts/deploy-production.sh`, `.github/workflows/deploy-production.yml`) realiza a construção de imagens OCI diretamente no Docker Engine da VPS host em `MODE=build`. Não existe um registro de imagens remoto (como Docker Hub, GHCR, AWS ECR ou registro privado) configurado ou utilizado no pipeline do projeto.
- **Conclusão:** Fonte **Inexistente / Indisponível**. Nenhuma imagem com digest `sha256:f4dcc...` reside em um registry externo.

### 2. Backup OCI (Tarball / Bundle de Imagens OCI)
- **Análise:** As rotinas automatizadas de backup do sistema (`backup.sh`, `scripts/prepare-production-recovery-backup.sh`) geram dumps lógicos do banco PostgreSQL (`.sql.gz`) e arquivos de configuração de ambiente (`production.env`). Não existe rotina automatizada que realize o salvamento em tarball (`docker save`) de imagens OCI em `/root/backups` ou `/var/log/gest-o/backup/`.
- **Conclusão:** Fonte **Inexistente / Indisponível**. Não existem tarballs OCI salvos para a imagem `sha256:f4dcc...`.

### 3. Rebuild reproduzível do commit `310198aea1f09177e158bf85b89a6b9ecd356f9a`
- **Análise:**
  - A reconstrução (`docker compose build`) a partir do código do commit `310198...` produz um novo conjunto de camadas e um novo Config ID (ex: `sha256:0e5c...`).
  - As identidades de imagem OCI (`sha256:...`) derivam de hashes criptográficos exatos da configuração da imagem e dos digests das camadas, os quais variam conforme datas de criação, timestamps de arquivos e resolução do gerenciador de pacotes (`npm`).
  - O validador `resolve_rollback_image` compara o `.Image` do container em execução (`sha256:f4dcc...`) contra o Config ID, Descriptor Digest e RepoDigests da imagem local.
  - Aplicar a tag `gest-o-api:310198...` ou o rótulo `org.opencontainers.image.revision=310198...` à nova imagem `0e5c...` **não** estabelece um vínculo criptográfico com `f4dcc...`. O validador desconsidera nomes de tags e rótulos de revisão por projeto, exigindo coincidência de digest criptográfico.
- **Conclusão:** Fonte **Incompatível Criptograficamente**. O rebuild gera `0e5c...`, que não é idêntico a `f4dcc...`.

---

## Declaração de Bloqueio Operacional (Bloqueio Operacional)

Como nenhuma das fontes autorizadas (Registry, Backup OCI ou Rebuild) fornece um artefato OCI local com vínculo criptográfico verificável ao digest em execução `sha256:f4dcccfb2c25004a61f117c022fb5028d16ac891a3d7648a05b3168939a6dda2`:

1. **Declarado o BLOQUEIO OPERACIONAL do Cutover.**
2. **Proibição Estrita de Soluções Improvisadas:** É expressamente proibido usar `docker commit`, `docker export`, criação de tags fictícias ou relaxar o gate fail-closed em `scripts/lib/production-rollback-image.sh`.
3. **Preservação do Runtime:** O container anterior continua ativo, saudável e atendendo 100% das requisições em produção. Nenhuma parada (`docker stop`) ou troca deve ser forçada sem a presença de um artefato de rollback devidamente comprovado.

---

## Procedimento de Recuperação e Validação do Artefato Antes do Cutover

### Cenário A: Se existir um arquivo de backup OCI externo
Caso a equipe de infraestrutura possua um arquivo de exportação OCI (`.tar`) do artefato original `sha256:f4dcc...`:

1. **Importação do Artefato:**
   ```bash
   docker load -i gest-o-api-f4dcccfb.tar
   ```
2. **Validação Criptográfica Antes do Cutover:**
   Inspecionar a imagem importada para confirmar o Config ID e digests:
   ```bash
   docker image inspect sha256:f4dcccfb2c25004a61f117c022fb5028d16ac891a3d7648a05b3168939a6dda2
   ```
   Confirmar que o retorno de `docker image inspect` exibe a hash `sha256:f4dcccfb2c25004a61f117c022fb5028d16ac891a3d7648a05b3168939a6dda2`.
3. **Execução do Cutover:**
   Após validar a presença do artefato criptográfico, reexecutar o cutover de forma autorizada:
   ```bash
   MODE=cutover CONFIRM=PRODUCTION_CUTOVER_REAUTHORIZED bash scripts/deploy-production.sh
   ```

### Cenário B: Se a imagem `sha256:f4dcc...` for permanentemente irrecuperável
Caso o artefato OCI original não exista em nenhuma mídia externa:

1. **Manutenção do Bloqueio:** O cutover para novos commits permanece bloqueado até a transição controlada do baseline.
2. **Procedimento de Re-baselining Operacional Autorizado:**
   - Realizar uma janela de manutenção aprovada pela liderança de operações e arquitetura.
   - Construir e validar a nova imagem baseline (`MODE=build`).
   - Sob autorização operacional explícita e procedimento documentado de transição de baseline (sem contornar as validações do script de deploy), atualizar a instância baseline para a nova versão validada e estabelecer a nova imagem fixada no Docker Engine como a referência de rollback autorizada para os deploys subsequentes.

---

## Validação e Garantia Fail-Closed

O mecanismo de segurança em `scripts/lib/production-rollback-image.sh` e `scripts/deploy-production.sh` permanece 100% ativo e inalterado:
- Valida o `.Image` do container rodando contra Config ID, Descriptor Digest e RepoDigests.
- Exige `CONFIRM=PRODUCTION_CUTOVER` ou `CONFIRM=PRODUCTION_CUTOVER_REAUTHORIZED` após revisão de marcador.
- Impede qualquer cutover se a imagem de rollback não possuir comprovação criptográfica local.

---

## Acompanhamento (07/10/2026): cutover sem rebuild e artefato de release

### Estado do runtime antes do PR 2 (conferido na VPS, somente leitura)
- Docker Engine 29.3.0, Docker Compose v5.1.0, image store do containerd (`driver-type io.containerd.snapshotter.v1`).
- Containers em produção: api `sha256:fa57de45f01d8bf69985df4f78b4ab36b117752ad631d92ad83bc2d65cdea3dc`, web `sha256:9968b1d8b6d9c76fbbe3bacc01c3ff1d91df8ffd3764c8131ad8feb592983cd5`. As duas imagens são inspecionáveis e têm `org.opencontainers.image.revision=6e03c9ae2f78d08d05a8041b6b94b01f45eaa55b`.
- Esses IDs são iguais aos registrados em `/var/log/gest-o/rebaseline/6e03c9ae…/result.tsv`, e os tars de `/var/log/gest-o/oci-backups/6e03c9ae…/` são válidos. A suspeita de que o rebuild do cutover nº 223 teria desalinhado o runtime do rebaseline não se confirmou.

### Causa do `.Image` não inspecionável (`f4dcc…`)
Reproduzida em 06/10/2026 no Docker Desktop 29.2.1 com containerd: quando a única tag de uma imagem em uso por um container é movida por um novo build, a imagem deixa de ser inspecionável, embora o container continue rodando. Uma imagem com uma segunda tag que não se move (tag de release) continua inspecionável. Também confirmado: no containerd, o `.Id` é o digest do index OCI; `docker save` → remoção → `docker load` preserva o ID; e `docker compose up` com `image: sha256:…` e `--pull never` funciona.

### Proteção manual aplicada antes do merge do PR 2
Tags de release criadas na VPS em **Wed Oct 7 12:21:10 AM UTC 2026** para fixar o runtime atual. Elas só acrescentam um nome à imagem: nenhum container foi parado ou recriado. O `release_pin` do PR 2 as aceita como `state=existing`. Saída registrada:

```
date -u
API=sha256:fa57de45f01d8bf69985df4f78b4ab36b117752ad631d92ad83bc2d65cdea3dc
WEB=sha256:9968b1d8b6d9c76fbbe3bacc01c3ff1d91df8ffd3764c8131ad8feb592983cd5
for pair in "api $API" "web $WEB"; do
  role=${pair%% *}; id=${pair#* }; T="gest-o-$role-release:sha256-${id#sha256:}"
  cur=$(docker image inspect -f '{{.Id}}' "$T" 2>/dev/null || true)
  if [ -z "$cur" ]; then
    docker image inspect -f '{{.Id}}' "$id" >/dev/null && docker tag "$id" "$T" && echo "CRIADA $T"
  elif [ "$cur" = "$id" ]; then
    echo "JA EXISTE (mesmo ID) $T"
  else
    echo "PARE: $T aponta para $cur"
  fi
  docker image inspect -f '{{.Id}} {{json .RepoTags}}' "$T"
done
docker ps --format '{{.Names}}  {{.Status}}' | grep -i production
Wed Oct  7 12:21:10 AM UTC 2026
CRIADA gest-o-api-release:sha256-fa57de45f01d8bf69985df4f78b4ab36b117752ad631d92ad83bc2d65cdea3dc
sha256:fa57de45f01d8bf69985df4f78b4ab36b117752ad631d92ad83bc2d65cdea3dc ["gest-o-api-rebaseline:6e03c9ae2f78d08d05a8041b6b94b01f45eaa55b","gest-o-api-release:sha256-fa57de45f01d8bf69985df4f78b4ab36b117752ad631d92ad83bc2d65cdea3dc","gest-o-api:6e03c9ae2f78d08d05a8041b6b94b01f45eaa55b"]
CRIADA gest-o-web-release:sha256-9968b1d8b6d9c76fbbe3bacc01c3ff1d91df8ffd3764c8131ad8feb592983cd5
sha256:9968b1d8b6d9c76fbbe3bacc01c3ff1d91df8ffd3764c8131ad8feb592983cd5 ["gest-o-web-rebaseline:6e03c9ae2f78d08d05a8041b6b94b01f45eaa55b","gest-o-web-release:sha256-9968b1d8b6d9c76fbbe3bacc01c3ff1d91df8ffd3764c8131ad8feb592983cd5","gest-o-web:6e03c9ae2f78d08d05a8041b6b94b01f45eaa55b"]
gest-o-production-api-1  Up 3 hours (healthy)
gest-o-production-web-1  Up 3 hours (healthy)
```

### O que o PR 2 muda (resumo; procedimento em `docs/DEPLOY_GUIDE.md`)
- `phase=build` recusa reconstruir um SHA que está em produção, fixa as imagens novas em tags `gest-o-<role>-release:sha256-<hex>`, grava `deploy-builds/<sha>/build.tsv` e cria o artefato verificado (`docker save | gzip -1`) do runtime em execução.
- `phase=cutover` não reconstrói: sobe os IDs da evidência com `--pull never`, prova `.Image` e `/health/version` (`commit`/`builtAt`) depois de subir, executa o rollback em qualquer rejeição dentro da janela stop/start e salva o artefato da release nova sem nunca reverter um runtime saudável (falha de artefato = exit 3).
- O inventário de rollback ganha o caminho `release-artifact-load` antes do rebaseline. O predicado de `scripts/lib/production-rollback-image.sh` continua sendo a única prova aceita.
