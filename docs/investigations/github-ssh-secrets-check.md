# Investigação: credenciais SSH do workflow de preview

## Escopo
Arquivo analisado: `.github/workflows/preview.yml`.

Objetivo: validar se o workflow de preview possui todas as credenciais necessárias para conexão SSH na VPS e execução de deploy via GitHub Actions.

---

## 1) Inspeção do workflow (`preview.yml`)

O step de deploy usa `appleboy/ssh-action@v1.2.0` com os seguintes parâmetros SSH:

- `host: ${{ secrets.VPS_HOST }}`
- `username: ${{ secrets.VPS_USER }}`
- `key: ${{ secrets.VPS_KEY }}`
- `port: 22022`

### Mapeamento solicitado vs atual

- `SSH_HOST` → **atualmente é `VPS_HOST`**
- `SSH_USER` → **atualmente é `VPS_USER`**
- `SSH_KEY` → **atualmente é `VPS_KEY`**
- Porta SSH → **definida explicitamente: `22022`**

✅ Conclusão: o workflow está configurado para autenticação por **chave privada SSH** (não por senha) e já define porta customizada.

---

## 2) Dependência de secrets

### Secrets efetivamente usados no workflow

Secrets referenciados:

- `secrets.GITHUB_TOKEN` (token automático do Actions para autenticação GitHub API/clone)
- `secrets.VPS_HOST`
- `secrets.VPS_USER`
- `secrets.VPS_KEY`

### Observação importante de nomenclatura

Se sua operação/padrão interno espera os nomes abaixo:

- `secrets.SSH_HOST`
- `secrets.SSH_USER`
- `secrets.SSH_KEY`

então será necessário **ou**:

1. criar secrets com os nomes atualmente usados (`VPS_*`), **ou**
2. ajustar o workflow para usar `SSH_*`.

No estado atual, o workflow **não** lê `SSH_HOST/SSH_USER/SSH_KEY`; ele lê `VPS_HOST/VPS_USER/VPS_KEY`.

---

## 3) Fallback de autenticação (senha vs chave)

- O workflow passa apenas `key:` para `appleboy/ssh-action`.
- **Não há `password:` configurado**.
- Portanto, **não existe fallback para senha** no estado atual.

✅ Exigência atual: autenticação por **chave privada SSH**.

### Formato da chave esperado

Para `appleboy/ssh-action`, o valor em `key` deve ser a chave privada completa em multiline, por exemplo:

- `-----BEGIN OPENSSH PRIVATE KEY-----` (OpenSSH, geralmente ED25519 ou RSA convertida)
- `-----BEGIN RSA PRIVATE KEY-----` (PEM tradicional)

Na prática, tanto RSA quanto ED25519 funcionam, desde que a VPS aceite a chave pública correspondente em `~/.ssh/authorized_keys` do usuário remoto.

---

## 4) Checklist de configuração no GitHub

Navegação:

`GitHub repository → Settings → Secrets and variables → Actions → New repository secret`

### Checklist recomendado

1. Criar/confirmar secret de host:
   - **Nome (atual do workflow):** `VPS_HOST`
   - Valor: IP público ou hostname da VPS (ex.: `203.0.113.10`)

2. Criar/confirmar secret de usuário:
   - **Nome (atual do workflow):** `VPS_USER`
   - Valor: usuário SSH da VPS (ex.: `root`, `ubuntu`, `deploy`)

3. Criar/confirmar secret da chave privada:
   - **Nome (atual do workflow):** `VPS_KEY`
   - Valor: chave privada completa (incluindo cabeçalho e rodapé)

4. Validar porta SSH:
   - Workflow usa `port: 22022`
   - Confirmar que o `sshd` da VPS está ouvindo em `22022`
   - Confirmar liberação no firewall/security group

> Se preferir padronizar com `SSH_HOST/SSH_USER/SSH_KEY`, será necessário alterar o workflow para esses nomes.

---

## 5) Validação de formato da chave

Para evitar erro de chave mal formada:

- Não remover cabeçalho/rodapé (`BEGIN ...` / `END ...`)
- Não converter para linha única
- Preservar quebras de linha originais
- Evitar espaços extras no início/fim
- Garantir que a chave privada corresponde à chave pública instalada na VPS

### Exemplo válido (estrutura)

```text
-----BEGIN OPENSSH PRIVATE KEY-----
(base64 multiline)
-----END OPENSSH PRIVATE KEY-----
```

---

## 6) Step opcional de validação de conexão

Sem alterar código crítico, segue sugestão para robustez futura:

Adicionar um step simples antes do deploy completo, executando comando remoto curto (`whoami` ou `echo "SSH OK"`) via `appleboy/ssh-action` com os mesmos `host/username/key/port`.

Isso ajuda a separar erro de conectividade SSH de erro de deploy/aplicação.

---

## 7) Erros comuns e diagnóstico rápido

1. `Permission denied (publickey)`
   - `VPS_KEY` incorreta
   - chave pública não está em `authorized_keys`
   - usuário (`VPS_USER`) não corresponde ao dono da chave

2. `Host unreachable` / timeout
   - `VPS_HOST` inválido
   - VPS indisponível
   - firewall bloqueando `22022`

3. `Invalid format` / parsing key error
   - chave com quebras de linha quebradas
   - chave copiada parcialmente
   - caracteres extras antes/depois da chave

4. Falha por porta incorreta
   - workflow usa `22022`, mas VPS escuta em `22` (ou outra)

---

## 8) Relatório final (status esperado vs atual)

### Status esperado

- Workflow com `host`, `username`, `key` e `port` válidos
- Secrets configurados no GitHub com nomes usados no workflow
- Chave privada válida e correspondente ao `authorized_keys`
- Porta SSH liberada na infraestrutura

### Status atual (com base no arquivo)

- ✅ Há configuração de SSH completa para conexão por chave
- ✅ Porta SSH está explicitamente definida (`22022`)
- ⚠️ Nomes esperados no pedido (`SSH_*`) **não batem** com o arquivo atual (`VPS_*`)
- ⚠️ Não existe fallback para senha (somente chave)

### Pronto para deploy?

**Parcialmente pronto**, condicionado à existência e correção de:

- `VPS_HOST`
- `VPS_USER`
- `VPS_KEY`
- porta `22022` funcional na VPS

### Ação exata recomendada

1. Conferir/registrar secrets `VPS_HOST`, `VPS_USER`, `VPS_KEY` no repositório.
2. Validar chave privada multiline sem alteração de formatação.
3. Garantir que a chave pública correspondente está no `authorized_keys` do `VPS_USER`.
4. Confirmar conectividade para `VPS_HOST:22022`.
5. (Opcional) inserir step de smoke test SSH antes do script de deploy.

---

## Conclusão

O workflow já contém os parâmetros essenciais de SSH para deploy remoto via `appleboy/ssh-action`, mas depende estritamente de secrets com prefixo `VPS_` e autenticação por chave privada. Se esses secrets e a porta `22022` estiverem corretamente configurados, a esteira deve conseguir conectar na VPS.
