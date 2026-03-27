import test from "node:test";
import assert from "node:assert/strict";
import { parseActivityObservation } from "./activityObservationInsights.js";

test("detecta intenção de pedido de proposta", () => {
  const result = parseActivityObservation("Cliente pediu proposta e quer fechar ainda este mês.");

  assert.equal(result.detectedIntent, "pediu_proposta");
  assert.equal(result.interestLevel, "alto");
  assert.equal(result.sentiment, "positivo");
  assert.equal(result.suggestedFollowUpDays, 1);
  assert.match(result.suggestedNextAction, /enviar proposta/i);
});

test("detecta retorno combinado", () => {
  const result = parseActivityObservation("Combinado retornar semana que vem para continuar conversa.");

  assert.equal(result.detectedIntent, "quer_retorno");
  assert.equal(result.interestLevel, "medio");
  assert.equal(result.suggestedFollowUpDays, 7);
  assert.deepEqual(result.keywords, ["retornar semana que vem"]);
});

test("detecta negociação de preço", () => {
  const result = parseActivityObservation("Achou caro e vai avaliar preço com calma.");

  assert.equal(result.detectedIntent, "negociacao_preco");
  assert.equal(result.interestLevel, "medio");
  assert.equal(result.sentiment, "negativo");
  assert.deepEqual(result.keywords.sort(), ["achou caro", "vai avaliar preco"].sort());
});

test("detecta sem interesse", () => {
  const result = parseActivityObservation("Disse que não vai plantar este ano e está sem interesse.");

  assert.equal(result.detectedIntent, "sem_interesse");
  assert.equal(result.interestLevel, "baixo");
  assert.equal(result.sentiment, "negativo");
  assert.equal(result.suggestedFollowUpDays, null);
});

test("detecta aguardando decisão", () => {
  const result = parseActivityObservation("Vai decidir após reunião e vai falar com sócio.");

  assert.equal(result.detectedIntent, "aguardando_decisao");
  assert.equal(result.interestLevel, "medio");
  assert.equal(result.suggestedFollowUpDays, 3);
});

test("detecta visita realizada", () => {
  const result = parseActivityObservation("Visita realizada hoje, conversei com o cliente na fazenda.");

  assert.equal(result.detectedIntent, "visita_realizada");
  assert.equal(result.interestLevel, "medio");
  assert.equal(result.sentiment, "neutro");
});

test("retorna fallback seguro quando não há sinais", () => {
  const result = parseActivityObservation("Cliente comentou sobre clima e safra sem definir próximos passos.");

  assert.deepEqual(result, {
    sentiment: "neutro",
    interestLevel: "medio",
    detectedIntent: "indefinido",
    suggestedNextAction: "registrar próximo passo manualmente",
    suggestedFollowUpDays: null,
    keywords: []
  });
});
