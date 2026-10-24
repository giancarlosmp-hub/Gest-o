import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { visitQuickActionHref } from "../src/lib/mobileQuickActions";

const dateOf = (href: string) => new URLSearchParams(href.split("?")[1]).get("date");

// 22h de 23/10 em Brasília já é 24/10 em UTC: o botão "Visita" manda 23/10, senão a API recusa como data futura.
assert.equal(dateOf(visitQuickActionHref(new Date("2026-10-24T01:00:00.000Z"))), "2026-10-23");
assert.equal(dateOf(visitQuickActionHref(new Date("2026-10-24T03:00:00.000Z"))), "2026-10-24", "meia-noite em Brasília vira o dia");
assert.equal(dateOf(visitQuickActionHref(new Date("2026-10-23T12:00:00.000Z"))), "2026-10-23");
const params = new URLSearchParams(visitQuickActionHref(new Date("2026-10-24T01:00:00.000Z")).split("?")[1]);
assert.equal(params.get("open"), "create");
assert.equal(params.get("type"), "visita");

// A barra não pode voltar a montar a data em UTC nem fixá-la no carregamento do módulo.
const bar = readFileSync(new URL("../src/components/mobile/MobileActionBar.tsx", import.meta.url), "utf8");
assert.doesNotMatch(bar, /toISOString\(\)/);
assert.match(bar, /to: visitQuickActionHref,/);

console.log("mobile visit action tests passed");
