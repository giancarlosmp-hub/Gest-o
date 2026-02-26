import test from "node:test";
import assert from "node:assert/strict";
import { buildTimelineEventWhere } from "./timelineEventWhere.js";

test("mantém filtros base e opportunityId sem clientId", () => {
  const where = buildTimelineEventWhere({
    baseWhere: { ownerSellerId: "seller-1" },
    opportunityId: "opp-1"
  });

  assert.deepEqual(where, {
    ownerSellerId: "seller-1",
    opportunityId: "opp-1"
  });
});

test("inclui fallback por oportunidade quando clientId for informado", () => {
  const where = buildTimelineEventWhere({
    baseWhere: { ownerSellerId: "seller-1" },
    clientId: "client-1"
  });

  assert.deepEqual(where, {
    ownerSellerId: "seller-1",
    OR: [
      { clientId: "client-1" },
      {
        AND: [
          { clientId: null },
          { opportunity: { clientId: "client-1" } }
        ]
      }
    ]
  });
});

test("combina opportunityId com fallback de clientId", () => {
  const where = buildTimelineEventWhere({
    baseWhere: { ownerSellerId: "seller-1" },
    opportunityId: "opp-1",
    clientId: "client-1"
  });

  assert.deepEqual(where, {
    ownerSellerId: "seller-1",
    opportunityId: "opp-1",
    OR: [
      { clientId: "client-1" },
      {
        AND: [
          { clientId: null },
          { opportunity: { clientId: "client-1" } }
        ]
      }
    ]
  });
});
