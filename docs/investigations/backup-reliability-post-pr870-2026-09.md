# Confiabilidade dos backups após a PR #870 (15/09/2026)

## Baseline, fontes e limite da conclusão

A leitura central foi feita na ordem `STATUS_ATUAL.md` → `DOCUMENTO_MESTRE.md` → `OPERACAO.md` → `DEPLOY_GUIDE.md`. O checkout local recebido estava em `d5e7d2e`, commit de merge da PR #870, e seu pai `8fd857c` contém o diagnóstico do run #64. `git remote -v` não retornou remotes. Assim, **merge da #870 está confirmado apenas pelo histórico local**; estado atual do GitHub, checks, PRs posteriores e implantação não foram comprovados remotamente. A branch desta auditoria nasceu desse merge.

Separação das evidências:

- **Histórico Git local:** merge #870 em `d5e7d2e`; workflow, scripts e documentação descritos abaixo existem nesse baseline.
- **Relato do operador:** run `34983466759` falhou em `disk_capacity`; havia cerca de 4,3 GiB livres; `docker builder prune --filter "until=168h"` informou 2,415 GB recuperados; depois `df` informou 6.759.752 KiB disponíveis. Não houve relato de exclusão de backup ou volume.
- **Cálculo derivado do relato:** contra o default de 5.242.880 KiB, a margem medida foi 1.516.872 KiB. É fotografia posterior, não prova capacidade durante o run #64, capacidade futura ou sucesso de novo backup.
- **Não comprovado:** inventário atual da VPS, agendamentos ativos, checksums dos objetos existentes, retenção realmente executada, restore de dados reais e causalidade da perda histórica atribuída a sobrescrita.

O incidente continua aberto. Nenhum backup, exclusão, prune adicional, Recovery, restore real, deploy, merge ou cutover foi executado nesta tarefa.

## Implementação efetiva e autoridades

| objeto/rotina | produtor | escrita/remoção implementada | concorrência/colisão | integridade e restauração |
|---|---|---|---|---|
| `/root/backups/salesforce_pro_YYYYmmdd_HHMMSS.sql.gz` | `backup.sh` legado, **se estiver agendado fora do Git** | cria dump textual e, só após validação/gzip, remove os excedentes para reter 48 **arquivos**, não 48 dias | precisão de um segundo, sem lock e `gzip -f`: duas execuções no mesmo segundo podem colidir/sobrescrever; não há manifesto | saúde antes/depois, tamanho, cabeçalho e `gzip -t`; restore não é exercitado pela rotina |
| `/root/backups/production-<SHA>-<UTC>-<random>.sql.gz` + `.sha256` | workflow `Prepare Production Recovery Backup` → preparador | exige destino inexistente; não implementa retenção nem remove bundles anteriores | concurrency do Actions + `flock` na VPS; 128 bits aleatórios; colisão falha fechada; temporário no mesmo filesystem | saúde antes/depois, conteúdo mínimo, gzip, SHA-256, freshness e publicação protegida; ensaio é mecanismo separado |
| `/var/backups/gest-o/automatic/*` | produtor histórico não demonstrado ativo | preparador atual apenas valida o par referenciado no env; não escreve nem remove nessa raiz | raiz distinta, protegida; atividade real pendente | par existente precisa ser regular, root:600 e checksum válido para passar o preparador |
| `/var/log/gest-o/backup/bundles/<BUNDLE_ID>/` | biblioteca `pr827-backup-proof.sh`, chamada pelo preparador | `install` cria uma cópia adicional do gzip, publica bundle imutável e troca `latest` atomicamente | ID único, staging, `fsync`/rename, contrato estrito; `latest` é referência mutável, bundle é autoridade imutável | parser revalida tipo, owner/mode, nomes, SHA, identidade de filesystem, freshness e conteúdo fechado |
| `/var/log/gest-o/backup/latest/result.tsv` | mesmo publicador | referência substituída somente depois do bundle completo; falha tenta preservar/restaurar a referência anterior | consumidor rejeita symlink, campos extras/duplicados, mismatch e bundle parcial | aponta para bundle; não deve ser contado como backup separado |

O `backup.sh` e o preparador são produtores independentes e incompatíveis em nome, rotação e prova. Arquivo versionado **não prova cron ativo**. O workflow manual é o único acionador versionado do preparador; seu grupo de concurrency não cancela execução em andamento. A troca de `latest` não apaga bundle anterior. Falha antes da promoção remove somente temporários; falha durante promoção remove os destinos únicos desta execução, não os anteriores. A rotação legada, porém, não reconhece proteção por incidente e pode remover um dump legado entre os 48 excedentes.

O runbook de julho cria dumps/evidências sob uma raiz segura por `RUN_ID` inexistente e não contém rotação automática; esses objetos devem permanecer preservados enquanto ligados ao incidente. Um backup recente não substitui evidência contemporânea anterior à perda.

## Inventário read-only obrigatório da VPS

Preferir, após disponibilizar o SHA aprovado sem cutover:

```bash
cd /apps/gest-o
git status --short --branch && git rev-parse HEAD
bash scripts/diagnose-production-disk-capacity.sh 5242880
```

O script agora cobre os três destinos, filesystem/blocos/inodes, metadados com device+inode para evitar dupla contagem, referência `latest`, cron/timers e uso Docker. Ele não abre dumps nem lê `.env`. Se o script ainda não estiver no checkout, usar somente este bloco curto:

```bash
for d in /root/backups /var/backups/gest-o/automatic /var/log/gest-o/backup; do
  printf '== %s ==\n' "$d"; test -d "$d" || { echo absent; continue; }
  findmnt -T "$d" -o TARGET,SOURCE,FSTYPE,OPTIONS -n; df -Pk "$d"; df -Pi "$d"
  find "$d" -xdev -type f -printf '%p\t%s\t%TY-%Tm-%TdT%TH:%TM:%TSZ\t%D:%i\t%n\n' | sort
done
stat -c 'latest mode=%a owner=%U:%G bytes=%s device=%d inode=%i links=%h' /var/log/gest-o/backup/latest/result.tsv 2>/dev/null || true
crontab -l 2>/dev/null | awk 'BEGIN{IGNORECASE=1} /backup|gest-o/{print "cron_backup_entry_line=" NR}'
systemctl list-timers --all --no-pager 2>/dev/null | sed -n '/backup\|gest-o/ip'
```

Não executar `cat` em env/dump ou imprimir manifesto completo. Para cada inode único, preencher:

| data UTC | tamanho | tipo | produtor inferido/confirmado | integridade | incidente/evidência | restore |
|---|---:|---|---|---|---|---|
| `PENDING_VPS_INVENTORY` | — | — | — | `UNKNOWN` | revisar julho/perda/#64 | `NOT_PROVEN` |

“Produtor inferido pelo nome” deve continuar rotulado como inferência até correlação com cron, timer, workflow e log. Validar checksums em sessão separada revisada, sem imprimir conteúdo. Arquivos com o mesmo `device:inode` são um único payload físico; manifesto e `result.tsv` são evidências, não dumps adicionais.

## Cobertura de recuperação

O preparador atual cobre somente o PostgreSQL `salesforce_pro`. No Compose produtivo versionado, API e WEB não têm volume/mount persistente; buscas no código não encontraram diretório de upload/anexo persistido, e PDFs são respostas geradas. Portanto **não há outro payload de aplicação versionado comprovado**, mas isso não autoriza declarar backup completo antes do inventário dos mounts/volumes reais da VPS.

Uma recuperação da aplicação também exige referências, não segredos em Git:

1. dump íntegro e versão compatível do PostgreSQL; volume original preservado até aceite;
2. SHA aprovado, repositório e imagens API/WEB pinadas (ou capacidade reprodutível de build), com `build-info` correspondente;
3. arquivo canônico protegido `/root/demetra-env/.env`, inventariado por presença/mode/checksum sanitizado, e inventário separado de secrets do GitHub Environment;
4. rede, DNS/proxy/TLS e nomes/identidades allowlisted; configuração UltraFV3/ERP/IA/WhatsApp permanece externa;
5. inventário read-only de todos os mounts do PostgreSQL/API/WEB e de diretórios empresariais fora do Compose. Qualquer arquivo comercial encontrado muda a classificação para cobertura parcial até possuir política própria.

Conclusão atual: **backup lógico do banco, não backup completo comprovado da aplicação**.

## Procedimento revisável para novo backup e ensaio

### Estimativa e gates antes de produção

Não disparar ainda. A aprovação deve registrar `S` = tamanho do maior dump SQL não comprimido recente, `C` = maior gzip/dump custom recente, `D` = database usado no restore e margem operacional `M`. No filesystem de criação, reservar conservadoramente `S + 2C + M`: o preparador mantém plain/candidato e, após promover o gzip, `install` faz outra cópia no bundle. No filesystem do ensaio, reservar `C + D + M`. Se forem o mesmo filesystem, somar os picos simultâneos. Medir, não inferir, e exigir blocos e inodes. O gate fixo de 5 GiB é mínimo operacional, não estimativa do tamanho real.

Após revisão humana: checks/main verdes; checkout limpo igual ao SHA; inventário e espaço ainda válidos; nenhuma execução concorrente; então executar uma única vez o workflow **Prepare Production Recovery Backup**, com confirmação literal e SHA. Aceitar apenas nome novo, destino inicialmente ausente, lock adquirido, dump/gzip/checksum/promoção/bundle/preflight em `PASS`. Preservar todos os anteriores e anexar saída sanitizada.

### Ensaio sintético executável agora

```bash
npm run test:production-backup-restore
npm run test:production-backup-restore:postgres
```

O segundo comando cria PostgreSQL fonte e alvo exclusivos, rede Docker `--internal`, nenhuma porta, storage `tmpfs`, fixture relacional/enum/índice/ledger/incidente, dump custom + SHA, `pg_restore --list`, restore transacional, contagens de objetos/linhas, redump e evidência final sanitizada. Não recebe `DATABASE_URL` produtiva. Como não inicia API, scheduler ou worker, integrações externas e envios ERP ficam bloqueados por ausência do runtime e da rede externa. Para um futuro teste funcional com cópia real, exigir imagem API pinada em rede interna sem rota externa, `ERP_SYNC_SCHEDULER_ENABLED=false`, Communications/WhatsApp/IA desabilitados, credenciais sintéticas e proxy deny-all; validar login/health e leituras selecionadas, nunca `POST /orders`.

Sucesso produtivo requer: checksum e catálogo válidos; restore isolado exit 0; relações/constraints/índices/enums e tabelas esperadas; contagens sanitizadas conciliadas com a origem na mesma janela; segunda conexão e redump legível; Prisma diff revisado com imagem pinada; smoke funcional sem integração externa; duração/RTO e idade/RPO registrados; cleanup apenas dos objetos sintéticos do ensaio. O harness atual grava `SKIP` para Prisma diff e não testa API: esses itens permanecem pendentes, não verdes.

## Política de retenção proposta — não aplicar nesta etapa

Classificar antes de qualquer expiração:

- **Operacional:** diários por 14 dias, semanais por 8 semanas e mensais por 12 meses; ao menos uma cópia criptografada fora da VPS, em conta/bucket com versionamento ou object lock, checksum e acesso testado. A cadência final depende do RPO comercial aprovado.
- **Histórico/migração:** preservar os marcos pré/pós migration, fechamento fiscal ou mudança de formato conforme obrigação comercial/legal; revisão anual com owner e base legal.
- **Incidente/legal hold:** bundles/dumps/evidências de julho, da perda relatada e correlatos ficam sem expiração até encerramento formal append-only pelo responsável. Backups posteriores não os substituem.
- **Verificação:** checksum automatizado frequente e restore isolado amostral mensal; restore completo trimestral, medindo RTO/RPO e capacidade. Cópia externa sem restore testado é apenas redundância, não recuperação comprovada.

Candidatos futuros são somente operacionais fora das janelas aprovadas, após ao menos duas cópias íntegras independentes e restore comprovado. Nunca remover `latest`, seu bundle alvo, evidência sob hold, única cópia, volume produtivo, imagem corrente/rollback ou arquivo de produtor desconhecido. A regra de 48 arquivos permanece descrição do legado e **não** deve ser aplicada aos bundles. Implementar expiração exige PR/autorização própria, dry-run, lista por ID/checksum, proteção de holds e rollback; esta auditoria não altera retenção.

## Critérios de encerramento

1. inventário VPS preenchido sem dupla contagem e produtores/agendamentos ativos confirmados;
2. mounts e arquivos persistentes reais reconciliados, permitindo classificar cobertura;
3. novo bundle único verde no SHA aprovado, preservando anteriores e com cópia externa política;
4. restore isolado do novo backup com conciliação e smoke funcional bloqueado de integrações;
5. RPO/RTO e retenção aprovados, holds de incidente registrados e monitoramento de capacidade definido;
6. somente então registrar causa/consequência do #64 e eventual relação com perda histórica. Até lá: `BACKUP_RECOVERY=NOT_PROVEN`, incidente aberto.
