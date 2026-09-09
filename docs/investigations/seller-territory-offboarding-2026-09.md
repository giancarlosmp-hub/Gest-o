# Investigação: desligamento e transferência de territórios (2026-09)

## Causa raiz

A tela de Territórios passou a consultar apenas vendedores com `TenantMembership` ativo. O cadastro de usuário, porém, criava somente `User`; por isso um vendedor novo (como Vitor) aparecia nas consultas globais de usuários, oportunidades e dashboard, mas não nessa tela. O cadastro agora cria usuário e membership juntos. Para reparar somente os registros legados inequivocamente órfãos, a listagem completa o membership apenas quando existe exatamente um tenant ativo; em instalações multi-tenant a ambiguidade continua bloqueada.

O mesmo filtro exigia membership ativo do vendedor inativo. Como o vínculo territorial já contém `tenantId`, a origem histórica agora é localizada pelo território, mesmo sem membership ativo, e é apresentada como `Inativo — N cidades`. Destinos continuam exigindo `User.isActive`, papel vendedor e membership ativo no tenant.

A prévia KML consultava `SellerTerritoryCity` do tenant e descrevia todo vínculo externo como conflito, mas enviava à confirmação apenas `citiesToAdd`. A confirmação antiga fazia uma nova consulta global, sem `tenantId`, e bloqueava inclusive vínculos de inativos. Agora a prévia classifica `inactive_transfer` separadamente, devolve os IDs transferíveis e um hash do snapshot (tenant, destino, ID, origem e `updatedAt`). A confirmação revalida o mesmo snapshot sob lock e isolamento serializável, bloqueia conflitos ativos e move os vínculos dentro da mesma transação das novas inclusões e da auditoria.

Somente `SellerTerritoryCity.sellerId` muda. Não há atualização de oportunidades, clientes, pedidos, atividades, Timeline preexistente ou change logs; a autoria histórica do desligado permanece intacta. Uma nova Timeline é criada apenas como registro de auditoria da transferência, com origem, destino, quantidade, ator e correlação, sem e-mail ou credenciais.

## Contrato de Pedidos / UltraFV3 observado

Não foram encontrados ZIPs ou novos arquivos de Gestão/UltraFV3 no repositório. O contrato já documentado e testado permanece: `FINALIZADO` mapeia para entregue; a consulta persiste a situação operacional e o instante consultado; quantidades e datas ausentes são apresentadas como **Não informado**; autorização de solicitações é dimensão independente; e NF-e permanece **não instrumentada**. Portanto esta correção de Territórios não cria campos nem inferências de faturamento, expedição, NF-e ou solicitações.

## Limites operacionais

Nenhum dado produtivo, SQL manual, schema apply, deploy, cutover ou Recovery foi executado. A contagem “67 cidades” será exibida quando for confirmada pela consulta produtiva após o deploy. Merge só deve ser recomendado depois de todos os checks remotos do HEAD ficarem verdes.
