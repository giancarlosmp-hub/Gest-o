# CHECKLIST — OPORTUNIDADES (60 dias)

Este guia valida o fluxo manual de oportunidades usando a fixture de **60 dias**:
- janela de **45 dias no passado** e **15 dias no futuro**;
- dados fictícios marcados com `source=fixture`;
- cobertura para pipeline, KPIs, follow-up, encerramento, filtros e integração entre telas.

## 0) Preparação

1. Popular fixture:
   ```bash
   npm run seed:fixture
   ```
2. (Opcional) Limpar fixture antes de repetir o roteiro:
   ```bash
   npm run seed:fixture:clean
   npm run seed:fixture
   ```

## A. Login por perfil

1. Entrar como **Vendedor 1**.
2. Entrar como **Vendedor 2**.
3. Entrar como **Gerente**.
4. Entrar como **Diretor**.

## B. Validar escopo

1. Vendedor vê apenas suas oportunidades.
2. Gerente vê conjunto do time.
3. Diretor vê tudo.
4. Totais do topo mudam conforme responsável.

## C. Validar pipeline

1. Colunas batem com quantidade de cards.
2. Total e ponderado por coluna batem com cards.
3. Cards do topo batem com conjunto filtrado.

> Referência da fixture por vendedor:
> - 3 em prospecção
> - 3 em negociação
> - 3 em proposta
> - 2 ganhas
> - 1 perdida

## D. Validar follow-up

1. Alterar uma data de follow-up para futura.
2. Confirmar que status muda de **“Atrasado”** para **“OK”** ou **“Vence em breve”**.
3. Confirmar que KPI de atrasadas no topo atualiza.

## E. Validar encerramento

1. Marcar uma oportunidade como ganho.
2. Confirmar:
   - sai do pipeline aberto;
   - entra em encerradas;
   - dashboard reflete ganho no período;
   - não aparece toast de erro.
3. Marcar uma como perdido.
4. Confirmar taxa de conversão/reflexos.

## F. Validar filtros

1. Buscar por título.
2. Filtrar somente atrasadas.
3. Filtrar por responsável.
4. Trocar entre abertas / encerradas / todas.

## G. Validar navegação entre telas

1. Abrir cliente a partir da oportunidade.
2. Abrir detalhes.
3. Agendar follow-up.
4. Registrar interação.
5. Ver reflexo em atividades/agenda quando aplicável.

## Critérios de aceite

- Fixture sobe sem quebrar compose.
- Dados aparecem para todos os perfis corretamente.
- Checklist manual permite validar o fluxo inteiro.
- Script de limpeza remove somente fixture.

## Observações da fixture

- A fixture cria dados para cada vendedor ativo com:
  - 12 clientes;
  - 12 oportunidades (distribuição fixa por etapa);
  - valores entre R$ 15.000 e R$ 80.000;
  - probabilidade coerente por etapa;
  - datas coerentes para proposal/follow-up/expected close/closedAt;
  - parte das oportunidades em atraso, parte vencendo em breve e parte OK;
  - atividades e agenda relacionadas a oportunidades.
- Os registros criados pela fixture usam marcação textual com `source=fixture` para limpeza seletiva.
