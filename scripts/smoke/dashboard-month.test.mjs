import assert from "node:assert/strict";
import test from "node:test";
import { getDashboardMonth } from "./dashboard-month.mjs";

test("uses the São Paulo business month at the UTC month boundary", () => {
  assert.equal(getDashboardMonth(new Date("2026-08-01T02:59:59.999Z")), "2026-07");
  assert.equal(getDashboardMonth(new Date("2026-08-01T03:00:00.000Z")), "2026-08");
});
