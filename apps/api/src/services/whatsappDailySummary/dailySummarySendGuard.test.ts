import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// WhatsApp Fase D: trava estática do envio. Nenhuma outra parte do sistema consegue mandar mensagem:
// - só o EvolutionClient conhece os endpoints de envio do Evolution (/message/...);
// - só dailySummarySender.ts chama sendTextToCrmUser;
// - destino só é emitido por resolveCrmUserRecipient, chamado só pelo resumo diário e pelas rotas dele.
const srcRoot = fileURLToPath(new URL("../../", import.meta.url));

const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/TestDb\.ts$|TestHarness\.ts$/.test(name)) files.push(path);
  }
};
walk(srcRoot);
assert(files.length > 50, "varredura encontrou o código da API");

const rel = (path: string) => relative(srcRoot, path).split(sep).join("/");
const using = (pattern: RegExp) => files.filter((path) => pattern.test(readFileSync(path, "utf8"))).map(rel).sort();

assert.deepEqual(using(/["'`]\/message\//), ["services/whatsappConnection/evolutionClient.ts"], "endpoints de envio só no EvolutionClient");
assert.deepEqual(
  using(/sendTextToCrmUser\s*\(/),
  ["services/whatsappConnection/evolutionClient.ts", "services/whatsappDailySummary/dailySummarySender.ts"],
  "sendTextToCrmUser só no cliente (definição) e no ponto único de envio"
);
const allowedResolvers = new Set([
  "services/whatsappConnection/crmUserRecipient.ts",
  "services/whatsappDailySummary/dailySummaryRunner.ts",
  "routes/whatsappDailySummaryRoutes.ts"
]);
for (const path of using(/resolveCrmUserRecipient\s*\(/)) assert(allowedResolvers.has(path), `resolveCrmUserRecipient fora do resumo diário: ${path}`);
for (const path of using(/sendDailySummaryText\s*\(/)) {
  assert(
    ["services/whatsappDailySummary/dailySummarySender.ts", "services/whatsappDailySummary/dailySummaryRunner.ts", "routes/whatsappDailySummaryRoutes.ts"].includes(path),
    `sendDailySummaryText fora do resumo diário: ${path}`
  );
}

console.log("dailySummarySendGuard.test.ts: ok");
