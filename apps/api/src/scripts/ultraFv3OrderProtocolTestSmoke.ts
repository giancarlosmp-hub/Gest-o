import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const routeSource = readFileSync(new URL("../routes/crudRoutes.ts", import.meta.url), "utf8");
const serviceSource = readFileSync(new URL("../services/erpOrderService.ts", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("../services/ultraFv3Client.ts", import.meta.url), "utf8");
const loggerSource = readFileSync(new URL("../utils/logger.ts", import.meta.url), "utf8");
const envSource = readFileSync(new URL("../config/env.ts", import.meta.url), "utf8");
const composeSource = readFileSync(new URL("../../../../docker-compose.yml", import.meta.url), "utf8");
const envExampleSource = readFileSync(new URL("../../../../.env.example", import.meta.url), "utf8");

assert.match(envSource, /ultraFv3OrderProtocolTestEnabled:\s*toBoolean\(process\.env\.ULTRAFV3_ORDER_PROTOCOL_TEST_ENABLED,\s*false\)/, "feature flag deve existir e iniciar desabilitada");
assert.match(composeSource, /ULTRAFV3_ORDER_PROTOCOL_TEST_ENABLED:\s*\$\{ULTRAFV3_ORDER_PROTOCOL_TEST_ENABLED:-false\}/, "docker-compose deve repassar a feature flag ao container api");
assert.match(envExampleSource, /ULTRAFV3_ORDER_PROTOCOL_TEST_ENABLED=false/, ".env.example deve documentar a feature flag desligada");
assert.match(routeSource, /router\.post\("\/erp-orders\/protocol-test",\s*authorize\("diretor"\)/, "endpoint deve ser restrito a diretor");
assert.match(routeSource, /feature_disabled/, "endpoint deve bloquear quando a feature flag estiver desabilitada");
assert.match(routeSource, /CONFIRMAR_TESTE_ULTRAFV3/, "endpoint deve exigir confirmação explícita");
assert.match(routeSource, /numPedidoMode:\s*z\.literal\("zero"\)/, "endpoint deve exigir numPedidoMode zero");

const protocolTestSource = serviceSource.slice(serviceSource.indexOf("export async function runUltraFv3OrderProtocolTest"));
assert.match(serviceSource, /const PROTOCOL_TEST_MARKER = "protocol_test"/, "tentativa deve ser identificada como protocol_test");
assert.match(protocolTestSource, /NUM_PEDIDO:\s*"0"|submittedNumPedido:\s*"0"/, "payload controlado deve enviar NUM_PEDIDO zero");
assert.doesNotMatch(protocolTestSource, /resolveSalesmanOrderSequence/, "teste de protocolo não deve usar /salesmen para determinar NUM_PEDIDO");
assert.match(protocolTestSource, /requestWithCredentialsRaw<unknown>\("\/orders"[\s\S]*method:\s*"POST"/, "teste deve executar um único POST /orders controlado");
assert.doesNotMatch(protocolTestSource, /requestUltraFv3ReadOnlyWithCredentialsRetry/, "teste não deve usar retry automático do sync");
assert.match(protocolTestSource, /pedidoIdImportacao[\s\S]*randomUUID\(\)/, "teste deve gerar UUID próprio para PEDIDO_ID_IMPORTACAO");
assert.match(protocolTestSource, /status:\s*ErpOrderSyncStatus\.pending[\s\S]*payloadSent:\s*toJson\(payload\)/, "PEDIDO_ID_IMPORTACAO/payload devem ser persistidos antes do POST");
assert.match(protocolTestSource, /\/orderStatus\?pedido=\$\{encodeURIComponent\(query\.value\)\}/, "teste deve consultar /orderStatus por identificadores controlados");
assert.match(protocolTestSource, /erpInternalOrderId[\s\S]*displayOrderNumberCandidate:\s*null/, "PEDIDO_ID deve ser separado como ID interno e não número oficial");
assert.match(protocolTestSource, /manualVerificationRequired:\s*true/, "relatório deve exigir conferência manual");
assert.match(protocolTestSource, /status:\s*ErpOrderSyncStatus\.sent[\s\S]*OR:\s*\[/, "o teste deve bloquear oportunidades com pedido enviado/tentativa existente");

assert.match(clientSource, /requestWithCredentialsRaw/, "client deve permitir capturar status HTTP e headers seguros sem retry");
assert.match(loggerSource, /SENSITIVE_KEY_PATTERN[\s\S]*senha/, "logger deve redigir SENHA/password/token/authorization");
assert.match(loggerSource, /PERSONAL_KEY_PATTERN[\s\S]*cnpj/, "logger deve redigir CNPJ/CPF/dados pessoais");
assert.match(loggerSource, /PERSON_NAME_KEY_PATTERN/, "logger deve mascarar nomes completos");

console.log("UltraFV3 order protocol test smoke passed");
