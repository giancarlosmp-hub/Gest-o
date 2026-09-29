# Identidade da imagem anterior no cutover — 29/09/2026

## Escopo e evidência

O caminho auditado é `deploy-production.yml` → `production-deploy-entrypoint.sh` →
`deploy-production.sh` → inventário → `production-rollback.sh`. Nenhum comando foi executado na
VPS. Remotes, PRs e incidentes remotos estão **NOT_VERIFIED** porque este checkout não possui remote
Git configurado.

No incidente, a API informava `.Config.Image=gest-o-api:310198aea...` e
`.Image=sha256:f4dcc...`, enquanto essa tag local resolvia para `sha256:0e5c...`. A instrução que
falhava era `docker image inspect "$image_id"`, com `image_id=sha256:f4dcc...`; em seguida o código
proibia fallback pelo container. A correção anterior validava somente as imagens novas e, portanto,
não alterava esse gate.

O label OCI de revisão igual a `310198aea...` identifica o código-fonte declarado, não o artefato.
Dois builds do mesmo Git SHA podem produzir configs/manifests diferentes e uma nova construção pode
movimentar a tag. Logo, os valores coletados não provam que `0e5c...` seja o artefato executado; sem
um descriptor/repo digest local ligando-o criptograficamente a `f4dcc...`, a API deve continuar
bloqueada. A hipótese específica “BuildKit causou a divergência” permanece não demonstrada.

## Correção

Antes de qualquer `docker stop`, o resolver tenta a identidade `.Image` diretamente. Se ela não for
inspecionável, tenta `.Config.Image`, mas só a aceita quando a identidade do runtime coincide com o
config ID, descriptor digest ou manifest digest exposto por `docker image inspect`. Label e nome da
tag não participam dessa prova. O config ID resolvido é gravado como referência imutável usada pelo
Compose no rollback; método, identidade comprovada, artefato e motivo de bloqueio são separados no
log e no inventário. API e WEB são verificadas independentemente e qualquer falha ocorre antes do
marcador e das paradas.

## Recuperação quando o artefato realmente não existe

Não usar `docker commit`, export ou retag baseado apenas no SHA Git. Em uma mudança operacional
separada e revisada: localizar em registry/backup o manifest digest exato previamente registrado,
importá-lo sem remover imagens, comprovar a cadeia descriptor/manifest/config contra `.Image`, e
reexecutar o cutover. Se essa prova não existir, preservar o runtime atual e preparar novo plano de
deploy/rollback aprovado; a ausência não pode ser convertida em sucesso.

## Limitações

Docker não está instalado neste ambiente, então a reprodução OCI real não foi executada. O teste
comportamental usa o script de produção com uma fronteira Docker determinística e cobre resolução
direta, vínculo descriptor/config, tag reconstruída com mesmo label (label deliberadamente não é
consultado) e ausências. Uma prova Docker isolada deve ser adicionada/executada no CI equipado com
Docker, sem tocar produção.
