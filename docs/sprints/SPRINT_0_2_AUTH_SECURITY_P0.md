# Sprint 0.2 — remoção dos P0 de segurança da autenticação

**Estágio:** 🔵 PR em 02/08/2026. Código local/PR não comprova merge, deploy ou produção.

## Objetivo

Remover do runtime o diagnóstico público `/debug/admin` (TD-ER-001) e impedir que login e bootstrap
administrativo emitam PII ou material derivado de credencial (TD-ER-002), sem mudar banco, JWT,
refresh, sessão, cookies, RBAC, integrações ou deploy.

## Problema e evidências

- `apps/api/src/app.ts` registrava uma rota pública que consultava um administrador e retornava sua
  identidade, estado e prefixo de `passwordHash`.
- `apps/api/src/controllers/authController.ts` registrava e-mail, ID, presença/prefixo/tamanho de
  hash, tamanho da senha e resultado da comparação.
- bootstrap e utilitário administrativo repetiam e-mail e metadados equivalentes; o workflow
  Compose coletava a mesma informação após o login.
- a busca por rotas de debug/diagnóstico encontrou `/debug`, diagnósticos UltraFV3 e scripts
  operacionais. Eles não são equivalentes ao diagnóstico administrativo de credencial e ficam fora
  desta correção; recomenda-se revisão futura da superfície diagnóstica.
- a análise é do repositório e histórico Git local. Produção não foi acessada nem inferida; não há
  remote configurado neste checkout para confirmar PRs além do histórico local.

## Fora do escopo

JWT e duração, refresh/rotação/revogação, sessão, cookies, RBAC, Prisma/migrations, usuários, seeds
funcionais, ERP, deploy, hardening da VPS, retenção global e programa LGPD. A rota `/debug` genérica e
diagnósticos ERP não foram alterados porque não compartilham a consulta de credencial.

## Alteração e observabilidade

Eventos permitidos: `auth_login_success` e `auth_login_failure`, com `requestId` já existente,
`reason` normalizado (`authenticated`, `invalid_credentials` ou `internal_error`), `status` e
`durationMs`. O diagnóstico usa correlação, status, duração e incidência sem identificar a pessoa.

São proibidos: e-mail, nome, ID, senha, hash ou metadados, resultado de comparação, access/refresh
token, cookie, Authorization, payload JWT e detalhe que distinga usuário ausente de senha inválida.
IP completo não foi introduzido. A retenção dos logs continua não comprovada.

## Riscos

- consumidores indevidos do diagnóstico recebem 404, como exigido;
- usuário inativo passa a receber a mesma resposta 401, fechando enumeração;
- a política local não substitui inventário transversal, threat model, SAST/DAST, retenção, MFA ou
  política de sessão.

## Critérios de aceite

1. `/debug/admin` e variante com barra final retornam 404 em qualquer ambiente.
2. Login válido preserva corpo, access token, refresh cookie e perfil; credenciais inválidas têm 401
   e mensagem equivalente para usuário ausente, senha incorreta ou conta inativa.
3. Logs contêm apenas telemetria permitida e erros públicos/internos ficam sanitizados.
4. Rate limit e middleware autenticado permanecem registrados e protegidos contra regressão.
5. Teste baseado na AST bloqueia rota literal ou argumento sensível em logging.
6. Build, typecheck e checks oficiais passam; smoke Compose só é declarado se executado.

## Testes

`npm run test:auth-security`, `npm run build`, `npm run typecheck`,
`npm run test:production-deploy`, `npm run test:production-schema`, smoke Compose quando Docker
estiver disponível, busca de regressão, `git diff --check` e status Git.

## Rollback

Reverter integralmente o commit. Isso restaura a exposição e só deve ocorrer para contenção
temporária seguida de bloqueio externo verificável. Não há rollback de banco, migration ou dados.

## Documentação obrigatória

Este Brief, `STATUS_ATUAL.md`, `DOCUMENTO_MESTRE.md`, `ENTERPRISE_READINESS.md` e `TECH_DEBT.md` são
atualizados. `OPERACAO.md` e `DEPLOY_GUIDE.md` não mudam: não surgiu procedimento novo.

## Impacto em Enterprise Readiness

Os dois P0 evoluem para **correção em PR**, mas Segurança e LGPD permanecem 🔴. TD-ER-001/002
continuam abertos até merge, deploy e validação por SHA.
