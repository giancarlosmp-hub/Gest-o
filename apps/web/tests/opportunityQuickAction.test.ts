import assert from "node:assert/strict";
import {
  consumeOpportunityCreateRequest,
  OPPORTUNITY_CREATE_TARGET,
} from "../src/lib/opportunityQuickAction";

assert.equal(
  OPPORTUNITY_CREATE_TARGET,
  "/oportunidades?open=create",
  "the shortcut must target the opportunities collection, not the :id detail route",
);
assert.equal(
  new URL(OPPORTUNITY_CREATE_TARGET, "https://crm.test").pathname,
  "/oportunidades",
  "the create command cannot be interpreted as an opportunity identifier",
);

const fromAnotherPage = consumeOpportunityCreateRequest(
  new URL(OPPORTUNITY_CREATE_TARGET, "https://crm.test").searchParams,
);
assert.equal(fromAnotherPage.shouldOpen, true, "navigation from another page must request the existing form");
assert.equal(fromAnotherPage.nextSearchParams.has("open"), false, "the command must be consumed once");

const afterClose = consumeOpportunityCreateRequest(fromAnotherPage.nextSearchParams);
assert.equal(afterClose.shouldOpen, false, "closing or rerendering cannot reopen the form by itself");

const reopenFromOpportunities = consumeOpportunityCreateRequest(new URLSearchParams("open=create"));
assert.equal(reopenFromOpportunities.shouldOpen, true, "the shortcut must reopen while already on Opportunities");

const withExistingFilters = consumeOpportunityCreateRequest(new URLSearchParams("actionToday=true&open=create"));
assert.equal(withExistingFilters.nextSearchParams.get("actionToday"), "true", "consuming create must preserve existing filters");

const existingDetail = consumeOpportunityCreateRequest(new URLSearchParams("openErpOrder=1"));
assert.equal(existingDetail.shouldOpen, false, "detail commands must remain untouched");
assert.equal(existingDetail.nextSearchParams.get("openErpOrder"), "1");

console.log("Opportunity quick action behavior: PASS");
