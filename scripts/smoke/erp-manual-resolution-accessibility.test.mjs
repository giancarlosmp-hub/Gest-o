import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const checkbox = readFileSync(resolve(root, "apps/web/src/components/AccessibleCheckbox.tsx"), "utf8");
const page = readFileSync(resolve(root, "apps/web/src/pages/OpportunityDetailsPage.tsx"), "utf8");

// Native checkbox semantics cover Tab/Space, while id/htmlFor makes both the
// 44px control and all adjacent copy activate the same input on click.
for (const contract of [
  'htmlFor={inputId}',
  'id={inputId}',
  'type="checkbox"',
  "h-11 w-11",
  "h-6 w-6",
  "border-2 border-amber-700",
  "peer-checked:bg-brand-700",
  "peer-checked:[&>svg]:opacity-100",
  "peer-focus-visible:ring-4",
  "disabled:cursor-not-allowed",
  'disabled={disabled}',
  'disabled ? "cursor-not-allowed" : "cursor-pointer"',
]) assert.ok(checkbox.includes(contract), `accessible checkbox contract missing: ${contract}`);

assert.doesNotMatch(checkbox, /role=["']checkbox/, "must use the native input instead of emulating checkbox semantics");
assert.equal((page.match(/<AccessibleCheckbox/g) ?? []).length, 3, "manual confirmations and ERP simulation must share the accessible control");
for (const id of ["manual-resolution-reviewed-", "manual-resolution-consequence-", "erp-order-simulation"])
  assert.ok(page.includes(id), `explicit checkbox association missing: ${id}`);
assert.ok(page.includes("✓ Confirmações obrigatórias concluídas."), "completion must not rely on color alone");
assert.ok(page.includes("Pendente: marque as duas confirmações obrigatórias"), "blocked state must explain the required action");

console.log("ERP manual resolution checkbox accessibility: PASS");
