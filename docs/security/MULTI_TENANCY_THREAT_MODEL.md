# Threat Model Multi-Tenancy

**Estado:** Sprint 1.0A, desenho preventivo; não comprova isolamento implementado.
**Método:** STRIDE (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service e Elevation of privilege), com revisão de fluxos de confiança.
**Escopo:** identidade, APIs, banco, jobs, cache, UltraFV3, Communications, IA, observabilidade, operação e ciclo de dados. O risco é avaliado para o estado multiempresa pretendido, sem desconto pelo checkout ainda ser single-tenant.

## Fronteiras e ativos

O cliente não é uma fronteira confiável. Apenas token validado, resolução criptograficamente verificada de conta externa, envelope emitido pelo scheduler e sessão break-glass auditada podem originar contexto. API/repositories formam a primeira barreira; constraints compostas e RLS defensiva formam barreiras independentes; workers e integrações repetem a mesma boundary. Dados de negócio, credenciais, identidade, auditoria e disponibilidade por empresa são ativos protegidos.

## Registro STRIDE

| ID | Ativo | Vetor | Impacto | Probabilidade | Severidade | Controle preventivo | Controle detectivo | Teste obrigatório | Owner | Sprint |
|---|---|---|---|---|---|---|---|---|---|---|
| MT-S01 (S/E) | Identidade do tenant | Atacante declara outro tenant | Acesso integral cruzado | Alta | Crítica | TenantContext derivado de autoridade validada | log de negação por request/tenant sanitizado | token A não acessa B | Segurança | 1.0A–C |
| MT-S02 (S/T) | Contexto da requisição | `tenantId` em body, query ou header livre | Spoofing e escrita cruzada | Alta | Crítica | DTOs ignoram/rejeitam campo; sem `X-Tenant-Id` | lint e evento de payload proibido | body/query/header não alteram contexto | Backend / QA | 1.0A–C |
| MT-I03 (I/E) | Objetos empresariais | IDOR usando ID conhecido de B | Leitura/alteração cross-tenant | Alta | Crítica | repository com contexto e predicado composto | auditoria de misses/divergências | CRUD A×B retorna 404 por padrão | Backend / Segurança | 1.0C/E |
| MT-S04 (S/T) | Token | JWT adulterado, expirado, audiência/emissor inválido ou legado além da janela | Personificação | Média | Crítica | assinatura, `iss`, `aud`, `exp`, `jti`; janela legada curta/default-only | falhas por claim e telemetria de token legado | mutação/replay/expiração negados | Segurança | 1.0B/C |
| MT-E05 (E) | Membership | Membership revogada ou versão antiga ainda aceita | Privilégio persistente | Alta | Crítica | validar status/version; sessão/refresh revogável | alerta de uso após revogação | revogar invalida access na política e refresh | Segurança / Backend | 1.0A–C |
| MT-S06 (S/E) | Seleção de tenant | Usuário multi-membro ganha tenant não selecionado | Escopo ambíguo | Média | Alta | tenant ativo explícito no token | log de troca e membership | token de A jamais vale para B | Segurança | 1.0A–C |
| MT-S07 (S) | Sessão | Troca por parâmetro sem reautenticação/token novo | Sequestro de contexto | Alta | Crítica | endpoint autenticado emite novo token | auditoria old/new tenant sem PII | parâmetro isolado não troca tenant | Backend / QA | 1.0A–C |
| MT-E08 (E/R) | Administração global | API comum reutilizada por administrador da plataforma | Bypass amplo e não atribuível | Média | Crítica | interface/rota/role de plataforma separada | trilha imutável com motivo | tenant admin não chama plataforma; break-glass auditado | Segurança / Operação | 1.0A/C |
| MT-I09 (I) | Banco | Prisma global ou repository sem filtro | Vazamento/mutação em massa | Alta | Crítica | repository tenant-required; lint | métricas de queries sem contexto | build falha para novo repository global | Backend | 1.0A/C |
| MT-T10 (T/I) | Banco | Raw SQL sem tenant parametrizado | Scan/escrita cruzada | Alta | Crítica | wrapper explícito, parâmetro e revisão DBA | audit event por escape hatch | query sem parâmetro tenant falha lint | DBA / Backend | 1.0A/C |
| MT-T11 (T) | Integridade relacional | FK liga pai A a filho B | Corrupção silenciosa | Média | Crítica | tenantId em filhos + FK composta | reconciliação de relações | insert FK cross-tenant rejeitado | DBA | 1.0B/E |
| MT-D12 (D/T) | Unicidade | unique global colide ou confunde empresas | Bloqueio/correspondência errada | Alta | Alta | unique tenant-first onde empresarial | métricas de conflito | mesmo valor permitido A/B, duplicado negado em A | DBA / Backend | 1.0B/E |
| MT-I13 (I) | Cache | chave sem namespace retorna dado de B | Vazamento cruzado | Alta | Crítica | helper único `tenant:<id>:` | amostra de chaves e hit suspeito | mesma chave lógica A/B isolada | Backend | 1.0A/D |
| MT-D14 (D/I) | Jobs | scheduler/envelope sem tenant ou fan-out incorreto | Vazamento, starvation, dano em massa | Alta | Crítica | envelope obrigatório e fairness | métricas/run por tenant | job sem tenant rejeitado; concorrência A×B | Backend / DevOps | 1.0A/D |
| MT-D15 (D/I) | Locks | lock global serializa ou cruza operação | Indisponibilidade/interferência | Média | Alta | namespace tenant+recurso | tempo de espera por tenant | locks homônimos A/B independentes | Backend / DBA | 1.0D |
| MT-S16 (S/T) | Webhook | evento atribuído à conta/tenant errado | Mensagem e cliente contaminados | Alta | Crítica | assinatura + resolução inequívoca por conta externa; quarentena | unmatched/ambiguous account alert | conta desconhecida/ambígua não persiste | Backend / Segurança | 1.0A/D |
| MT-I17 (I/E) | Credencial ERP | credencial compartilhada entre tenants | Dados/pedidos cruzados | Alta | Crítica | vault/config/filial por tenant | auditoria de credential reference | credencial A não executa para B | Integrações / Segurança | 1.0D |
| MT-T18 (T) | Número de pedido | sequência global gera colisão ou inferência | Corrupção/enumeração | Média | Alta | sequência/idempotência tenant-scoped | conflito por tenant | concorrência A×B sem colisão | DBA / Integrações | 1.0D |
| MT-I19 (I) | IA | prompt, retrieval, cache ou histórico mistura tenants | Exposição de contexto comercial | Alta | Crítica | contexto, índice, quota e cache tenant-scoped | log sanitizado de provenance | prompt A nunca recupera fixture B | IA / Segurança | 1.0D |
| MT-S20 (S) | Communications | WhatsApp/account mapping incorreto | Conversa atribuída a empresa errada | Alta | Crítica | mapping único verificado e lifecycle | divergência provider/account | account A não abre conversa em B | Backend / Operação | 1.0D |
| MT-R21 (R/I) | Logs | tenant incorreto, ausente ou PII | Investigação falsa/exposição | Alta | Alta | logger recebe contexto imutável e sanitiza | schema validation/amostragem | log contém tenant correto sem e-mail/token | Observabilidade / LGPD | 1.0A/D |
| MT-R22 (R/I) | Métricas/auditoria | dimensão tenant ausente ou forjável | Incidente/billing não atribuível | Alta | Alta | dimensão do contexto, trilha append-only | cardinalidade/ausência alertada | eventos A/B atribuídos e não editáveis | Observabilidade | 1.0D |
| MT-I23 (I) | Export/report | agregação ou export sem predicado | Exfiltração em lote | Alta | Crítica | pipeline tenant-required e limites | volume/anomalia por tenant | export A sem linhas B | Backend / QA | 1.0C/E |
| MT-T24 (T) | Restore/backfill | linha atribuída ao tenant errado | Corrupção sistêmica | Média | Crítica | mapping assinado, hashes, contagens e quarentena | reconciliação independente | fixture órfã/ambígua bloqueia gate | DBA / QA | 1.0B/E |
| MT-E25 (E) | RLS | owner/BYPASSRLS, variável ausente ou política permissiva | Bypass da última barreira | Média | Crítica | role sem bypass; FORCE RLS; fail-closed | teste de catálogo/role e query negativa | sessão sem tenant e role bypass negadas | DBA / Segurança | 1.0E |
| MT-E26 (E/R) | Scripts admin | script sem tenant ou escape implícito | Alteração global não auditada | Alta | Crítica | interface nomeada, dry-run, motivo/aprovação | ledger do operador | script sem tenant/approval aborta | Operação / DBA | 1.0C–E |
| MT-T27 (T) | Seeds | seed cria órfãos ou segundo tenant funcional | Integridade/ativação precoce | Média | Alta | fixture sintética; default-only; FK | reconciliação de órfãos | seed órfão/tenant extra rejeitado | Backend / QA | 1.0B |
| MT-E28 (E/R/I) | Suporte | leitura silenciosa via privilégio global | Abuso e violação LGPD | Média | Crítica | break-glass just-in-time com motivo/expiração | alerta ao tenant e auditoria revisável | acesso sem motivo/expirado negado | Suporte / Segurança / LGPD | 1.0A/E |

## Abuso, resposta e aceite

Qualquer suspeita cross-tenant é incidente crítico: conter o tenant/canal, preservar auditoria, revogar sessões, interromper jobs afetados e envolver Segurança, Operação, DBA e LGPD/Jurídico. Não apagar evidência nem executar correção global. Este modelo deve ser revisto antes de 1.0B, antes de RLS e antes do piloto; risco residual só é aceito pelos papéis Accountable da RACI, nunca implicitamente pelo time de implementação.
