// Timeout das chamadas às rotas de IA. A API desiste da IA em até 12 s (orçamento por fluxo em
// apps/api/src/services/ai/aiTimeBudget.ts) e responde com o fallback determinístico; a tela espera mais que isso
// para nunca desistir antes. O resto do app segue com o timeout global do apiClient.
export const AI_REQUEST_TIMEOUT_MS = 20_000;
