import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../../config/env.js";
import { logApiEvent } from "../../utils/logger.js";

// Orçamento de tempo de IA por fluxo: o servidor desiste da IA antes da tela e responde com o fallback
// determinístico (200, source deterministic). O orçamento conta do início do fluxo e vale para todas as chamadas de
// IA dele, inclusive as de serviços chamados por dentro (o Assistente Comercial chama planejamento e agenda).
// Fica abaixo do timeout de resposta da API (API_REQUEST_TIMEOUT_MS, 15 s por padrão, que responde 408) com folga
// para o banco e a montagem da resposta. A tela usa um timeout maior para as rotas de IA (apps/web/src/lib/aiRequest.ts).
export type AiFlow =
  | "crm-assistant"
  | "commercial-insights"
  | "client-suggestion"
  | "opportunity-message"
  | "assistant-whatsapp"
  | "timeline-intelligence"
  | "agenda-intelligence"
  | "commercial-planning";

export const AI_FLOW_BUDGET_MS: Record<AiFlow, number> = {
  "crm-assistant": 12_000,
  "commercial-insights": 12_000,
  "client-suggestion": 12_000,
  "opportunity-message": 12_000,
  "assistant-whatsapp": 12_000,
  "timeline-intelligence": 12_000,
  "agenda-intelligence": 12_000,
  "commercial-planning": 12_000
};
// Folga entre o fim do orçamento e o timeout de resposta da API.
export const AI_BUDGET_RESPONSE_MARGIN_MS = 3_000;
// Abaixo disso não vale começar (ou repetir) uma chamada: vai direto para o fallback.
export const AI_MIN_CALL_MS = 1_500;

export const AI_TIMEOUT_BUDGET_REASON = "ai_timeout_budget";

export type AiSource = "ai" | "deterministic";

type AiFlowStore = {
  flow: AiFlow;
  startedAt: number;
  deadline: number;
  aiCalls: number;
  aiMs: number;
  fallbackReason: string | null;
  stages: Record<string, number>;
  parent: AiFlowStore | null;
};

const storage = new AsyncLocalStorage<AiFlowStore>();

// API_REQUEST_TIMEOUT_MS 0 desliga o timeout de resposta (res.setTimeout(0)): aí vale só o orçamento do fluxo.
export const effectiveAiBudgetMs = (flow: AiFlow) =>
  env.apiRequestTimeoutMs > 0
    ? Math.max(0, Math.min(AI_FLOW_BUDGET_MS[flow], env.apiRequestTimeoutMs - AI_BUDGET_RESPONSE_MARGIN_MS))
    : AI_FLOW_BUDGET_MS[flow];

// Tempo que ainda resta para IA no fluxo atual; null fora de um fluxo (scripts e testes de unidade).
export const remainingAiBudgetMs = () => {
  const store = storage.getStore();
  return store ? store.deadline - Date.now() : null;
};

export const currentAiFlow = () => storage.getStore()?.flow ?? null;

// Chamado pelo AiService a cada chamada ao provedor e a cada desistência.
export const recordAiCall = (elapsedMs: number) => {
  for (let store = storage.getStore() ?? null; store; store = store.parent) {
    store.aiCalls += 1;
    store.aiMs += Math.max(0, Math.round(elapsedMs));
  }
};

// Motivo do fallback da última chamada sem resultado aproveitável (o primeiro motivo do fluxo é mantido).
export const recordAiFallbackReason = (reason: string) => {
  const store = storage.getStore();
  if (store && !store.fallbackReason) store.fallbackReason = reason;
};

// Mede uma etapa do fluxo (banco, Base de Conhecimento, montagem). Fora de um fluxo só executa.
export const timeAiStage = async <T>(stage: string, run: () => Promise<T>): Promise<T> => {
  const store = storage.getStore();
  if (!store) return run();
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    store.stages[stage] = (store.stages[stage] ?? 0) + Date.now() - startedAt;
  }
};

// Executa o fluxo com o orçamento e registra [AI] flow-completed só com números e rótulos (sem conteúdo).
// Fluxo dentro de outro herda o prazo do de fora, se for menor.
export const runAiFlow = async <T>(flow: AiFlow, run: () => Promise<T>, sourceOf: (result: T) => AiSource | null): Promise<T> => {
  const parent = storage.getStore() ?? null;
  const startedAt = Date.now();
  const ownDeadline = startedAt + effectiveAiBudgetMs(flow);
  const store: AiFlowStore = {
    flow,
    startedAt,
    deadline: parent ? Math.min(parent.deadline, ownDeadline) : ownDeadline,
    aiCalls: 0,
    aiMs: 0,
    fallbackReason: null,
    stages: {},
    parent
  };
  const result = await storage.run(store, run);
  const source = sourceOf(result);
  logApiEvent("INFO", "[AI] flow-completed", {
    flow,
    parentFlow: parent?.flow ?? null,
    elapsedMs: Date.now() - startedAt,
    budgetMs: store.deadline - startedAt,
    source,
    fallbackReason: source === "deterministic" ? store.fallbackReason ?? (store.aiCalls ? "ai_response_rejected" : null) : null,
    aiCalls: store.aiCalls,
    aiMs: store.aiMs,
    stagesMs: store.stages
  });
  return result;
};
