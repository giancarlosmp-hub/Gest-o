# Investigação: Preview abre login, mas retorna “Login inválido”

## Escopo e segurança
- Investigação baseada em leitura de código, workflows e configurações do repositório.
- Não foram executados comandos destrutivos.
- Não envolve alteração de produção.
- Não envolve `migrate reset`, limpeza de volumes, nem `db push` manual no servidor durante este diagnóstico.

## Resposta objetiva (resumo executivo)
**Causa mais provável:** o preview está subindo sem usuário válido no banco (banco vazio ou sem seed/admin bootstrap), então o endpoint de login retorna 401 por credenciais inválidas.

Diagnóstico por item:
1. **Preview sem usuário?** → **Provavelmente sim** (se banco estiver vazio, não há usuário para autenticar).
2. **Preview sem seed?** → **Sim por padrão** (`SEED_ON_BOOTSTRAP=false` no compose/.env exemplo).
3. **Preview sem migração?** → **Menos provável** quando API sobe via Dockerfile padrão, pois o bootstrap executa `prisma db push` no startup.
4. **Próximo passo exato:** validar no servidor se há usuários; se `count=0`, criar usuário admin idempotente com script `admin:ensure-user` e opcionalmente habilitar bootstrap admin no preview.

## Evidências técnicas

### 1) Endpoint de login e validação
- O frontend chama `POST /auth/login`.
- O backend busca usuário por email em `User`.
- Se não encontrar usuário, retorna **401** com mensagem de credenciais inválidas.
- Se usuário inativo, retorna **403**.
- Se senha inválida, retorna **401**.

Conclusão: “Login inválido” no frontend é consistente com:
- usuário inexistente,
- senha incorreta,
- ou usuário inativo (neste caso backend retorna mensagem diferente, mas frontend simplifica erro).

### 2) Seed/admin bootstrap no projeto
- O startup de container (`docker:start`) executa:
  1. espera banco,
  2. `prisma db push`,
  3. `ensureAdminBootstrap()` (somente se `ADMIN_BOOTSTRAP_ENABLED=true`),
  4. seed padrão (somente se `SEED_ON_BOOTSTRAP=true`).
- No `docker-compose.yml`, os padrões são:
  - `SEED_ON_BOOTSTRAP=false`
  - `ADMIN_BOOTSTRAP_ENABLED=false`

Conclusão: em preview “default”, **não há criação automática de usuário**.

### 3) Migrações no preview
- O script `docker:start` chama `npm run prisma:migrate -w @salesforce-pro/api`.
- Em `apps/api/package.json`, `prisma:migrate` está mapeado para `prisma db push`.

Conclusão: se o preview usa a imagem/pipeline padrão da API, schema tende a ser aplicado no startup. Portanto, “sem migração” não é hipótese principal para este sintoma específico de login inválido.

### 4) Preview workflow atual
- O workflow `.github/workflows/preview.yml` **não** executa deploy real da stack (não faz `git clone/pull`, não roda `docker compose up`, não aplica env/seed/bootstrap); ele só executa comandos de debug e comenta a URL.

Conclusão: o ambiente acessível pode estar:
- desatualizado,
- com configuração manual fora do workflow,
- com banco inesperado,
- sem seed/bootstrap de usuário.

Isso aumenta a chance de divergência entre “preview que abre” e “preview corretamente provisionado”.

## Arquivos inspecionados
- `.github/workflows/preview.yml`
- `.github/workflows/deploy-prod.yml`
- `.github/workflows/docker-compose-ci.yml`
- `docker-compose.yml`
- `.env.example`
- `apps/api/src/controllers/authController.ts`
- `apps/api/src/routes/authRoutes.ts`
- `apps/api/src/scripts/bootstrap.ts`
- `apps/api/src/config/env.ts`
- `apps/api/src/bootstrap/ensureAdminBootstrap.ts`
- `apps/api/src/scripts/adminEnsureUser.ts`
- `apps/api/package.json`
- `apps/api/prisma/seed.js`
- `apps/api/prisma/schema.prisma`
- `apps/web/src/context/AuthContext.tsx`
- `apps/web/src/pages/LoginPage.tsx`

## Comandos seguros (read-only) para validar no servidor preview
> Execute dentro do diretório do preview (ex.: `/var/www/preview/pr-<N>`).

1. Ver containers e status:
```bash
docker compose ps
```

2. Confirmar env efetivo do compose (sem expor secrets em output público):
```bash
docker compose config
```

3. Ver logs de startup da API (confirmar `prisma db push`, bootstrap e possíveis erros):
```bash
docker compose logs --tail=300 api
```

4. Confirmar endpoint de health:
```bash
curl -sS http://127.0.0.1:${API_PORT:-4000}/health
```

5. Conferir quantidade de usuários no banco (read-only):
```bash
docker compose exec -T api node -e "import('@prisma/client').then(async ({PrismaClient}) => { const p = new PrismaClient(); const count = await p.user.count(); console.log(JSON.stringify({userCount: count})); await p.$disconnect(); }).catch((e)=>{ console.error(e); process.exit(1); })"
```

6. Listar emails/roles dos usuários existentes (read-only):
```bash
docker compose exec -T api node -e "import('@prisma/client').then(async ({PrismaClient}) => { const p = new PrismaClient(); const users = await p.user.findMany({ select: { email: true, role: true, isActive: true, createdAt: true }, orderBy: { createdAt: 'asc' }, take: 20 }); console.log(JSON.stringify(users, null, 2)); await p.$disconnect(); }).catch((e)=>{ console.error(e); process.exit(1); })"
```

7. Conferir banco alvo (host/db) sem imprimir senha:
```bash
docker compose exec -T api node -e "const u = process.env.DATABASE_URL || ''; const m = u.match(/postgres(?:ql)?:\/\/([^@]+@)?([^:/?#]+)(?::(\d+))?\/([^?]+)/i); console.log(JSON.stringify({hasDatabaseUrl: Boolean(u), host: m?.[2] ?? null, port: m?.[3] ?? null, database: m?.[4] ?? null}, null, 2));"
```

## Comando seguro e idempotente para criar admin no preview (se necessário)
Se `userCount=0` (ou não houver usuário administrativo conhecido), use:

```bash
docker compose exec -T api npm run admin:ensure-user -w @salesforce-pro/api -- --name "Admin Preview" --email "admin.preview@empresa.com" --password "<SENHA_FORTE_AQUI>" --role "diretor" --region "Nacional"
```

- Este comando **não reseta banco**.
- Ele é **idempotente**: cria se não existir, atualiza se já existir.

## Recomendação final única
**Padronizar bootstrap administrativo no preview** (não em produção):
- No ambiente preview, configurar:
  - `ADMIN_BOOTSTRAP_ENABLED=true`
  - `ADMIN_BOOTSTRAP_NAME`, `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD`, `ADMIN_BOOTSTRAP_ROLE`, `ADMIN_BOOTSTRAP_REGION`
- Manter `SEED_ON_BOOTSTRAP=false` por padrão para evitar carga de dados fictícios desnecessária.

Justificativa:
- resolve de forma determinística o login no preview;
- evita depender de seed massivo;
- mantém risco baixo e sem impacto em produção;
- mantém comportamento idempotente e auditável.

## Próximo passo exato a executar agora
1. Rodar os comandos read-only acima para confirmar `userCount` e banco alvo.
2. Se `userCount=0` (ou sem admin válido), rodar `admin:ensure-user` com credenciais seguras.
3. Testar login no preview com esse usuário.
4. Em seguida, ajustar provisionamento do preview para sempre subir com `ADMIN_BOOTSTRAP_ENABLED=true` + variáveis obrigatórias.
