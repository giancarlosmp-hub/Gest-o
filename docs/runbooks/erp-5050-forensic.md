# Coleta forense read-only do ERP 5050

## Objetivo e limites

Este runbook orienta a coleta reproduzível das evidências da investigação ERP 5050. O runner apenas
executa o SQL versionado de investigação e grava artefatos locais: ele não corrige dados, inicia
serviços, altera schema, executa migrations ou modifica a aplicação. A execução nunca é automática.

## Pré-requisitos

- checkout correto do repositório na VPS e o SQL
  `docs/investigations/evidence/erp-5050-read-only.sql` presente;
- diretório `/root/gest-o-safe` já existente e gravável pelo operador;
- `bash`, `docker`, `git`, `jq`, `sha256sum` e utilitários POSIX disponíveis;
- container PostgreSQL recuperado existente e em execução, com `psql` e autenticação local peer
  para o usuário `postgres`;
- banco resolvido por `DB_NAME`, depois `POSTGRES_DB` inspecionado no container e, por fim,
  `salesforce_pro`.

O runner valida a conexão e abre uma transação read-only antes de criar a coleta. A consulta oficial
também usa transação read-only, timeout de statement de 60 segundos, timeout de lock de 5 segundos e
falha imediata do `psql`.

## Comando oficial

Na raiz do checkout, após aprovação humana explícita:

```bash
DB_CONTAINER=gest-o-db-clean-v2-20260717 \
CONFIRM=FORENSIC5050 \
scripts/production/run-erp-5050-forensic.sh
```

O modo padrão é `CONNECTION_MODE=docker-peer`: toda comunicação usa
`docker exec -i -u postgres` e não lê `DATABASE_URL`. O container pode ser substituído com
`DB_CONTAINER=<nome>`. O modo legado libpq somente é habilitado explicitamente com
`CONNECTION_MODE=libpq`.

Qualquer outro valor (inclusive vazio) aborta. Não execute o arquivo SQL separadamente: o runner é a
única forma oficial de fazer esta coleta em produção.

## Estrutura das evidências

Cada execução cria, sem sobrescrever diretórios existentes,
`/root/gest-o-safe/YYYYMMDD-HHMMSS-forensic-erp5050/`. O diretório contém:

- `consultas.sql`: cópia byte a byte do SQL versionado efetivamente executado;
- `stdout.txt` e `stderr.txt`: saídas separadas do `psql`;
- `psql-version.txt`, `git-revision.txt`, `hostname.txt`, `date.txt` e `database.txt`: contexto;
- `manifest.json`: data, commit, host, `connectionMode`, `dbContainer`, banco, usuário, caminho do
  SQL, hash do SQL e número de linhas, sem URL ou credenciais;
- `consultas.sql.sha256`, `stdout.txt.sha256` e `manifest.json.sha256`: hashes dos artefatos.

O terminal mostra somente o local da evidência e os três SHA256; nenhum resultado forense é resumido
ou reproduzido no console. Os arquivos e o diretório têm permissões restritas ao operador.

## Validar os hashes

Use o diretório exato informado pela execução:

```bash
cd /root/gest-o-safe/YYYYMMDD-HHMMSS-forensic-erp5050
sha256sum --check consultas.sql.sha256
sha256sum --check stdout.txt.sha256
sha256sum --check manifest.json.sha256
```

Cada comando deve informar `OK`. O hash de `consultas.sql` também pode ser comparado com
`sha256sum /apps/gest-o/docs/investigations/evidence/erp-5050-read-only.sql`, ajustando o caminho do
checkout. Preserve o diretório completo; alterar qualquer arquivo invalida seu hash.

## Repetir a investigação

Confirme novamente checkout, commit, container e banco de destino. Execute outra vez o comando oficial
com a confirmação explícita. Cada repetição cria um diretório timestampado independente; nunca
reutilize nem edite uma coleta anterior. Duas tentativas no mesmo segundo não sobrescrevem dados: a
segunda aborta e deve ser repetida depois.

As evidências refletem apenas o snapshot observado durante aquela transação. A proteção transacional
reduz risco acidental, mas não substitui uma role PostgreSQL realmente restrita; metadados de conexão
e erros do servidor também podem variar entre execuções.
