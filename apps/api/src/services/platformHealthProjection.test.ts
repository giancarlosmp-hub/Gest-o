import assert from "node:assert/strict";
import test from "node:test";
import { collectPlatformHealthHttp, projectAuditDataState, projectAutomaticEvidence, projectLockState, projectPlatformHealthRuns, projectSellerQuality, type PlatformHealthRun, type SchedulerEvidence } from "./platformHealthProjection.js";

const at = (hour: number) => new Date(`2026-08-12T${String(hour).padStart(2, "0")}:00:00.000Z`);
const run = (overrides: Partial<PlatformHealthRun> = {}): PlatformHealthRun => ({ id: "run", scope: "syncAll", trigger: "manual", status: "success", startedAt: at(10), finishedAt: at(11), durationMs: 3_600_000, syncedCount: 4_010, metrics: { synced: 4_010 }, errors: null, errorMessage: null, correlationId: "manual-correlation", ...overrides });
const scheduler = (overrides: Partial<SchedulerEvidence> = {}): SchedulerEvidence => ({ initialized: true, enabled: true, enabledByEnv: true, nextRunAt: at(13).toISOString(), status: "scheduled", lastRunAt: null, lastSuccessAt: null, ...overrides });

// 1
 test("somente syncAll manual produz pai manual, nunca automático", () => { const result=projectPlatformHealthRuns([run()]); assert.equal(result.lastManualSync?.scope,"syncAll"); assert.equal(result.lastAutomaticSync,null); assert.equal(result.successRate,1); });
// 2
 test("pai manual com 14 etapas mantém uma única execução executiva", () => { const parent=run(); const stages=Array.from({length:14},(_,i)=>run({id:`stage-${i}`,scope:`stage-${i}`,syncedCount:4_010})); const result=projectPlatformHealthRuns([parent,...stages]); assert.equal(result.parentRuns.length,1); assert.equal(result.stageRuns.length,14); assert.equal(result.lastSync?.id,parent.id); });
// 3
 test("scheduler/automatic concluída é pai automático", () => { const automatic=run({id:"automatic",scope:"automatic",trigger:"scheduler",correlationId:"auto"}); const result=projectPlatformHealthRuns([automatic]); assert.equal(result.lastAutomaticSync?.id,"automatic"); assert.equal(result.lastAutomaticSuccess?.id,"automatic"); });
// 4
 test("manual e automática permanecem separadas no mesmo período", () => { const result=projectPlatformHealthRuns([run({id:"manual",startedAt:at(12)}),run({id:"auto",scope:"automatic",trigger:"scheduler",startedAt:at(11)})]); assert.equal(result.lastManualSync?.id,"manual"); assert.equal(result.lastAutomaticSync?.id,"auto"); assert.equal(result.parentRuns.length,2); });
// 5
 test("etapas sem pai não viram evidência executiva", () => { const result=projectPlatformHealthRuns([run({scope:"products"}),run({scope:"partners"})]); assert.equal(result.dataState,"empty"); assert.equal(result.lastSync,null); assert.equal(result.successRate,null); });
// 6
 test("runs fora de ordem são projetados deterministicamente", () => { const result=projectPlatformHealthRuns([run({id:"old",startedAt:at(8)}),run({id:"new",startedAt:at(12)})]); assert.equal(result.lastSync?.id,"new"); });
// 7
 test("pai e filhos com a mesma quantidade não duplicam taxas ou quantidade", () => { const result=projectPlatformHealthRuns([run({id:"parent",syncedCount:10}),run({id:"child",scope:"products",syncedCount:10})]); assert.equal(result.parentRuns.reduce((sum,item)=>sum+item.syncedCount,0),10); assert.equal(result.successRate,1); });
// 8
 test("execução automática com erro afeta somente os pais", () => { const result=projectPlatformHealthRuns([run({scope:"automatic",trigger:"scheduler",status:"error"}),run({scope:"products",trigger:"scheduler",status:"success"})]); assert.equal(result.errorRate,1); assert.equal(result.successRate,0); assert.equal(result.lastAutomaticSuccess,null); });
// 9
 test("zero verdadeiro permanece zero quando há pai disponível", () => { const result=projectPlatformHealthRuns([run({syncedCount:0,durationMs:0})]); assert.equal(result.dataState,"available"); assert.equal(result.lastSync?.syncedCount,0); assert.equal(result.averageDurationMs,0); });
// 10
 test("ausência de evidência retorna null e empty", () => { const result=projectPlatformHealthRuns([]); assert.equal(result.dataState,"empty"); assert.equal(result.averageDurationMs,null); assert.equal(result.retries,null); });
// 11
 test("vendedor inativo é uma métrica real", () => assert.deepEqual(projectSellerQuality(3),{inactiveSeller:3,missingSeller:null}));
// 12
 test("sem vendedor é semanticamente não instrumentado no schema obrigatório", () => assert.equal(projectSellerQuality(0).missingSeller,null));
// 13
 test("scheduler disabled nunca comprova automática", () => { const result=projectAutomaticEvidence([run({scope:"automatic",trigger:"scheduler"})],scheduler({enabled:false}),[]); assert.equal(result.schedulerState,"disabled"); assert.equal(result.automaticProven,false); });
// 14
 test("scheduler enabled sem pai automático permanece não comprovado", () => { const result=projectAutomaticEvidence([run()],scheduler(),[]); assert.equal(result.schedulerState,"enabled"); assert.equal(result.automaticRunState,"not_proven"); assert.equal(result.automaticProven,false); });
// 15
 test("lock ativo bloqueia prova automática", () => { const lock={scope:"automatic",runId:"x",lockedUntil:at(14),updatedAt:at(12)}; const result=projectAutomaticEvidence([run({scope:"automatic",trigger:"scheduler"})],scheduler(),[lock],at(13)); assert.equal(result.lock.state,"active"); assert.equal(result.automaticProven,false); });
// 16
 test("lock expirado é explicitamente recuperável", () => { const result=projectLockState([{scope:"automatic",runId:"x",lockedUntil:at(12),updatedAt:at(11)}],at(13)); assert.equal(result.state,"expired_recoverable"); });
// 17
 test("ausência de lock é free", () => assert.equal(projectLockState([],at(13)).state,"free"));
// 18
 test("falha de coleta produz contrato de erro sanitizado para 503", async () => assert.deepEqual(await collectPlatformHealthHttp(async()=>{throw new Error("database secret detail")}),{status:503,body:{contractVersion:"2.0",dataState:"error",code:"PLATFORM_HEALTH_COLLECTION_FAILED",message:"Não foi possível coletar a Saúde da Plataforma."}}));
// 19
 test("auditoria vazia é empty explícito, não erro", () => { assert.equal(projectAuditDataState(0),"empty"); assert.equal(projectAuditDataState(1),"available"); });
// 20
 test("manual nunca satisfaz requisito automático", () => assert.equal(projectAutomaticEvidence([run()],scheduler(),[],at(13)).automaticProven,false));
