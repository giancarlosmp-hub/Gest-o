import assert from "node:assert/strict";
import fs from "node:fs";

// O painel Evidências do Assistente mostra resultados, filtros e a fonte, sem texto técnico de implementação.
const page = fs.readFileSync(new URL("../src/pages/CrmAssistantPage.tsx", import.meta.url), "utf8");
assert.match(page, /Evidências<\/p>/, "painel Evidências continua na tela");
assert.match(page, /Fonte: \{messages\[0\]\.response\.source === "ai" \? "IA" : "Sistema"\}\.<\/p>/, "fonte continua visível");
assert.doesNotMatch(page, /escrita no banco|SQL livre/i, "sem a frase técnica");

console.log("CRM_ASSISTANT_EVIDENCE=PASS");
